/** The Wallets drawer: a list of your wallets, and one wallet's details. */
import { h, clear, copyText } from '../../ui/dom';
import { icon, shapeGlyph } from '../../ui/icons';
import { identicon } from '../../ui/inspector';
import { describe, type ParsedTx, type Seg } from '../../xrpl/parse';
import { fmtNum, fmtDateTime, shortAddr, timeAgo, type Amt } from '../../xrpl/amount';
import { F, has } from '../../xrpl/flags';
import type { AccountData, TrustLine } from '../../xrpl/loader';
import type { Ctx } from '../index';
import { NETWORKS, NETWORK_IDS, explorerUrl, type NetworkId } from '../networks';
import { encodeCurrency } from '../ledger';
import { generateKeys, normalizeAddress, secretNumberGroups } from '../keys';
import { nextNames } from '../store';
import { isUnlocked, lock } from '../vault';
import type { Secrets, StoredWallet } from '../types';
import { checkbox, datalist, downloadJson, errText, field, input, netPill, note, popMenu, secretBox, seg, withBusy } from './kit';
import { changePasswordDialog, promptUnlock } from './vaultui';
import { openAdd } from './add';
import { openSend } from './send';
import { runTx } from './tx';
import { findLegacy, importLegacy } from '../importer';

export type Tab = 'activity' | 'tokens' | 'keys' | 'settings';
type Filter = 'all' | NetworkId;
type Snippet = 'js' | 'py' | 'env' | 'api';

const TABS: [Tab, string][] = [
  ['activity', 'Activity'],
  ['tokens', 'Tokens'],
  ['keys', 'Keys'],
  ['settings', 'Settings'],
];

const TF_SET_NO_RIPPLE = 0x00020000;
const TF_CLEAR_NO_RIPPLE = 0x00040000;
const ASF_REQUIRE_DEST = 1;
const ASF_DEFAULT_RIPPLE = 8;

const SECRET_LABEL: Record<string, string> = { seed: 'Family seed', mnemonic: 'Recovery phrase', secretNumbers: 'Secret numbers', none: 'None' };

const fmtXrpFull = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 6 });

export class WalletDrawer {
  readonly el: HTMLElement;
  isOpen = false;
  onToggle?: () => void;
  /** Whether your last click or tap was inside the drawer (Esc then closes it rather than the map's panels). */
  lastInside = false;

  private id: string | null = null;
  private tab: Tab = 'activity';
  private filter: Filter = 'all';
  private readonly search: HTMLInputElement;
  private listEl: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private viewKey = '';
  private stale = false;
  private pending = false;
  private pressing = false;
  private lastRender = 0;
  private actShown = 30;
  private lineForm = false;
  private snippet: Snippet = 'js';
  /** Mainnet secrets shown in the Keys tab (memory only; cleared on lock or navigation). */
  private shown: Secrets | null = null;
  private loading = new Set<string>();
  private missing = new Set<string>();
  private failed = new Map<string, string>();
  private legacy: number | null | undefined;

  constructor(private ctx: Ctx) {
    this.el = h('aside', { class: 'wallets panel', 'aria-label': 'Your wallets' });
    this.search = h('input', { type: 'search', class: 'w-input w-search', placeholder: 'Find by name, group or address', 'aria-label': 'Find a wallet', autocomplete: 'off', spellcheck: 'false' });
    this.search.addEventListener('input', () => this.renderList());
    this.search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = this.listEl?.querySelector<HTMLElement>('.w-row');
      first?.click();
    });
    // Re-renders held back while you were typing or clicking.
    this.el.addEventListener('focusout', () => setTimeout(() => this.stale && this.render()));
    this.el.addEventListener('pointerdown', () => (this.pressing = true));
    document.addEventListener('pointerdown', (e) => (this.lastInside = this.el.contains(e.target as Node)), true);
    window.addEventListener('pointerup', () => {
      if (!this.pressing) return;
      this.pressing = false;
      if (this.stale) setTimeout(() => this.render());
    });
    ctx.store.onChange(() => {
      this.checkBalances();
      this.refresh();
    });
    ctx.ledger.onChange(() => this.refresh());
    ctx.app.on('panel', (p) => p !== 'wallets' && this.isOpen && this.hide());
    window.addEventListener('resize', () => this.updateInset());
  }

  /* ------------------------------ open/close ----------------------------- */

  toggle() {
    if (this.isOpen) this.hide();
    else this.show();
  }

  show(id?: string | null, tab?: Tab) {
    if (id !== undefined && id !== this.id) {
      this.id = id;
      this.actShown = 30;
      this.lineForm = false;
      this.shown = null;
      if (!tab) this.tab = 'activity';
    }
    if (tab) this.tab = tab;
    if (!this.isOpen) {
      this.isOpen = true;
      this.el.classList.add('open');
      this.ctx.app.emit('panel', 'wallets');
      this.checkBalances();
    }
    this.render(true);
    this.updateInset();
    this.onToggle?.();
  }

  hide() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('open');
    this.shown = null;
    this.updateInset();
    this.onToggle?.();
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  /** Re-render soon; at most a couple of times a second, however busy the ledger is. */
  refresh() {
    if (!isUnlocked()) this.shown = null;
    if (this.pending) return;
    this.pending = true;
    setTimeout(
      () =>
        requestAnimationFrame(() => {
          this.pending = false;
          this.render();
        }),
      Math.max(0, 400 - (performance.now() - this.lastRender)),
    );
  }

  private updateInset() {
    const v = this.ctx.app.view;
    v.insetLeft = this.isOpen && window.innerWidth > 760 ? this.el.offsetWidth + 24 : 0;
  }

  /** Balances for the list (cheap, background priority). */
  private checkBalances() {
    if (!this.isOpen) return;
    for (const w of this.ctx.store.wallets) {
      if (this.ctx.ledger.cached(w.networkId, w.address) === undefined) void this.ctx.ledger.accountInfo(w.networkId, w.address).catch(() => {});
    }
  }

  /* -------------------------------- render ------------------------------- */

  private formFocused(): boolean {
    const a = document.activeElement as HTMLElement | null;
    return !!a && this.el.contains(a) && a.matches('input, textarea, select');
  }

  private render(force = false) {
    if (!this.isOpen) return;
    if (!force && (this.formFocused() || this.pressing)) {
      this.stale = true;
      return;
    }
    this.stale = false;
    this.lastRender = performance.now();
    const w = this.ctx.store.get(this.id);
    if (this.id && !w) this.id = null;
    const key = w ? `${w.id}:${this.tab}` : 'list';
    const scroll = key === this.viewKey ? (this.body?.scrollTop ?? 0) : 0;
    this.viewKey = key;
    clear(this.el);
    if (w) this.renderDetail(w);
    else this.renderHome();
    if (this.body) this.body.scrollTop = scroll;
  }

  private closeBtn() {
    return h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close wallets', onclick: () => this.hide() }, icon('x', 16));
  }

  /* --------------------------------- list -------------------------------- */

  private renderHome() {
    const { store } = this.ctx;
    const more = h('button', { class: 'icon-btn', title: 'More', 'aria-label': 'More wallet actions' }, icon('more', 16));
    more.onclick = () =>
      popMenu(more, [
        { icon: 'plus', label: 'Add or import a wallet', run: () => openAdd(this.ctx) },
        { icon: 'upload', label: 'Restore from a backup', run: () => openAdd(this.ctx, { mode: 'restore' }) },
        { icon: 'download', label: 'Download a backup', run: () => this.backup() },
        store.vault ? 'sep' : null,
        store.vault && isUnlocked() ? { icon: 'lock', label: 'Lock mainnet keys', run: () => lock() } : null,
        store.vault ? { icon: 'key', label: 'Change vault password', run: () => changePasswordDialog(store, (t) => this.ctx.toast(t)) } : null,
        'sep',
        { icon: 'info', label: 'Where are wallets saved?', run: () => this.ctx.toast(`Saved to ${store.path}`) },
      ]);

    const head = h(
      'div',
      { class: 'w-head' },
      h('h2', null, 'Wallets'),
      this.vaultChip(),
      h('div', { class: 'grow' }),
      store.wallets.length ? h('button', { class: 'btn primary small', onclick: () => openAdd(this.ctx) }, icon('plus', 14), 'Add') : null,
      more,
      this.closeBtn(),
    );

    const counts = new Map<NetworkId, number>();
    for (const w of store.wallets) counts.set(w.networkId, (counts.get(w.networkId) ?? 0) + 1);
    if (this.filter !== 'all' && !counts.get(this.filter)) this.filter = 'all';
    const chips =
      counts.size > 1
        ? h(
            'div',
            { class: 'w-chips', role: 'tablist', 'aria-label': 'Network' },
            ...(['all', ...NETWORK_IDS.filter((n) => counts.get(n))] as Filter[]).map((f) =>
              h(
                'button',
                {
                  class: `w-chip${this.filter === f ? ' on' : ''}${f !== 'all' ? ` ${f}` : ''}`,
                  role: 'tab',
                  'aria-selected': String(this.filter === f),
                  onclick: () => {
                    this.filter = f;
                    this.render(true);
                  },
                },
                f === 'all' ? 'All' : NETWORKS[f].name,
                h('span', { class: 'w-chip-n' }, String(f === 'all' ? store.wallets.length : counts.get(f))),
              ),
            ),
          )
        : null;

    this.listEl = h('div', { class: 'w-list' });
    this.body = h('div', { class: 'w-body' }, this.listEl);
    const tools = store.wallets.length > 3 || chips ? h('div', { class: 'w-tools' }, store.wallets.length > 3 ? this.search : null, chips) : null;
    this.el.append(head, ...(tools ? [tools] : []), this.body);
    this.renderList();
  }

  private vaultChip(): HTMLElement | null {
    const { store } = this.ctx;
    if (!store.vault) return null;
    const open = isUnlocked();
    return h(
      'button',
      {
        class: `w-vault${open ? ' open' : ''}`,
        title: open ? 'Mainnet keys are unlocked. Click to lock them now.' : 'Mainnet keys are locked (encrypted). Click to unlock.',
        onclick: () => (open ? lock() : void promptUnlock(store)),
      },
      icon(open ? 'unlock' : 'lock', 13),
      open ? 'Unlocked' : 'Locked',
    );
  }

  private renderList() {
    const el = this.listEl;
    if (!el) return;
    clear(el);
    const { store } = this.ctx;
    if (!store.wallets.length) {
      el.append(this.empty());
      return;
    }
    const q = store.wallets.length > 3 ? this.search.value.trim().toLowerCase() : '';
    const list = store.wallets.filter(
      (w) =>
        (this.filter === 'all' || w.networkId === this.filter) &&
        (!q || w.label.toLowerCase().includes(q) || w.address.toLowerCase().includes(q) || (w.group ?? '').toLowerCase().includes(q) || (w.notes ?? '').toLowerCase().includes(q)),
    );
    if (!list.length) {
      el.append(h('p', { class: 'w-none' }, 'No wallets match.'));
      return;
    }
    const groups = new Map<string, StoredWallet[]>();
    for (const w of list) {
      const g = w.group?.trim() || '';
      (groups.get(g) ?? groups.set(g, []).get(g)!).push(w);
    }
    const names = [...groups.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    const order = (w: StoredWallet) => NETWORK_IDS.indexOf(w.networkId);
    for (const g of names) {
      const ws = groups.get(g)!.sort((a, b) => order(a) - order(b) || a.createdAt.localeCompare(b.createdAt));
      if (names.length > 1 || g) el.append(h('div', { class: 'w-group' }, g || 'No group', h('span', null, String(ws.length))));
      for (const w of ws) el.append(this.row(w));
    }
  }

  private row(w: StoredWallet): HTMLElement {
    const { ledger } = this.ctx;
    const info = ledger.cached(w.networkId, w.address);
    const funding = this.ctx.funding.has(w.id);
    const bal = funding
      ? h('span', { class: 'w-dim' }, 'Funding…', h('span', { class: 'spinner' }))
      : info === undefined
        ? h('span', { class: 'w-dim' }, '…')
        : info === null
          ? h('span', { class: 'w-dim', title: 'This address has no account on the ledger yet' }, 'Not activated')
          : h('span', { title: `${fmtXrpFull(info.balance)} XRP` }, fmtNum(info.balance), h('small', null, ' XRP'));
    const stop = (e: Event) => e.stopPropagation();
    const tools = h(
      'div',
      { class: 'w-row-tools' },
      h(
        'button',
        {
          class: 'icon-btn small',
          title: 'Copy address',
          'aria-label': `Copy ${w.label}’s address`,
          onclick: async (e: Event) => {
            stop(e);
            if (await copyText(w.address)) this.ctx.toast(`${w.label}’s address copied`);
          },
        },
        icon('copy', 13),
      ),
      w.seed && !NETWORKS[w.networkId].real
        ? h(
            'button',
            {
              class: 'icon-btn small',
              title: 'Copy seed',
              'aria-label': `Copy ${w.label}’s seed`,
              onclick: async (e: Event) => {
                stop(e);
                if (await copyText(w.seed!)) this.ctx.toast(`${w.label}’s seed copied`);
              },
            },
            icon('key', 13),
          )
        : null,
    );
    return h(
      'div',
      {
        class: 'w-row',
        role: 'button',
        tabindex: '0',
        title: `${w.label} · ${w.address}`,
        onclick: () => this.show(w.id),
        onkeydown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), this.show(w.id)),
      },
      h('span', { class: 'w-av' }, identicon(w.address, 22)),
      h(
        'div',
        { class: 'w-row-main' },
        h('div', { class: 'w-row-title' }, h('span', { class: 'w-name' }, w.label), netPill(w.networkId), w.watchOnly ? h('span', { class: 'tag' }, 'watch') : null),
        h('div', { class: 'w-row-sub' }, shortAddr(w.address)),
      ),
      h('div', { class: 'w-row-bal' }, bal),
      tools,
    );
  }

  private empty(): HTMLElement {
    const { store } = this.ctx;
    if (this.legacy === undefined) {
      this.legacy = null;
      void findLegacy().then((n) => {
        this.legacy = n;
        if (n) this.refresh();
      });
    }
    const quick = h('button', { class: 'btn primary' }, icon('droplet', 14), 'Create a funded Testnet wallet');
    quick.onclick = () => void withBusy(quick, 'Creating…', () => this.quickCreate());
    const legacyBtn = this.legacy
      ? h(
          'button',
          {
            class: 'btn',
            onclick: async (e: Event) => {
              const b = e.currentTarget as HTMLButtonElement;
              await withBusy(b, 'Importing…', async () => {
                try {
                  const r = await importLegacy(this.ctx);
                  this.ctx.toast(`Imported ${r.added} wallet${r.added === 1 ? '' : 's'} from XRPL Wallet Manager`);
                } catch (err) {
                  this.ctx.toast(errText(err), 'error');
                }
              });
            },
          },
          icon('download', 14),
          `Import ${this.legacy} wallet${this.legacy === 1 ? '' : 's'} from XRPL Wallet Manager`,
        )
      : null;
    return h(
      'div',
      { class: 'w-empty' },
      h('div', { class: 'w-empty-ico' }, icon('wallet', 22)),
      h('h3', null, 'Your wallets, next to the map'),
      h('p', null, 'Make funded Testnet wallets in one click, bring in the ones you already use, and check balances, history and trust lines while you test.'),
      h('div', { class: 'w-empty-actions' }, quick, legacyBtn, h('button', { class: 'btn', onclick: () => openAdd(this.ctx) }, icon('plus', 14), 'Add or import…')),
      h('p', { class: 'w-empty-foot' }, icon('lock', 12), `Saved on this computer (${store.path.split('/').slice(-2).join('/')}). Mainnet keys are encrypted with a password.`),
    );
  }

  private async quickCreate() {
    const { store } = this.ctx;
    const [label] = nextNames(store, 'testnet', 1);
    const [w] = await this.ctx.build('testnet', [{ label, keys: generateKeys('seed', 'ed25519') }]);
    try {
      await store.mutate((d) => void d.wallets.push(w));
    } catch (e) {
      this.ctx.toast(errText(e), 'error');
      return;
    }
    this.show(w.id);
    void this.ctx.fund(w);
  }

  private backup() {
    const { store } = this.ctx;
    downloadJson(`graphxrp-wallets-${new Date().toISOString().slice(0, 10)}.json`, store.data);
    this.ctx.toast(store.vault ? 'Backup downloaded. Test keys are readable in it; mainnet keys stay encrypted.' : 'Backup downloaded. It contains readable test-network keys.');
  }

  /* -------------------------------- detail ------------------------------- */

  private load(w: StoredWallet, force = false) {
    const key = `${w.networkId}:${w.address}`;
    if (this.loading.has(key)) return;
    this.loading.add(key);
    this.failed.delete(key);
    this.ctx.ledger
      .account(w.networkId, w.address, force)
      .then((d) => (d ? this.missing.delete(key) : this.missing.add(key)))
      .catch((e) => this.failed.set(key, errText(e)))
      .finally(() => {
        this.loading.delete(key);
        this.refresh();
      });
  }

  private renderDetail(w: StoredWallet) {
    const { ledger } = this.ctx;
    const net = w.networkId;
    const key = `${net}:${w.address}`;
    const d = ledger.session(net).loader.loaded.get(w.address);
    const info = ledger.cached(net, w.address);
    if (info === undefined) void ledger.accountInfo(net, w.address).catch(() => {});
    if (this.missing.has(key) && info?.exists) this.missing.delete(key);
    if (!d && !this.missing.has(key) && !this.failed.has(key)) this.load(w);

    const more = h('button', { class: 'icon-btn', title: 'More', 'aria-label': 'More actions for this wallet' }, icon('more', 16));
    more.onclick = () =>
      popMenu(more, [
        { icon: 'copy', label: 'Copy address', run: async () => (await copyText(w.address)) && this.ctx.toast('Address copied') },
        w.seed && !NETWORKS[net].real ? { icon: 'key', label: 'Copy seed', run: async () => (await copyText(w.seed!)) && this.ctx.toast('Seed copied') } : null,
        { icon: 'external', label: `Open in ${NETWORKS[net].name} explorer`, run: () => window.open(explorerUrl(net, 'account', w.address), '_blank', 'noopener') },
        net === 'mainnet' ? { icon: 'network', label: 'Show on the map', run: () => void this.ctx.app.explore(w.address) } : null,
        'sep',
        { icon: 'trash', label: 'Remove from GraphXRP…', run: () => void this.remove(w), danger: true },
      ]);
    const refreshBtn = h('button', { class: 'icon-btn', title: 'Refresh from the ledger', 'aria-label': 'Refresh' }, icon('refresh', 15));
    refreshBtn.onclick = () => {
      refreshBtn.classList.add('spin');
      void ledger.accountInfo(net, w.address, true).catch(() => {});
      this.missing.delete(key);
      this.failed.delete(key);
      this.load(w, true);
      setTimeout(() => refreshBtn.classList.remove('spin'), 800);
    };

    const head = h(
      'div',
      { class: 'w-head' },
      h('button', { class: 'w-back', onclick: () => this.show(null), title: 'All wallets' }, icon('left', 15), 'Wallets'),
      h('div', { class: 'grow' }),
      refreshBtn,
      more,
      this.closeBtn(),
    );
    const activated = info ? true : info === null || this.missing.has(key) ? false : d ? d.exists : undefined;
    this.body = h(
      'div',
      { class: 'w-body' },
      this.hero(w, d, activated),
      h(
        'nav',
        { class: 'w-tabs', role: 'tablist' },
        ...TABS.map(([t, label]) =>
          h(
            'button',
            {
              class: `w-tab${t === this.tab ? ' on' : ''}`,
              role: 'tab',
              'aria-selected': String(t === this.tab),
              onclick: () => {
                this.tab = t;
                this.render(true);
              },
            },
            label,
          ),
        ),
      ),
      h('div', { class: 'w-panel', role: 'tabpanel' }, this.panel(w, d, activated)),
    );
    this.el.append(head, this.body);
  }

  private hero(w: StoredWallet, d: AccountData | undefined, activated: boolean | undefined): HTMLElement {
    const { ledger, app } = this.ctx;
    const net = w.networkId;
    const info = ledger.cached(net, w.address);
    const balance = info?.balance ?? d?.balance ?? 0;
    const owners = info?.ownerCount ?? d?.ownerCount ?? 0;
    const r = ledger.reserve(net);
    const reserved = r.base + owners * r.inc;
    const test = !NETWORKS[net].real;
    const funding = this.ctx.funding.has(w.id);

    const copy = h('button', { class: 'icon-btn', title: 'Copy address', 'aria-label': 'Copy address' }, icon('copy', 14));
    copy.onclick = async () => (await copyText(w.address)) && this.ctx.toast('Address copied');

    const bal =
      activated === undefined
        ? h('div', { class: 'w-bal' }, h('div', { class: 'skeleton' }, h('div', { class: 'sk-line', style: { width: '45%', height: '22px' } })))
        : !activated
          ? h(
              'div',
              { class: 'w-bal' },
              h('div', { class: 'w-bal-num dim' }, 'Not activated'),
              h('div', { class: 'w-bal-sub' }, test ? 'Fund it from the faucet to bring it to life.' : `Send it at least ${r.base} XRP from another wallet to activate it.`),
            )
          : h(
              'div',
              { class: 'w-bal' },
              h('div', { class: 'w-bal-num' }, fmtXrpFull(balance), h('span', { class: 'w-bal-cur' }, 'XRP')),
              h('div', { class: 'w-bal-sub', title: `Every account keeps ${r.base} XRP plus ${r.inc} XRP per object it owns (trust lines, offers…) locked as a reserve.` }, `${fmtNum(reserved)} XRP reserved · ${fmtNum(Math.max(0, balance - reserved))} available`),
            );

    const fundBtn = test
      ? h('button', { class: `btn small${activated === false ? ' primary' : ''}`, disabled: funding, onclick: () => void this.ctx.fund(w), title: `Get free test XRP from the ${NETWORKS[net].name} faucet` }, funding ? h('span', { class: 'spinner', style: { marginLeft: '0' } }) : icon('droplet', 14), funding ? 'Funding…' : 'Fund')
      : null;
    const sendBtn = !w.watchOnly ? h('button', { class: 'btn small primary', disabled: !activated, onclick: () => openSend(this.ctx, w) }, icon('send', 14), 'Send') : null;
    if (sendBtn && activated === false && fundBtn) sendBtn.classList.remove('primary');

    return h(
      'section',
      { class: 'w-hero' },
      h(
        'div',
        { class: 'w-hero-top' },
        h('span', { class: 'w-av big' }, identicon(w.address, 34)),
        h('div', { class: 'w-hero-title' }, h('h2', null, w.label), h('div', { class: 'w-pills' }, netPill(net), w.group ? h('span', { class: 'tag' }, w.group) : null, w.watchOnly ? h('span', { class: 'tag' }, 'Watch-only') : null)),
      ),
      h('div', { class: 'addr-row' }, h('code', { class: 'addr', title: 'The wallet’s public address' }, w.address), copy),
      bal,
      h(
        'div',
        { class: 'w-actions' },
        fundBtn,
        sendBtn,
        net === 'mainnet' ? h('button', { class: 'btn small', onclick: () => void app.explore(w.address), title: 'Open this account on the map' }, icon('network', 14), 'Show on map') : null,
        h('a', { class: 'icon-btn', href: explorerUrl(net, 'account', w.address), target: '_blank', rel: 'noopener', title: `Open in the ${NETWORKS[net].name} explorer`, 'aria-label': 'Open in explorer' }, icon('external', 15)),
      ),
      w.notes ? h('p', { class: 'user-note' }, icon('tag', 13), w.notes) : null,
    );
  }

  private panel(w: StoredWallet, d: AccountData | undefined, activated: boolean | undefined): HTMLElement {
    switch (this.tab) {
      case 'tokens':
        return this.tokens(w, d, activated);
      case 'keys':
        return this.keys(w);
      case 'settings':
        return this.settings(w, d, activated);
      default:
        return this.activity(w, d, activated);
    }
  }

  private loadingState(w: StoredWallet, lines = 4): HTMLElement {
    const key = `${w.networkId}:${w.address}`;
    const err = this.failed.get(key);
    if (err) {
      return note('error', [
        `Couldn’t load from ${NETWORKS[w.networkId].name}: ${err} `,
        h('button', { class: 'link', onclick: () => (this.failed.delete(key), this.load(w, true), this.refresh()) }, 'Try again'),
      ]);
    }
    return h('div', { class: 'skeleton' }, ...Array.from({ length: lines }, (_, i) => h('div', { class: 'sk-line', style: { width: `${90 - i * 15}%` } })));
  }

  /* ------------------------------- activity ------------------------------ */

  private activity(w: StoredWallet, d: AccountData | undefined, activated: boolean | undefined): HTMLElement {
    if (activated === false) return h('p', { class: 'w-none' }, 'No activity yet. Once this address is funded, its transactions show up here, live.');
    if (!d) return this.loadingState(w);
    if (!d.txs.length) return h('p', { class: 'w-none' }, 'No transactions yet.');
    const rows = d.txs.slice(0, this.actShown).map((t) => this.txRow(w, t));
    const moreLoaded = d.txs.length - this.actShown;
    const older = h('button', { class: 'btn small' }, icon('history', 13), 'Load older');
    older.onclick = () =>
      void withBusy(older, 'Loading…', async () => {
        this.actShown += 50;
        await this.ctx.ledger.session(w.networkId).loader.moreTx(d).catch((e) => this.ctx.toast(errText(e), 'error'));
        this.refresh();
      });
    return h(
      'div',
      null,
      h('ul', { class: 'acts' }, ...rows),
      h(
        'div',
        { class: 'row' },
        moreLoaded > 0 ? h('button', { class: 'btn small', onclick: () => ((this.actShown += 50), this.render(true)) }, `Show ${Math.min(50, moreLoaded)} more`) : null,
        moreLoaded <= 0 && !d.txDone ? older : null,
      ),
    );
  }

  private txRow(w: StoredWallet, t: ParsedTx): HTMLElement {
    const ds = describe(t, w.address);
    return h(
      'li',
      { class: `act ${ds.dir}${t.success ? '' : ' failed'}` },
      h('span', { class: 'act-ico', title: t.type }, icon(ds.icon, 14)),
      h(
        'div',
        { class: 'act-main' },
        h('div', { class: 'act-text' }, ...this.segs(w.networkId, ds.segs, w.address)),
        h(
          'div',
          { class: 'act-meta' },
          h('time', { datetime: new Date(t.date).toISOString(), title: fmtDateTime(t.date) }, timeAgo(t.date)),
          ' · ',
          t.type,
          ' · ',
          h('a', { href: explorerUrl(w.networkId, 'tx', t.hash), target: '_blank', rel: 'noopener', title: 'Open the transaction in the explorer' }, 'details', icon('external', 10)),
        ),
      ),
    );
  }

  private segs(net: NetworkId, segs: Seg[], me: string): (HTMLElement | string)[] {
    return segs.map((s) => {
      if (typeof s === 'string') return s;
      if ('a' in s) return this.chip(net, s.a, me);
      if ('amt' in s) return this.amt(net, s.amt);
      if ('badge' in s) return h('span', { class: 'badge', title: s.tip }, s.badge);
      return h('span', { class: 'dtag', title: 'Destination tag' }, `tag ${s.tag}`);
    });
  }

  private chip(net: NetworkId, addr: string, me?: string): HTMLElement {
    if (me && addr === me) return h('strong', { class: 'self' }, 'this wallet');
    const { store, app } = this.ctx;
    const mine = store.find(addr, net);
    const real = net === 'mainnet';
    const named = !!mine || (real && !!app.dir.get(addr).name);
    const hint = mine ? 'Open this wallet' : real ? 'Show on the map' : `Open in the ${NETWORKS[net].name} explorer`;
    return h(
      'button',
      {
        class: `chip-acct${named ? ' named' : ''}${mine ? ' mine' : ''}`,
        title: `${addr}\n${hint}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          if (mine) this.show(mine.id);
          else if (real) void app.explore(addr);
          else window.open(explorerUrl(net, 'account', addr), '_blank', 'noopener');
        },
      },
      mine ? icon('wallet', 11) : shapeGlyph(real ? app.classify(addr) : 'wallet', 11),
      h('span', null, this.ctx.name(net, addr)),
    );
  }

  private amt(net: NetworkId, a: Amt): HTMLElement {
    const title = a.isXrp ? (NETWORKS[net].real ? 'XRP' : `Test XRP (${NETWORKS[net].name}, no real value)`) : a.issuer ? `${a.currency} issued by ${this.ctx.name(net, a.issuer)} (${a.issuer})` : a.currency;
    return h('span', { class: `amt${a.isXrp ? ' xrp' : ''}`, title }, `${fmtNum(a.value)} ${a.currency}`);
  }

  /* -------------------------------- tokens ------------------------------- */

  private tokens(w: StoredWallet, d: AccountData | undefined, activated: boolean | undefined): HTMLElement {
    const net = w.networkId;
    if (activated === false) return h('p', { class: 'w-none' }, 'This address isn’t activated yet. Fund it first, then add trust lines to hold tokens.');
    if (!d) return this.loadingState(w, 3);
    const signer = !w.watchOnly;
    const held = d.lines.filter((l) => l.balance > 0 || (l.balance === 0 && l.limit > 0));
    const issued = new Map<string, { code: string; currency: string; total: number; holders: number }>();
    for (const l of d.lines) {
      if (l.balance >= 0) continue;
      const g = issued.get(l.code) ?? { code: l.code, currency: l.currency, total: 0, holders: 0 };
      g.total += -l.balance;
      g.holders++;
      issued.set(l.code, g);
    }

    const rows = held.map((l) => {
      const more = signer ? h('button', { class: 'icon-btn small', title: 'Actions', 'aria-label': `Actions for ${l.currency}` }, icon('more', 14)) : null;
      if (more) {
        more.onclick = () =>
          popMenu(more, [
            l.balance > 0 ? { icon: 'send', label: `Send ${l.currency}`, run: () => openSend(this.ctx, w, { code: l.code, issuer: l.peer }) } : null,
            { icon: 'copy', label: 'Copy issuer address', run: async () => (await copyText(l.peer)) && this.ctx.toast('Issuer address copied') },
            l.balance === 0 ? 'sep' : null,
            l.balance === 0 ? { icon: 'trash', label: 'Remove trust line', danger: true, run: () => void this.removeLine(w, d, l) } : null,
          ]);
      }
      return h(
        'li',
        { class: 'w-tok' },
        h('div', { class: 'w-tok-main' }, h('div', { class: 'w-tok-cur' }, l.currency), h('div', { class: 'w-tok-iss' }, 'from ', this.chip(net, l.peer))),
        h('div', { class: 'w-tok-bal' }, h('div', null, fmtNum(l.balance)), h('div', { class: 'w-tok-lim' }, `limit ${fmtNum(l.limit)}`)),
        more,
      );
    });

    const addBtn = signer && !this.lineForm ? h('button', { class: 'btn small', onclick: () => ((this.lineForm = true), this.render(true)) }, icon('plus', 13), 'Add trust line') : null;
    const out = h(
      'div',
      null,
      h('div', { class: 'w-sec-head' }, h('h3', null, 'Holding'), addBtn),
      this.lineForm ? this.lineFormEl(w) : null,
      rows.length
        ? h('ul', { class: 'w-toks' }, ...rows)
        : h(
            'p',
            { class: 'w-none' },
            'No tokens yet. To hold one, add a trust line to its issuer (that’s how you opt in on the XRP Ledger).',
            signer ? ' To test your own token, have another wallet add a trust line to this one, then use Send → “Issue a token”.' : '',
          ),
      d.linesMore ? h('p', { class: 'muted small' }, 'Showing the first 200 trust lines.') : null,
    );
    if (issued.size) {
      out.append(
        h('div', { class: 'w-sec-head' }, h('h3', null, 'Issued by this wallet')),
        h(
          'ul',
          { class: 'w-toks' },
          ...[...issued.values()].map((g) =>
            h(
              'li',
              { class: 'w-tok' },
              h('div', { class: 'w-tok-main' }, h('div', { class: 'w-tok-cur' }, g.currency), h('div', { class: 'w-tok-iss' }, `${g.holders} holder${g.holders === 1 ? '' : 's'}${d.linesMore ? ' (first 200 lines)' : ''}`)),
              h('div', { class: 'w-tok-bal' }, h('div', null, fmtNum(g.total)), h('div', { class: 'w-tok-lim' }, 'in circulation')),
              signer ? h('button', { class: 'icon-btn small', title: `Send ${g.currency} to someone`, 'aria-label': `Issue ${g.currency}`, onclick: () => openSend(this.ctx, w, { code: g.code, issuer: w.address }) }, icon('send', 13)) : null,
            ),
          ),
        ),
      );
    }
    return out;
  }

  private lineFormEl(w: StoredWallet): HTMLElement {
    const { store } = this.ctx;
    const others = store.onNetwork(w.networkId).filter((x) => x.id !== w.id);
    const listId = `w-issuers-${w.id}`;
    const cur = input({ placeholder: 'USD, RLUSD, SOLO…', maxlength: '40' });
    const iss = input({ placeholder: 'Issuer address (r…) or one of your wallets', list: listId });
    const lim = input({ value: '1000000000', inputmode: 'decimal' });
    const msg = h('div');
    const go = h('button', { class: 'btn primary small', type: 'submit' }, 'Add trust line');
    const form = h(
      'form',
      { class: 'w-form w-inline-form' },
      field('Currency', cur),
      field('Issuer', iss),
      datalist(listId, others.map((x) => ({ value: x.label, label: x.address }))),
      field('Limit', lim, 'The most of this token you’re willing to hold.'),
      msg,
      h('div', { class: 'row' }, go, h('button', { class: 'btn small', type: 'button', onclick: () => ((this.lineForm = false), this.render(true)) }, 'Cancel')),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      const issuerW = others.find((x) => x.label.toLowerCase() === iss.value.trim().toLowerCase());
      const issuer = issuerW?.address ?? normalizeAddress(iss.value);
      let code: string;
      try {
        code = encodeCurrency(cur.value);
      } catch (err) {
        return msg.replaceChildren(note('error', errText(err)));
      }
      const limit = Number(lim.value.replace(/[,_\s]/g, ''));
      if (!issuer) return msg.replaceChildren(note('error', 'Enter the issuer’s address, or the name of one of your wallets.'));
      if (issuer === w.address) return msg.replaceChildren(note('error', 'A wallet can’t trust itself.'));
      if (!(limit > 0)) return msg.replaceChildren(note('error', 'The limit must be more than 0.'));
      msg.replaceChildren();
      const name = issuerW?.label ?? this.ctx.name(w.networkId, issuer);
      await withBusy(go, 'Adding…', async () => {
        const ok = await runTx(this.ctx, w, { TransactionType: 'TrustSet', LimitAmount: { currency: code, issuer, value: String(limit) }, Flags: TF_SET_NO_RIPPLE }, `Trust line for ${cur.value.trim()} from ${name}`, [
          `Opt in to hold up to ${fmtNum(limit)} ${cur.value.trim()} issued by ${name} (${issuer}).`,
        ]);
        if (ok) {
          this.lineForm = false;
          this.render(true);
        }
      });
    };
    setTimeout(() => cur.focus());
    return form;
  }

  private async removeLine(w: StoredWallet, d: AccountData, l: TrustLine) {
    // A line disappears once it's back to the default state, which depends on the account's Default Ripple setting.
    const flags = has(d.flags, F.DefaultRipple) ? TF_CLEAR_NO_RIPPLE : TF_SET_NO_RIPPLE;
    await runTx(this.ctx, w, { TransactionType: 'TrustSet', LimitAmount: { currency: l.code, issuer: l.peer, value: '0' }, Flags: flags }, `Remove ${l.currency} trust line`, [
      `Stop trusting ${l.currency} from ${this.ctx.name(w.networkId, l.peer)}. Frees ${this.ctx.ledger.reserve(w.networkId).inc} XRP of reserve.`,
    ]);
  }

  /* --------------------------------- keys -------------------------------- */

  private keys(w: StoredWallet): HTMLElement {
    const net = w.networkId;
    const real = NETWORKS[net].real;
    const copyRow = (label: string, value: string) =>
      h(
        'div',
        { class: 'w-kv' },
        h('div', { class: 'w-k' }, label),
        h('div', { class: 'w-v' }, h('code', { class: 'addr' }, value), h('button', { class: 'icon-btn small', title: `Copy ${label.toLowerCase()}`, 'aria-label': `Copy ${label.toLowerCase()}`, onclick: async () => (await copyText(value)) && this.ctx.toast(`${label} copied`) }, icon('copy', 13))),
      );
    const out = h(
      'div',
      null,
      h(
        'div',
        { class: 'w-kvs' },
        copyRow('Address', w.address),
        w.publicKey ? copyRow('Public key', w.publicKey) : null,
        w.algorithm || w.secretKind
          ? h('div', { class: 'w-kv' }, h('div', { class: 'w-k' }, 'Key type'), h('div', { class: 'w-v' }, [w.algorithm, w.secretKind && w.secretKind !== 'none' ? SECRET_LABEL[w.secretKind] : null].filter(Boolean).join(' · ')))
          : null,
      ),
    );
    if (w.watchOnly) {
      out.append(note('info', 'Watch-only: GraphXRP has this address but no keys, so it can’t sign for it.'));
      return out;
    }

    const secrets: Secrets | null = real ? this.shown : w;
    out.append(h('div', { class: 'w-sec-head' }, h('h3', null, 'Secrets')));
    if (!secrets) {
      const reveal = h('button', { class: 'btn small' }, icon('unlock', 13), 'Show keys');
      reveal.onclick = async () => {
        const s = await this.ctx.secrets(w, `Enter your vault password to view “${w.label}”’s keys.`);
        if (!s) return;
        this.shown = s;
        this.render(true);
      };
      out.append(h('div', { class: 'w-locked' }, icon('lock', 18), h('div', null, h('strong', null, 'Encrypted'), h('p', null, 'Mainnet keys are stored encrypted. Unlock the vault to view them.')), reveal));
      return out;
    }
    const hide = real ? 30_000 : 60_000;
    const onCopy = () => this.ctx.toast(real ? 'Copied. Clear your clipboard when you’re done: this is a mainnet key.' : 'Copied');
    if (secrets.seed) out.append(h('div', { class: 'w-secret-row' }, h('div', { class: 'w-k' }, 'Family seed'), secretBox(secrets.seed, { hideAfterMs: hide, onCopy })));
    if (secrets.mnemonic) {
      out.append(
        h(
          'div',
          { class: 'w-secret-row' },
          h('div', { class: 'w-k' }, 'Recovery phrase', h('span', { class: 'w-hint' }, ` · ${secrets.derivationPath ?? "m/44'/144'/0'/0/0"}`)),
          secretBox(secrets.mnemonic, { words: secrets.mnemonic.split(' '), hideAfterMs: hide, onCopy }),
        ),
      );
    }
    if (secrets.secretNumbers) {
      const groups = secretNumberGroups(secrets.secretNumbers);
      out.append(h('div', { class: 'w-secret-row' }, h('div', { class: 'w-k' }, 'Secret numbers'), secretBox(groups.join(' '), { words: groups, labels: [...'ABCDEFGH'], hideAfterMs: hide, onCopy })));
    }
    if (secrets.privateKey) out.append(h('div', { class: 'w-secret-row' }, h('div', { class: 'w-k' }, 'Private key (hex)'), secretBox(secrets.privateKey, { hideAfterMs: hide, onCopy })));
    if (real) {
      out.append(note('warn', 'Anyone with these can take this wallet’s funds. They hide again after 30 seconds, and the vault locks after 15 minutes idle.'));
      return out;
    }

    // Test networks: ready-to-paste snippets for the code you're testing.
    const url = NETWORKS[net].servers[0];
    const label = w.label;
    const sig = w.seed ? `Wallet.fromSeed('${w.seed}')` : `new Wallet('${w.publicKey}', '${w.privateKey}')`;
    const code: Record<Snippet, string> = {
      js: `import { Client, Wallet } from 'xrpl'\n\nconst client = new Client('${url}')\nconst wallet = ${sig} // ${label}: ${w.address}`,
      py: `from xrpl.clients import JsonRpcClient\nfrom xrpl.wallet import Wallet\n\nclient = JsonRpcClient("${url.replace(/^wss:/, 'https:').replace(/:51233$/, ':51234')}")\nwallet = ${w.seed ? `Wallet.from_seed("${w.seed}")` : `Wallet("${w.publicKey}", "${w.privateKey}")`}  # ${label}`,
      env: `# ${label} (${NETWORKS[net].name})\nXRPL_NETWORK_URL=${url}\nWALLET_ADDRESS=${w.address}\n${w.seed ? `WALLET_SEED=${w.seed}` : `WALLET_PUBLIC_KEY=${w.publicKey}\nWALLET_PRIVATE_KEY=${w.privateKey}`}`,
      api: `// While GraphXRP's dev server is running:\nconst w = await fetch('${location.origin}/api/wallets/${encodeURIComponent(label.toLowerCase())}').then((r) => r.json())\nconst wallet = new Wallet(w.publicKey, w.privateKey)\nconst client = new Client(w.network.url)`,
    };
    const pre = h('pre', { class: 'w-code' }, code[this.snippet]);
    const tabs = seg<Snippet>(
      [
        { value: 'js', label: 'xrpl.js' },
        { value: 'py', label: 'xrpl-py' },
        { value: 'env', label: '.env' },
        { value: 'api', label: 'Local API', hint: 'Read this wallet from your own scripts while GraphXRP runs' },
      ],
      this.snippet,
      (v) => {
        this.snippet = v;
        pre.textContent = code[v];
      },
    );
    out.append(
      h('div', { class: 'w-sec-head' }, h('h3', null, 'Use in code'), h('button', { class: 'btn small', onclick: async () => (await copyText(pre.textContent ?? '')) && this.ctx.toast('Snippet copied') }, icon('copy', 13), 'Copy')),
      tabs,
      pre,
    );
    return out;
  }

  /* ------------------------------- settings ------------------------------ */

  private settings(w: StoredWallet, d: AccountData | undefined, activated: boolean | undefined): HTMLElement {
    const { store } = this.ctx;
    const listId = `w-groups-${w.id}`;
    const name = input({ value: w.label, maxlength: '40' });
    const group = input({ value: w.group ?? '', list: listId, placeholder: 'e.g. the app you’re testing' });
    const notes = h('textarea', { class: 'w-input', rows: '3', placeholder: 'Anything worth remembering about this wallet' }, w.notes ?? '');
    const save = h('button', { class: 'btn primary small', type: 'submit', disabled: true }, 'Save');
    const dirty = () => (save.disabled = !name.value.trim() || (name.value.trim() === w.label && group.value.trim() === (w.group ?? '') && notes.value.trim() === (w.notes ?? '')));
    for (const el of [name, group, notes]) el.addEventListener('input', dirty);
    const form = h('form', { class: 'w-form' }, field('Name', name), field('Group', group, 'Group wallets by project or app.'), datalist(listId, store.groups().map((g) => ({ value: g }))), field('Notes', notes), h('div', { class: 'row' }, save));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const label = name.value.trim();
      const patch = { label, group: group.value.trim() || undefined, notes: notes.value.trim() || undefined, autoLabel: label === w.label ? w.autoLabel : undefined };
      try {
        await store.mutate((data) => {
          const x = data.wallets.find((y) => y.id === w.id);
          if (x) Object.assign(x, patch);
        });
        (document.activeElement as HTMLElement | null)?.blur();
        this.ctx.toast('Saved');
      } catch (err) {
        this.ctx.toast(errText(err), 'error');
      }
    };

    const out = h('div', null, form);
    if (!w.watchOnly && activated && d) {
      const toggle = (label: string, hint: string, flag: number, asf: number) => {
        const on = has(d.flags, flag);
        const c = checkbox(label, on, hint);
        c.input.addEventListener('change', async () => {
          c.input.disabled = true;
          const ok = await runTx(this.ctx, w, { TransactionType: 'AccountSet', [on ? 'ClearFlag' : 'SetFlag']: asf }, `${on ? 'Turn off' : 'Turn on'} “${label}”`);
          if (!ok) c.input.checked = on;
          c.input.disabled = false;
        });
        return c.el;
      };
      out.append(
        h('div', { class: 'w-sec-head' }, h('h3', null, 'On the ledger')),
        h(
          'div',
          { class: 'w-form' },
          toggle('Require destination tags', 'Payments without a tag are rejected (like an exchange).', F.RequireDestTag, ASF_REQUIRE_DEST),
          toggle('Default ripple', 'Needed if this wallet issues a token that holders send to each other.', F.DefaultRipple, ASF_DEFAULT_RIPPLE),
        ),
      );
    }
    out.append(
      h('div', { class: 'w-sec-head' }, h('h3', null, 'Remove')),
      h(
        'div',
        { class: 'w-danger' },
        h('p', null, 'The account stays on the ledger. GraphXRP just forgets it', w.watchOnly ? '.' : ' and deletes its keys from this computer.'),
        h('button', { class: 'btn small danger', onclick: () => void this.remove(w) }, icon('trash', 13), 'Remove from GraphXRP'),
      ),
    );
    return out;
  }

  private async remove(w: StoredWallet) {
    const real = NETWORKS[w.networkId].real;
    const warn = w.watchOnly
      ? `Stop watching “${w.label}”?`
      : real
        ? `Remove “${w.label}” and delete its encrypted keys?\n\nMake sure its seed is backed up somewhere else first, or you’ll lose access to its funds.`
        : `Remove “${w.label}” from GraphXRP?\n\nThe account stays on ${NETWORKS[w.networkId].name}, but its keys are deleted from this computer.`;
    if (!confirm(warn)) return;
    try {
      await this.ctx.store.mutate((d) => {
        d.wallets = d.wallets.filter((x) => x.id !== w.id);
      });
      if (this.id === w.id) this.show(null);
      this.ctx.toast(`Removed ${w.label}`);
    } catch (e) {
      this.ctx.toast(errText(e), 'error');
    }
  }
}
