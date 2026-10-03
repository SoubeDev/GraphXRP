/**
 * Local wallet manager: hold testnet, devnet and mainnet wallets next to the map.
 * Only loaded when the local dev server provides the wallet API (see probe.ts).
 */
import './wallets.css';
import type { App } from '../app';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { isAddress, shortAddr } from '../xrpl/amount';
import { Ledger } from './ledger';
import { NETWORKS, type NetworkId } from './networks';
import { WalletStore, newId } from './store';
import { secretsOf, type DerivedKeys } from './keys';
import { isUnlocked, onVaultChange, seal, unseal } from './vault';
import type { Secrets, StoredWallet } from './types';
import { WalletDrawer, type Tab } from './ui/drawer';
import { ensureUnlocked } from './ui/vaultui';
import { errText } from './ui/kit';

export interface Ctx {
  app: App;
  store: WalletStore;
  ledger: Ledger;
  /** Wallets currently waiting on the faucet. */
  funding: Set<string>;
  /** Open the drawer, optionally on one wallet. */
  open(id?: string | null, tab?: Tab): void;
  /** A wallet's secrets, unlocking the vault first for mainnet. Null if unavailable or cancelled. */
  secrets(w: StoredWallet, reason?: string): Promise<Secrets | null>;
  /** How to call an address on a network: your wallet's name, then (mainnet) public names. */
  name(net: NetworkId, addr: string): string;
  /** Build stored wallets from keys (mainnet keys get sealed; the vault must be unlocked). */
  build(net: NetworkId, items: { label: string; group?: string; keys?: DerivedKeys; address?: string; autoLabel?: boolean }[]): Promise<StoredWallet[]>;
  fund(w: StoredWallet): Promise<void>;
  toast(text: string, tone?: 'info' | 'error'): void;
}

export async function mount(app: App, root: HTMLElement) {
  const store = await WalletStore.open();
  const ledger = new Ledger(app);
  const funding = new Set<string>();
  let drawer: WalletDrawer;

  const ctx: Ctx = {
    app,
    store,
    ledger,
    funding,
    open: (id, tab) => drawer.show(id, tab),
    toast: (text, tone) => app.toast(text, tone),

    async secrets(w, reason) {
      if (w.watchOnly) return null;
      if (w.networkId !== 'mainnet') return secretsOf(w);
      if (!w.sealed) return null;
      if (!(await ensureUnlocked(store, reason))) return null;
      return unseal(w.sealed);
    },

    name(net, addr) {
      const w = store.find(addr, net);
      if (w) return w.label;
      return net === 'mainnet' ? app.dir.label(addr) : shortAddr(addr);
    },

    async build(net, items) {
      const now = new Date().toISOString();
      const out: StoredWallet[] = [];
      for (const it of items) {
        const k = it.keys;
        const base: StoredWallet = {
          id: newId(),
          label: it.label.trim() || 'Wallet',
          address: k?.address ?? it.address!,
          networkId: net,
          group: it.group?.trim() || undefined,
          watchOnly: !k || undefined,
          autoLabel: it.autoLabel || undefined,
          secretKind: k?.secretKind,
          algorithm: k?.algorithm,
          publicKey: k?.publicKey,
          createdAt: now,
        };
        if (k && NETWORKS[net].real) {
          if (!isUnlocked()) throw new Error('Unlock the vault first.');
          base.sealed = await seal(secretsOf(k));
        } else if (k) Object.assign(base, secretsOf(k));
        out.push(base);
      }
      return out;
    },

    async fund(w) {
      if (funding.has(w.id)) return;
      funding.add(w.id);
      drawer.refresh();
      try {
        const amount = await ledger.fund(w.networkId, w.address);
        app.toast(`${w.label} got ${amount ?? 'some'} test XRP from the faucet`);
      } catch (e) {
        app.toast(`Faucet: ${errText(e)}`, 'error');
      } finally {
        funding.delete(w.id);
        drawer.refresh();
      }
    },
  };

  drawer = new WalletDrawer(ctx);
  root.append(drawer.el);

  /* ---------------- top bar button and keyboard shortcut ---------------- */

  const count = h('span', { class: 'tb-count' });
  const btn = h('button', { class: 'tb-btn', title: 'Your wallets (W)', 'aria-label': 'Your wallets', onclick: () => drawer.toggle() }, icon('wallet', 16), h('span', { class: 'tb-label' }, 'Wallets'), count);
  const right = root.querySelector('.topbar-right');
  right?.insertBefore(btn, right.children[1] ?? null);
  const paintBtn = () => {
    count.textContent = store.wallets.length ? String(store.wallets.length) : '';
    btn.classList.toggle('on', drawer.isOpen);
    btn.setAttribute('aria-expanded', String(drawer.isOpen));
  };
  drawer.onToggle = paintBtn;

  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    return e.metaKey || e.ctrlKey || e.altKey || t.matches('input, textarea, select') || t.isContentEditable || !!document.querySelector('dialog[open]');
  };
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'w' || e.key === 'W') && !typing(e)) {
      e.preventDefault();
      drawer.toggle();
    }
  });
  // Esc inside the drawer closes just the drawer (captured before the map's own Esc handling).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || typing(e) || !drawer.isOpen || document.querySelector('.w-menu')) return;
      if (!drawer.el.contains(e.target as Node) && !drawer.lastInside) return;
      e.stopImmediatePropagation();
      drawer.hide();
    },
    true,
  );
  root.querySelector('.help-keys')?.append(h('li', null, h('kbd', null, 'W'), 'Your wallets'));

  /* ---------------------- keep the explorer in sync --------------------- */

  // A watched account you didn't name keeps showing its public name on the map, and adopts it once known.
  const autoNamed = (w: StoredWallet) => w.networkId === 'mainnet' && !!w.autoLabel;
  const sync = () => {
    ledger.watch(store.addressesByNetwork());
    const mainnet = store.onNetwork('mainnet');
    app.dir.setWalletNames(new Map(mainnet.filter((w) => !autoNamed(w)).map((w) => [w.address, w.label])));
    for (const w of mainnet) if (autoNamed(w)) app.dir.enrichLight(w.address);
    paintBtn();
  };
  store.onChange(sync);
  sync();
  app.dir.onChange((addr) => {
    const w = store.find(addr, 'mainnet');
    const name = w && autoNamed(w) ? app.dir.get(addr).name : undefined;
    if (!w || !name || name === w.label) return;
    void store
      .mutate((d) => {
        const x = d.wallets.find((y) => y.id === w.id);
        if (x && autoNamed(x)) x.label = name;
      })
      .catch(() => {});
  });

  // Activity that didn't start here (e.g. the app you're testing signed with one of these wallets).
  // Only for wallets you hold keys for, only when they sent or received, and never more than a few at once.
  let windowStart = 0;
  let shown = 0;
  let held = 0;
  let flush = 0;
  const announce = (text: string, tone: 'info' | 'error') => {
    const now = Date.now();
    if (now - windowStart > 15_000) {
      windowStart = now;
      shown = 0;
    }
    if (shown < 3) {
      shown++;
      app.toast(text, tone);
      return;
    }
    held++;
    clearTimeout(flush);
    flush = window.setTimeout(() => {
      if (held) app.toast(`${held} more transaction${held === 1 ? '' : 's'} on your wallets`);
      held = 0;
    }, 4000);
  };
  ledger.onTx((net, t) => {
    const w = [store.find(t.account, net), t.destination ? store.find(t.destination, net) : undefined].find((x) => x && !x.watchOnly);
    if (!w) return;
    const other = t.account === w.address ? t.destination : t.account;
    const what = !t.success
      ? `${t.type} failed (${t.result})`
      : t.type === 'Payment' && t.delivered
        ? `${t.account === w.address ? 'sent' : 'received'} ${fmtShort(t.delivered.value)} ${t.delivered.currency}${other ? ` ${t.account === w.address ? 'to' : 'from'} ${ctx.name(net, other)}` : ''}`
        : t.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    announce(`${w.label} (${NETWORKS[net].name}) ${what}`, t.success ? 'info' : 'error');
  });

  onVaultChange(() => drawer.refresh());

  /* ------------------------------ map hooks ----------------------------- */

  app.ext.search = (q) => {
    const query = q.toLowerCase();
    return store.wallets
      .filter((w) => w.label.toLowerCase().includes(query) || (query.length >= 4 && w.address.toLowerCase().startsWith(query)) || (w.group ?? '').toLowerCase().includes(query))
      .map((w) => ({
        title: w.label,
        address: w.networkId === 'mainnet' ? w.address : undefined,
        tag: `your wallet · ${NETWORKS[w.networkId].name}`,
        sub: [shortAddr(w.address), w.group].filter(Boolean).join(' · '),
        kind: 'wallet',
        run: () => drawer.show(w.id),
      }));
  };

  app.ext.inspectorBanner = (id) => {
    const w = store.find(id, 'mainnet');
    if (!w) return null;
    return h(
      'div',
      { class: 'banners' },
      h(
        'div',
        { class: 'banner info w-banner' },
        icon('wallet', 16),
        h('div', null, h('strong', null, w.watchOnly ? `Watching as “${w.label}”` : `Your wallet “${w.label}”`), h('p', null, w.watchOnly ? 'In your wallets, without keys.' : 'You hold its keys in GraphXRP.')),
        h('button', { class: 'btn small', onclick: () => drawer.show(w.id) }, 'Open'),
      ),
    );
  };

  app.ext.contextItems = (id) => {
    if (!isAddress(id)) return [];
    const w = store.find(id, 'mainnet');
    if (w) return [{ icon: 'wallet', label: `Open “${w.label}” in Wallets`, run: () => drawer.show(w.id) }];
    return [
      {
        icon: 'eye',
        label: 'Watch in Wallets',
        run: async () => {
          const ident = app.dir.get(id);
          const [made] = await ctx.build('mainnet', [{ label: ident.name ?? shortAddr(id), address: id, autoLabel: true }]);
          await store.mutate((d) => void d.wallets.push(made)).catch((e) => app.toast(errText(e), 'error'));
          app.toast(`Watching ${made.label}`);
          drawer.show(made.id);
        },
      },
    ];
  };
}

function fmtShort(v: number) {
  return Number(v.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}
