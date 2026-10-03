/** Right-hand panel: everything about one account, in plain English, with sources. */
import type { App, Trace } from '../app';
import { KIND_HINT, KIND_LABEL } from '../app';
import { h, clear, copyText } from './dom';
import { icon, shapeGlyph } from './icons';
import { summarize, summarizeFlows, type AccountData } from '../xrpl/loader';
import { describe, describeCrossing, type Description, type Flow, type ParsedTx, type Seg } from '../xrpl/parse';
import { BRIDGES, chainName, doorOf, explorerFor, extId, isExternal, parseExt, shortForeign } from '../bridges/registry';
import { NETWORKS, chainOf, isLoadable, rawAddress, type Network } from '../chains/chains';
import type { EvmAccount, EvmEvent } from '../chains/evm';
import type { CrossChain } from '../bridges/decode';
import type { CrossRecord } from '../app';
import { traits, isBlackholed } from '../xrpl/flags';
import { fmtNum, fmtXrp, fmtDate, fmtDateTime, fmtAge, timeAgo, type Amt } from '../xrpl/amount';
import { ADVISORY_TEXT, type Identity } from '../identity/directory';
import type { NodeKind } from '../graph/model';

const EXPLORERS = (id: string) => {
  const chain = chainOf(id);
  const a = rawAddress(id);
  if (chain === 'xahau') return [{ name: 'Xahau Explorer', href: NETWORKS.xahau.explorer.account(a) }];
  if (chain === 'xrpl-evm') return [{ name: 'XRPL EVM Explorer', href: NETWORKS['xrpl-evm'].explorer.account(a) }];
  return [
    { name: 'XRPScan', href: `https://xrpscan.com/account/${a}` },
    { name: 'XRPL Explorer', href: `https://livenet.xrpl.org/accounts/${a}` },
    { name: 'Bithomp', href: `https://bithomp.com/explorer/${a}` },
  ];
};

const EDGE_WORD: Record<string, string> = {
  payment: 'payments',
  activation: 'account creation',
  trust: 'token trust',
  dex: 'trading',
  control: 'control',
  crosschain: 'cross-chain',
  contract: 'contract calls',
};

export class Inspector {
  readonly el: HTMLElement;
  private id: string | null = null;
  private body: HTMLElement | null = null;
  private activityShown = 25;
  private cpShown = 12;
  private editingLabel = false;
  private pending = false;

  constructor(
    private app: App,
    host: HTMLElement,
  ) {
    this.el = h('aside', { class: 'inspector panel', 'aria-label': 'Account details', 'aria-live': 'polite' });
    host.appendChild(this.el);
    app.on('select', (id) => this.open(id));
    app.on('account', (id) => id === this.id && this.renderSoon());
    app.on('trace', (id) => id === this.id && this.renderSoon());
    app.on('graph', () => this.id && this.renderSoon());
    window.addEventListener('resize', () => this.updateInset());
  }

  private open(id: string | null) {
    if (id !== this.id) {
      this.activityShown = 25;
      this.cpShown = 12;
      this.editingLabel = false;
      if (this.body) this.body.scrollTop = 0;
    }
    this.id = id;
    this.el.classList.toggle('open', !!id);
    this.el.parentElement?.classList.toggle('inspector-open', !!id);
    this.updateInset();
    this.render();
  }

  private updateInset() {
    const wide = window.innerWidth > 760;
    const v = this.app.view;
    v.insetRight = this.id && wide ? this.el.offsetWidth + 24 : 0;
    v.insetBottom = this.id && !wide ? this.el.offsetHeight + 16 : 0;
    if (this.id) v.focusNode(this.id);
  }

  private renderSoon() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  /* ------------------------------ helpers ------------------------------ */

  private chip(addr: string, opts: { me?: string } = {}): HTMLElement {
    const app = this.app;
    if (opts.me && addr === opts.me) return h('strong', { class: 'self' }, isExternal(addr) ? 'this address' : 'this account');
    const kind = app.model.nodes.get(addr)?.kind ?? app.classify(addr);
    const ident = app.dir.get(addr);
    const ext = isExternal(addr) ? parseExt(addr) : null;
    return h(
      'button',
      {
        class: `chip-acct${ident.name ? ' named' : ''}`,
        title: `${ext ? (ext.address ? `${ext.address} on ${chainName(ext.chain)}` : chainName(ext.chain)) : addr}\nClick to open`,
        onclick: (e: Event) => {
          e.stopPropagation();
          this.goto(addr);
        },
        onmouseenter: () => app.view.peek(addr),
        onmouseleave: () => app.view.peek(null),
      },
      shapeGlyph(kind, 11),
      h('span', null, app.dir.label(addr)),
      // The same address exists on several networks: say which one this is.
      chainOf(addr) !== 'xrpl' && isLoadable(addr) ? h('span', { class: 'chip-net' }, NETWORKS[chainOf(addr) as Network].short) : null,
    );
  }

  private goto(addr: string) {
    const app = this.app;
    const me = this.id;
    if (me && !app.model.nodes.has(addr)) app.addCounterparty(me, addr);
    app.select(addr);
    app.view.focusNode(addr);
  }

  private amt(a: Amt): HTMLElement {
    const title = a.isXrp ? `${a.currency}, the network’s own currency` : a.issuer ? `${a.currency} token issued by ${this.app.dir.label(a.issuer)} (${a.issuer})` : a.currency;
    return h('span', { class: `amt${a.isXrp ? ' xrp' : ''}`, title }, `${fmtNum(a.value)} ${a.currency}`);
  }

  private segs(segs: Seg[], me: string, hash?: string): (HTMLElement | string)[] {
    return segs.map((s) => {
      if (typeof s === 'string') return s;
      if ('a' in s) return this.chip(s.a, { me });
      if ('amt' in s) return this.amt(s.amt);
      if ('badge' in s) return s.badge === 'declared' && hash ? this.evidence(hash, s.tip) : h('span', { class: 'badge', title: s.tip, tabindex: '0' }, s.badge);
      return h('span', { class: 'dtag', title: 'Destination tag: exchanges use this number to know which customer a payment belongs to.' }, `tag ${s.tag}`);
    });
  }

  /** "declared" until the other network is checked; then confirmed / not found. */
  private evidence(hash: string, declaredTip: string): HTMLElement {
    const c = this.app.verifier.get(hash);
    if (!c || c.status === 'declared') return h('span', { class: 'badge', title: declaredTip, tabindex: '0' }, 'declared');
    if (c.status === 'checking') return h('span', { class: 'badge checking', title: c.how, tabindex: '0' }, h('span', { class: 'spinner tiny' }), 'checking');
    if (c.status === 'confirmed') return h('span', { class: 'badge ok', title: c.how, tabindex: '0' }, icon('checkCircle', 11), 'confirmed');
    if (c.status === 'not-found') return h('span', { class: 'badge warn', title: c.how, tabindex: '0' }, icon('alert', 11), 'not found');
    return h('span', { class: 'badge', title: `${declaredTip}\n${c.how}`, tabindex: '0' }, 'declared');
  }

  /** Link to the matching transaction on the other network, once confirmed. */
  private proofLink(hash: string): (string | HTMLElement)[] {
    const c = this.app.verifier.get(hash);
    if (c?.status !== 'confirmed' || !c.other) return [];
    return [' · ', h('a', { href: c.other.href, target: '_blank', rel: 'noopener', title: c.how }, `on ${NETWORKS[c.other.network].name}`, icon('external', 10))];
  }

  private section(title: string, sub: string | null, ...children: (Node | string | null | false | undefined)[]): HTMLElement {
    return h('section', { class: 'ins-sec' }, h('h3', null, title, sub ? h('span', { class: 'sub' }, sub) : null), ...children);
  }

  private skeleton(lines = 3) {
    return h('div', { class: 'skeleton' }, ...Array.from({ length: lines }, (_, i) => h('div', { class: 'sk-line', style: { width: `${90 - i * 18}%` } })));
  }

  /* ------------------------------- render ------------------------------ */

  private render() {
    const id = this.id;
    if (!id) return;
    if (!isLoadable(id)) return this.renderExternal(id);
    if (chainOf(id) === 'xrpl-evm') return this.renderEvm(id);
    const app = this.app;
    const ident = app.dir.get(id);
    const d = app.accountData(id);
    const net = NETWORKS[chainOf(id) as Network];
    const node = app.model.nodes.get(id);
    const kind: NodeKind = node?.kind ?? app.classify(id);
    const scroll = this.body?.scrollTop ?? 0;

    clear(this.el);
    const body = h(
      'div',
      { class: 'ins-body' },
      this.warnings(ident, node?.state === 'error' && !d),
      app.ext.inspectorBanner?.(id) ?? null,
      this.bridgeSection(id, d?.txs, !!d, !!d?.obligations.length),
      this.who(id, ident, d),
      this.glance(d, node?.state),
      this.traceSection(id, app.traces.get(id)),
      this.traceSection(id, app.traces.get(`${id}:funding`)),
      d ? this.setup(d, kind) : null,
      d?.amm ? this.pool(d) : null,
      d ? this.tokens(d) : null,
      d && !doorOf(id) ? this.crossActivity(id, d) : null,
      d ? this.dealsWith(d) : null,
      this.activity(id, d, node?.state),
      h(
        'footer',
        { class: 'ins-foot' },
        icon('info', 13),
        h(
          'p',
          null,
          `Balances and history come straight from ${chainOf(id) === 'xrpl' ? 'the XRP Ledger' : net.name}`,
          chainOf(id) === 'xrpl' && app.client.server ? ` (via ${app.client.server.replace('wss://', '')})` : '',
          '. Names come from public directories and the account’s own website, so each one lists its source. They can be wrong.',
        ),
      ),
    );
    this.el.append(this.header(id, ident, kind, node?.state ?? 'stub', !!node?.expanded, !!node?.pinned), body);
    this.body = body;
    body.scrollTop = scroll;
  }

  private header(id: string, ident: Identity, kind: NodeKind, state: string, expanded: boolean, pinned: boolean) {
    const app = this.app;
    const verified = ident.claims.some((c) => c.verified) || ident.domainCheck === 'confirmed';
    const avatar = ident.avatar ? h('img', { src: ident.avatar, alt: '', class: 'avatar', referrerpolicy: 'no-referrer' }) : identicon(id);
    const raw = rawAddress(id);
    const copyBtn = h('button', { class: 'icon-btn', title: 'Copy address', 'aria-label': 'Copy address' }, icon('copy', 14));
    copyBtn.onclick = async () => {
      if (await copyText(raw)) app.toast('Address copied');
    };
    const running = app.traces.get(id)?.running;
    const chain = chainOf(id);
    return h(
      'header',
      { class: 'ins-head' },
      h(
        'div',
        { class: 'ins-top' },
        avatar,
        h(
          'div',
          { class: 'ins-title' },
          h(
            'h2',
            null,
            h('span', { class: ident.name ? '' : 'unnamed' }, ident.name ?? 'Unnamed account'),
            ident.tag ? h('span', { class: 'tag' }, ident.tag) : null,
            verified ? h('span', { class: 'verified', title: 'At least one source verified this identity' }, icon('checkCircle', 15)) : null,
          ),
          h(
            'div',
            { class: 'kind', title: KIND_HINT[kind] },
            shapeGlyph(kind, 12),
            KIND_LABEL[kind],
            chain !== 'xrpl' ? this.netChip(chain) : null,
            state === 'loading' ? h('span', { class: 'spinner', 'aria-label': 'Loading' }) : null,
          ),
        ),
        h('button', { class: 'icon-btn close', title: 'Close (Esc)', 'aria-label': 'Close details', onclick: () => app.select(null) }, icon('x', 16)),
      ),
      h('div', { class: 'addr-row' }, h('code', { class: 'addr', title: 'The account’s public address' }, raw), copyBtn),
      h(
        'div',
        { class: 'ins-actions' },
        h(
          'button',
          { class: 'btn primary', onclick: () => (expanded ? app.collapse(id) : void app.expand(id)), title: expanded ? 'Remove the connections that only hang off this account' : 'Show who this account deals with (double-click a node also works)' },
          icon('network', 15),
          expanded ? 'Collapse' : 'Show connections',
        ),
        h('button', { class: 'btn', disabled: running, onclick: () => void app.traceOrigin(id), title: 'Follow who created this account, then who created that one, until we reach someone known' }, icon('sprout', 15), 'Trace origin'),
        h('button', { class: 'btn', onclick: () => void app.traceFunding(id), title: 'Follow the biggest source of XRP, step by step' }, icon('route', 15), 'Follow the money'),
        h('button', { class: `icon-btn${pinned ? ' on' : ''}`, onclick: () => (app.view.togglePin(id), this.render()), title: pinned ? 'Unpin' : 'Pin in place', 'aria-label': 'Pin' }, icon('pin', 15)),
        h('button', { class: 'icon-btn', onclick: () => app.view.focusNode(id), title: 'Center on map', 'aria-label': 'Center' }, icon('crosshair', 15)),
      ),
    );
  }

  private warnings(ident: Identity, failed: boolean) {
    const out: HTMLElement[] = [];
    if (ident.advisory) {
      out.push(
        h(
          'div',
          { class: 'banner bad', role: 'alert' },
          icon('alert', 16),
          h('div', null, h('strong', null, 'Flagged by XRPScan'), h('p', null, `This account is ${ADVISORY_TEXT[ident.advisory] ?? `flagged (${ident.advisory})`}. Think twice before sending anything here.`)),
        ),
      );
    }
    if (ident.xamanBlocked) {
      out.push(h('div', { class: 'banner bad', role: 'alert' }, icon('alert', 16), h('div', null, h('strong', null, 'Blocked in Xaman'), h('p', null, 'The Xaman wallet marks this account as blocked.'))));
    }
    if (failed) {
      out.push(
        h(
          'div',
          { class: 'banner warn' },
          icon('alert', 16),
          h('div', null, h('strong', null, 'Couldn’t load this account'), h('p', null, 'The ledger server didn’t answer. ', h('button', { class: 'link', onclick: () => void this.app.loadAccount(this.id!).catch(() => {}) }, 'Try again'))),
        ),
      );
    }
    return out.length ? h('div', { class: 'banners' }, ...out) : null;
  }

  private who(id: string, ident: Identity, d?: AccountData) {
    const rows: HTMLElement[] = [];
    for (const c of ident.claims) {
      rows.push(
        h(
          'li',
          { class: 'claim' },
          h('span', { class: `claim-ico${c.verified ? ' ok' : ''}` }, icon(c.verified ? 'checkCircle' : c.source === 'Your label' ? 'tag' : c.source === 'Your wallet' ? 'wallet' : 'user', 15)),
          h(
            'div',
            null,
            h('div', { class: 'claim-text' }, c.text),
            h('div', { class: 'claim-src' }, c.verified ? `${c.source} · verified` : c.source, c.href ? h('a', { href: c.href, target: '_blank', rel: 'noopener' }, icon('external', 11)) : null),
          ),
        ),
      );
    }
    if (ident.domain) {
      const dc = ident.domainCheck;
      const text =
        dc === 'confirmed'
          ? `${ident.domain} lists this account in its official xrp-ledger.toml file. The website and the account point to each other.`
          : dc === 'unconfirmed'
            ? `${ident.domain} does not list this account, so the claim is unproven. Any account can type in any website.`
            : dc === 'unreachable'
              ? `Couldn’t reach ${ident.domain} to check (the site may block requests from this page).`
              : `Checking whether ${ident.domain} confirms this account…`;
      rows.push(
        h(
          'li',
          { class: 'claim' },
          h('span', { class: `claim-ico${dc === 'confirmed' ? ' ok' : dc === 'unconfirmed' ? ' warn' : ''}` }, icon(dc === 'confirmed' ? 'shield' : 'globe', 15)),
          h(
            'div',
            null,
            h('div', { class: 'claim-text' }, 'Says its website is ', h('a', { href: `https://${ident.domain}`, target: '_blank', rel: 'noopener noreferrer' }, ident.domain)),
            h('div', { class: 'claim-src' }, text),
          ),
        ),
      );
    }
    if (ident.twitter) {
      rows.push(
        h(
          'li',
          { class: 'claim' },
          h('span', { class: 'claim-ico' }, icon('user', 15)),
          h('div', null, h('div', { class: 'claim-text' }, h('a', { href: `https://x.com/${ident.twitter}`, target: '_blank', rel: 'noopener' }, `@${ident.twitter}`)), h('div', { class: 'claim-src' }, 'Social account listed by XRPScan')),
        ),
      );
    }
    if (isBlackholeAddr(id)) {
      rows.push(h('li', { class: 'claim' }, h('span', { class: 'claim-ico' }, icon('lock', 15)), h('div', null, h('div', { class: 'claim-text' }, 'Black hole address'), h('div', { class: 'claim-src' }, 'A special address nobody has a key for. Accounts that hand control to it can never be controlled again.'))));
    }

    const twin = this.twinNote(id);
    const empty = !rows.length;
    const lookups = ident.light === 'loading' || ident.deep === 'loading';
    const note = ident.userNote ? h('p', { class: 'user-note' }, icon('tag', 13), ident.userNote) : null;
    const labelForm = this.editingLabel ? this.labelForm(id, ident) : null;
    return this.section(
      'Who is this?',
      lookups ? 'checking directories…' : null,
      empty
        ? h(
            'p',
            { class: 'muted' },
            lookups && !d ? 'Looking this account up in public directories…' : 'No public identity. That’s normal: most accounts belong to private individuals. You can still see everything it did below.',
          )
        : h('ul', { class: 'claims' }, ...rows),
      twin,
      note,
      labelForm ??
        h(
          'button',
          { class: 'link small', onclick: () => ((this.editingLabel = true), this.render()) },
          icon('tag', 13),
          ident.userLabel || ident.userNote ? 'Edit your private label' : 'Add your own private label',
        ),
    );
  }

  private labelForm(id: string, ident: Identity) {
    const label = h('input', { type: 'text', value: ident.userLabel ?? '', placeholder: 'e.g. My exchange deposit', maxlength: '40', 'aria-label': 'Label' });
    const note = h('textarea', { rows: '2', placeholder: 'Private note (optional)', 'aria-label': 'Note' }, ident.userNote ?? '');
    const save = () => {
      this.app.dir.setLabel(id, label.value, note.value);
      this.editingLabel = false;
      this.render();
    };
    setTimeout(() => label.focus(), 0);
    label.onkeydown = (e) => e.key === 'Enter' && save();
    return h(
      'div',
      { class: 'label-form' },
      label,
      note,
      h('p', { class: 'muted small' }, 'Saved only in this browser. Handy for remembering whose account is whose.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: save }, 'Save'), h('button', { class: 'btn small', onclick: () => ((this.editingLabel = false), this.render()) }, 'Cancel')),
    );
  }

  private glance(d: AccountData | undefined, state?: string) {
    const app = this.app;
    if (!d) return this.section('At a glance', null, state === 'error' ? h('p', { class: 'muted' }, 'Not available.') : this.skeleton(3));
    const stats: HTMLElement[] = [];
    const stat = (label: string, value: Node | string, sub?: Node | string | null, title?: string) =>
      stats.push(h('div', { class: 'stat', title: title ?? '' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub' }, sub) : null));

    if (d.exists) {
      const client = d.chain === 'xahau' ? (app.xahauConnected ?? app.client) : app.client;
      const reserve = client.reserveBase + d.ownerCount * client.reserveInc;
      stat(
        `${d.native} balance`,
        d.native === 'XRP' ? fmtXrp(d.balance) : `${fmtNum(d.balance)} ${d.native}`,
        `${fmtNum(reserve)} ${d.native} locked as reserve`,
        `Every account must keep a small amount of ${d.native} locked (the reserve) to exist on the ledger.`,
      );
    } else {
      stat('Status', 'No account', 'Deleted or never activated');
    }
    const a = d.activation;
    if (a?.date) stat('Created', fmtDate(a.date), `${fmtAge(a.date)} ago`);
    else if (a?.unknown === 'genesis') stat('Created', 'Before 2013', 'Older than the surviving ledger records');
    else stat('Created', 'Unknown', null);
    if (a?.parent && a.via === 'Import') {
      stats.push(
        h(
          'div',
          { class: 'stat wide' },
          h('div', { class: 'stat-label' }, 'Brought to life by'),
          h('div', { class: 'stat-value' }, 'Importing from the XRP Ledger: ', this.chip(a.parent)),
          h('div', { class: 'stat-sub' }, 'Burn 2 Mint: the Import carries proof of a burn on the XRP Ledger', a.amount ? [', crediting ', this.amt(a.amount)] : ''),
        ),
      );
    } else if (a?.parent) {
      stats.push(
        h(
          'div',
          { class: 'stat wide' },
          h('div', { class: 'stat-label' }, 'Brought to life by'),
          h('div', { class: 'stat-value' }, this.chip(a.parent)),
          h('div', { class: 'stat-sub' }, a.amount ? ['who sent the first ', this.amt(a.amount)] : a.via ? `via ${a.via}` : ''),
        ),
      );
    }
    const held = d.lines.filter((l) => l.balance > 0).length;
    if (held) stat('Tokens held', String(held), d.linesMore ? 'and more' : null);
    if (d.obligations.length) stat('Tokens issued', String(d.obligations.length), null);
    return this.section('At a glance', null, h('div', { class: 'stats' }, ...stats));
  }

  private traceSection(id: string, t: Trace | undefined) {
    if (!t) return null;
    const app = this.app;
    const isOrigin = t.kind === 'origin';
    const items: HTMLElement[] = [];
    items.push(h('li', { class: 'tr-step start' }, h('span', { class: 'tr-dot' }), h('div', null, this.chip(id), h('span', { class: 'muted' }, ' (start)'))));
    for (const s of t.steps) {
      items.push(
        h(
          'li',
          { class: 'tr-step' },
          h('span', { class: 'tr-dot' }),
          h(
            'div',
            null,
            h('div', { class: 'tr-rel' }, isOrigin ? 'was created by' : 'got most of its recent XRP from'),
            this.chip(s.parent),
            h(
              'div',
              { class: 'tr-meta' },
              s.amount ? [isOrigin ? 'sent ' : '', this.amt(s.amount)] : null,
              s.date ? ` · ${fmtDate(s.date)}` : '',
              s.hash ? h('a', { href: `https://livenet.xrpl.org/transactions/${s.hash}`, target: '_blank', rel: 'noopener', title: 'See the transaction' }, icon('external', 11)) : null,
            ),
          ),
        ),
      );
    }
    const last = t.steps.at(-1)?.parent ?? id;
    let endText = '';
    let cont: HTMLElement | null = null;
    if (t.running) endText = 'Tracing…';
    else if (t.end === 'known') {
      endText = `Reached ${app.dir.label(last)}, a publicly identified account.`;
      if (isOrigin) cont = h('button', { class: 'link small', onclick: () => void app.traceOrigin(id, last) }, 'Keep tracing further back');
    } else if (t.end === 'genesis') endText = 'Reached the beginning of the surviving records (early 2013). This account was among the first.';
    else if (t.end === 'history') endText = 'The server’s history doesn’t go back far enough to see further.';
    else if (t.end === 'none') endText = isOrigin ? 'No earlier creator found.' : 'No significant XRP source found further back in recent history.';
    else if (t.end === 'loop') endText = 'The trail loops back on itself.';
    else if (t.end === 'limit') endText = 'Stopped after many steps.';
    else if (t.end === 'error') endText = 'The trace was interrupted by a network error.';
    return this.section(
      isOrigin ? 'Origin trail' : 'Money trail',
      isOrigin ? 'who created whom' : 'biggest XRP source, step by step',
      h('ol', { class: 'trail' }, ...items),
      h('p', { class: 'muted small' }, t.running ? h('span', { class: 'spinner' }) : null, endText, ' ', cont),
      !isOrigin ? h('p', { class: 'muted small' }, 'Based on each account’s latest 200 transactions. A hint of where funds came from, not proof of ownership.') : null,
      h('button', { class: 'link small', onclick: () => app.showTrace(t.kind === 'origin' ? id : `${id}:funding`) }, icon('crosshair', 12), 'Highlight on map'),
    );
  }

  private setup(d: AccountData, kind: NodeKind) {
    const list = traits({
      flags: d.flags,
      regularKey: d.regularKey,
      signers: d.signers,
      transferRate: d.transferRate,
      isAmm: !!d.ammId,
      issues: d.obligations.length > 0,
      exists: d.exists,
    });
    const extra: HTMLElement[] = [];
    const signsFor = [...this.app.model.edgesOf(d.address)].filter((e) => e.type === 'control' && (e.a === d.address ? e.ab.count : e.ba.count)).map((e) => (e.a === d.address ? e.b : e.a));
    if (signsFor.length) {
      list.unshift({
        icon: 'key',
        title: `Signs for ${signsFor.length === 1 ? 'another account' : `${signsFor.length} accounts`}`,
        text: d.exists
          ? 'This account holds a key that can approve transactions for the accounts below.'
          : 'This is a signing key, not a regular account. Keys used for multi-signature don\u2019t need an account of their own, so "inactive" is expected here.',
        tone: 'info',
      });
      extra.push(h('div', { class: 'trait-who' }, 'Signs for: ', ...signsFor.map((a) => this.chip(a))));
    }
    if (d.regularKey && !isBlackholed(d)) extra.push(h('div', { class: 'trait-who' }, 'Signing key: ', this.chip(d.regularKey)));
    if (d.signers?.entries.length) extra.push(h('div', { class: 'trait-who' }, 'Signers: ', ...d.signers.entries.map((s) => this.chip(s.account))));
    if (!list.length) {
      return this.section('How it’s set up', null, h('p', { class: 'muted' }, kind === 'wallet' ? 'A plain account with default settings, controlled by its own key.' : 'Default settings.'));
    }
    return this.section(
      'How it’s set up',
      null,
      h(
        'ul',
        { class: 'traits' },
        ...list.map((t) => h('li', { class: `trait ${t.tone}` }, h('span', { class: 'trait-ico' }, icon(t.icon, 15)), h('div', null, h('div', { class: 'trait-title' }, t.title), h('p', null, t.text)))),
      ),
      ...extra,
    );
  }

  private pool(d: AccountData) {
    const p = d.amm!;
    const issuers = [p.asset1.issuer, p.asset2.issuer].filter((x): x is string => !!x);
    return this.section(
      'Liquidity pool',
      null,
      h('div', { class: 'pool' }, this.amt(p.asset1), h('span', { class: 'muted' }, '+'), this.amt(p.asset2)),
      h('p', { class: 'muted small' }, `Traders pay a ${+p.feePct.toFixed(3)}% fee that goes to liquidity providers. The price follows the ratio of the two amounts.`),
      issuers.length ? h('div', { class: 'trait-who' }, 'Token issuers: ', ...issuers.map((i) => this.chip(i))) : null,
    );
  }

  private tokens(d: AccountData) {
    const out: HTMLElement[] = [];
    if (d.obligations.length) {
      out.push(
        this.section(
          'Tokens it issues',
          'total in circulation',
          h('ul', { class: 'tok-list' }, ...d.obligations.slice(0, 12).map((o) => h('li', null, h('span', { class: 'tok-cur' }, o.currency), h('span', { class: 'tok-val' }, fmtNum(o.value))))),
          h('p', { class: 'muted small' }, 'Holders appear in the graph as dotted lines pointing to this issuer.'),
        ),
      );
    }
    const held = d.lines.filter((l) => l.balance > 0).sort((a, b) => b.balance - a.balance);
    const optedIn = d.lines.filter((l) => l.balance === 0 && l.limit > 0).length;
    if (held.length || optedIn) {
      out.push(
        this.section(
          'Tokens it holds',
          null,
          held.length
            ? h(
                'ul',
                { class: 'tok-list' },
                ...held.slice(0, 15).map((l) => h('li', null, h('span', { class: 'tok-cur' }, l.currency), h('span', { class: 'tok-val' }, fmtNum(l.balance)), h('span', { class: 'tok-iss' }, 'from ', this.chip(l.peer)))),
              )
            : null,
          optedIn ? h('p', { class: 'muted small' }, `Also opted in to ${optedIn} other token${optedIn > 1 ? 's' : ''} with a zero balance.`) : null,
        ),
      );
    }
    return out.length ? h('div', null, ...out) : null;
  }

  private dealsWith(d: AccountData) {
    return this.dealsWithItems(d.address, summarize(d), d.native);
  }

  private dealsWithItems(me: string, s: ReturnType<typeof summarize>, native: string) {
    const app = this.app;
    const d = { address: me };
    if (!s.counterparties.length) return null;
    const max = Math.max(...s.counterparties.map((c) => c.count));
    const rows = s.counterparties.slice(0, this.cpShown).map((c) => {
      const inGraph = app.model.nodes.has(c.address) && app.model.neighbors(c.address).includes(d.address);
      const parts: (string | HTMLElement)[] = [`${c.count} tx`, [...c.kinds].map((k) => EDGE_WORD[k]).join(', ')];
      if (c.xrpIn) parts.push(h('span', { class: 'flow-in', title: `${native} received from them` }, `↓ ${fmtNum(c.xrpIn)} ${native}`));
      if (c.xrpOut) parts.push(h('span', { class: 'flow-out', title: `${native} sent to them` }, `↑ ${fmtNum(c.xrpOut)} ${native}`));
      return h(
        'li',
        { class: 'cp' },
        h('div', { class: 'cp-main' }, this.chip(c.address), h('div', { class: 'cp-stats' }, ...parts.flatMap((p, i) => (i ? [' · ', p] : [p])))),
        inGraph
          ? h('span', { class: 'cp-in', title: 'Already on the map' }, icon('checkCircle', 14))
          : h('button', { class: 'icon-btn small', title: 'Add to the map', 'aria-label': 'Add to map', onclick: () => app.addCounterparty(d.address, c.address) }, icon('plus', 14)),
        h('div', { class: 'cp-bar', 'aria-hidden': 'true', title: `${c.count} of the loaded transactions` }, h('span', { style: { width: `${(c.count / max) * 100}%` } })),
      );
    });
    const more = s.counterparties.length - this.cpShown;
    return this.section(
      'Who it deals with',
      `${s.counterparties.length} ${s.counterparties.length === 1 ? 'account' : 'accounts'}`,
      h('p', { class: 'muted small' }, `From the latest ${s.txCount === 1 ? 'transaction' : `${s.txCount} transactions`}${s.from ? `, ${fmtDate(s.from)} to ${fmtDate(s.to)}` : ''}.`, s.xrpIn || s.xrpOut ? [` ${native} in: `, h('strong', null, fmtNum(s.xrpIn)), ' · out: ', h('strong', null, fmtNum(s.xrpOut))] : null),
      h('ul', { class: 'cps' }, ...rows),
      more > 0 ? h('button', { class: 'link small', onclick: () => ((this.cpShown += 20), this.render()) }, `Show ${Math.min(more, 20)} more`) : null,
      more > 0 || s.counterparties.length > app.settings.neighborLimit
        ? h('button', { class: 'link small', onclick: () => void app.expand(d.address, true) }, icon('network', 12), `Put all ${s.counterparties.length} on the map`)
        : null,
    );
  }

  private activity(id: string, d: AccountData | undefined, state?: string) {
    const app = this.app;
    if (!d) return this.section('Recent activity', null, state === 'error' ? null : this.skeleton(5));
    if (!d.txs.length) return this.section('Recent activity', null, h('p', { class: 'muted' }, 'No transactions found.'));
    const list = d.txs.slice(0, this.activityShown).map((t) => this.txRow(t, id));
    const moreLoaded = d.txs.length - this.activityShown;
    return this.section(
      'Recent activity',
      `${d.txs.length} loaded`,
      h('ul', { class: 'acts' }, ...list),
      h(
        'div',
        { class: 'row' },
        moreLoaded > 0 ? h('button', { class: 'btn small', onclick: () => ((this.activityShown += 40), this.render()) }, `Show ${Math.min(40, moreLoaded)} more`) : null,
        moreLoaded <= 0 && !d.txDone
          ? h(
              'button',
              {
                class: 'btn small',
                onclick: async (e: Event) => {
                  const b = e.currentTarget as HTMLButtonElement;
                  b.disabled = true;
                  b.textContent = 'Loading…';
                  this.activityShown += 40;
                  await app.loadMoreHistory(id);
                },
              },
              icon('history', 13),
              'Load older history',
            )
          : null,
      ),
      h('div', { class: 'explorers' }, 'Also on: ', ...EXPLORERS(id).flatMap((x, i) => [i ? ' · ' : '', h('a', { href: x.href, target: '_blank', rel: 'noopener' }, x.name)])),
    );
  }

  /** One transaction as a plain-English row (activity lists, cross-chain lists). */
  private txRow(t: ParsedTx, me: string): HTMLElement {
    const ds = describe(t, me);
    return h(
      'li',
      { class: `act ${ds.dir}${t.success ? '' : ' failed'}` },
      h('span', { class: 'act-ico', title: t.type }, icon(ds.icon, 14)),
      h(
        'div',
        { class: 'act-main' },
        h('div', { class: 'act-text' }, ...this.segs(ds.segs, me, t.hash)),
        h(
          'div',
          { class: 'act-meta' },
          h('time', { datetime: new Date(t.date).toISOString(), title: fmtDateTime(t.date) }, timeAgo(t.date)),
          ' · ',
          t.type,
          ' · ',
          h('a', { href: NETWORKS[t.net].explorer.tx(t.hash), target: '_blank', rel: 'noopener', title: 'Open the raw transaction in a block explorer' }, 'details', icon('external', 10)),
          ...this.proofLink(t.hash),
        ),
      ),
    );
  }

  /** For bridge door accounts: what the bridge is and what crossed through it. */
  private bridgeSection(id: string, items: { cross: CrossChain | null }[] | undefined, loaded: boolean, issues: boolean) {
    const b = doorOf(id);
    if (!b) return null;
    const groups = new Map<string, { dir: 'out' | 'in'; chain: string; node?: string; count: number; xrp: number; tokens: number }>();
    let housekeeping = 0;
    const here = NETWORKS[chainOf(id) as Network]?.name ?? 'this network';
    for (const t of items ?? []) {
      const c = t.cross;
      if (!c || c.bridge !== b.id) continue;
      if (c.direction === 'internal') {
        housekeeping++;
        continue;
      }
      const key = `${c.direction}:${c.chain}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { dir: c.direction, chain: c.chain, node: c.address ? undefined : c.node, count: 0, xrp: 0, tokens: 0 }));
      g.count++;
      if (c.amount?.isXrp) g.xrp += c.amount.value;
      else if (c.amount) g.tokens++;
    }
    const rows = [...groups.values()]
      .sort((x, y) => (x.dir === y.dir ? y.count - x.count : x.dir === 'out' ? -1 : 1))
      .map((g) =>
        h(
          'li',
          { class: 'xc-row' },
          h('span', { class: 'xc-dir', title: g.dir === 'out' ? `Leaving ${here}` : `Arriving on ${here}` }, icon(g.dir === 'out' ? 'out' : 'in', 14)),
          h('span', { class: 'xc-chain' }, g.dir === 'out' ? 'to ' : 'from ', g.node ? this.chip(g.node) : h('strong', null, chainName(g.chain))),
          h('span', { class: 'xc-stat' }, `${g.count} transfer${g.count > 1 ? 's' : ''}`, g.xrp ? ` · ${fmtNum(g.xrp)} XRP` : '', g.tokens ? ` · ${g.tokens} in tokens` : ''),
        ),
      );
    return this.section(
      'Bridge',
      b.name,
      h('p', { class: 'bridge-blurb' }, b.blurb),
      b.caution ? h('div', { class: 'banner warn' }, icon('alert', 16), h('div', null, h('p', { class: 'flush' }, b.caution))) : null,
      rows.length ? h('ul', { class: 'xc-list' }, ...rows) : null,
      loaded
        ? h(
            'p',
            { class: 'muted small' },
            rows.length
              ? 'From the loaded history. Transfers to connected networks are checked on the other side (see each one’s badge below).'
              : 'No readable cross-chain transfers in the loaded history. Bridge accounts often also trade or issue tokens, which can crowd out deposits.',
            housekeeping ? ` Plus ${housekeeping} internal move${housekeeping > 1 ? 's' : ''} between the bridge’s own accounts.` : '',
          )
        : null,
      issues ? h('p', { class: 'muted small' }, 'The tokens this account issues stand for assets held on other chains.') : null,
      h('a', { class: 'link small', href: b.url, target: '_blank', rel: 'noopener' }, new URL(b.url).hostname, icon('external', 11)),
    );
  }

  /** For regular accounts: transfers that left or entered the XRP Ledger. */
  private crossActivity(id: string, d: AccountData) {
    const list = d.txs.filter((t) => t.cross && t.cross.direction !== 'internal' && t.cross.local === id);
    if (!list.length) return null;
    return this.section(
      'Cross-chain activity',
      `${list.length} transfer${list.length > 1 ? 's' : ''}`,
      h('ul', { class: 'acts' }, ...list.slice(0, 8).map((t) => this.txRow(t, id))),
      list.length > 8 ? h('p', { class: 'muted small' }, `and ${list.length - 8} more in the activity below.`) : null,
    );
  }

  /** An address (or whole chain) outside the XRP Ledger: show what the XRP Ledger says about it. */
  private renderExternal(id: string) {
    const app = this.app;
    const { chain, address } = parseExt(id);
    const node = app.model.nodes.get(id);
    const records = [...(app.crossLog.get(id)?.values() ?? [])].sort((a, b) => b.date - a.date);
    const accounts = new Set(records.map((r) => r.cross.local));
    const bridges = new Set(records.map((r) => r.cross.bridge));
    let xrpTo = 0;
    let xrpFrom = 0;
    for (const r of records) {
      const c = r.cross!;
      if (!c.amount?.isXrp) continue;
      if (c.direction === 'out') xrpTo += c.amount.value;
      else xrpFrom += c.amount.value;
    }
    const explorer = address ? explorerFor(chain, address) : undefined;
    const scroll = this.body?.scrollTop ?? 0;
    clear(this.el);

    const copyBtn = h('button', { class: 'icon-btn', title: 'Copy address', 'aria-label': 'Copy address' }, icon('copy', 14));
    copyBtn.onclick = async () => {
      if (address && (await copyText(address))) app.toast('Address copied');
    };
    const head = h(
      'header',
      { class: 'ins-head' },
      h(
        'div',
        { class: 'ins-top' },
        h('div', { class: 'avatar' }, shapeGlyph('external', 26)),
        h(
          'div',
          { class: 'ins-title' },
          h('h2', null, address ? h('span', { class: 'mono' }, shortForeign(address)) : chainName(chain)),
          h('div', { class: 'kind', title: KIND_HINT.external }, shapeGlyph('external', 12), address ? `Address on ${chainName(chain)}` : 'Another blockchain'),
        ),
        h('button', { class: 'icon-btn close', title: 'Close (Esc)', 'aria-label': 'Close details', onclick: () => app.select(null) }, icon('x', 16)),
      ),
      address ? h('div', { class: 'addr-row' }, h('code', { class: 'addr', title: `Address on ${chainName(chain)}` }, address), copyBtn) : null,
      h(
        'div',
        { class: 'ins-actions' },
        explorer ? h('a', { class: 'btn primary', href: explorer.href, target: '_blank', rel: 'noopener' }, icon('external', 15), `Open on ${explorer.name}`) : null,
        h('button', { class: `icon-btn${node?.pinned ? ' on' : ''}`, onclick: () => (app.view.togglePin(id), this.render()), title: node?.pinned ? 'Unpin' : 'Pin in place', 'aria-label': 'Pin' }, icon('pin', 15)),
        h('button', { class: 'icon-btn', onclick: () => app.view.focusNode(id), title: 'Center on map', 'aria-label': 'Center' }, icon('crosshair', 15)),
      ),
    );

    const totals: (string | HTMLElement)[] = [];
    if (xrpTo) totals.push('Declared as sent here: ', h('strong', null, `${fmtNum(xrpTo)} XRP`));
    if (xrpFrom) totals.push(xrpTo ? ' · ' : '', 'declared as arriving from here: ', h('strong', null, `${fmtNum(xrpFrom)} XRP`));
    const body = h(
      'div',
      { class: 'ins-body' },
      h(
        'div',
        { class: 'banners' },
        h(
          'div',
          { class: 'banner info' },
          icon('globe', 16),
          h('div', null, h('strong', null, 'Outside the XRP Ledger'), h('p', null, `GraphXRP can’t read ${chain === 'evm' || chain.startsWith('via-') ? 'other chains' : chainName(chain)} yet. Everything below comes from XRP Ledger transactions that point here.`)),
        ),
      ),
      this.section(
        'What the XRP Ledger says',
        `${records.length} transfer${records.length === 1 ? '' : 's'}`,
        records.length
          ? h('p', { class: 'muted small' }, `${accounts.size} XRP Ledger account${accounts.size === 1 ? '' : 's'}, via ${[...bridges].map((b) => BRIDGES[b].name).join(', ')}. `, ...totals)
          : h('p', { class: 'muted' }, 'No transfers recorded yet.'),
        h('ul', { class: 'acts' }, ...records.slice(0, 40).map((r) => this.crossRow(r, id))),
      ),
      this.section(
        'How sure is this?',
        null,
        h(
          'ul',
          { class: 'traits' },
          h(
            'li',
            { class: 'trait info' },
            h('span', { class: 'trait-ico' }, icon('info', 15)),
            h('div', null, h('div', { class: 'trait-title' }, 'Declared'), h('p', null, 'The XRP Ledger transaction names this destination, written by the sender (or the bridge). That record is permanent and public.')),
          ),
          h(
            'li',
            { class: 'trait warn' },
            h('span', { class: 'trait-ico' }, icon('alert', 15)),
            h(
              'div',
              null,
              h('div', { class: 'trait-title' }, 'Not yet verified'),
              h('p', null, `Whether the funds actually arrived is recorded on ${chain === 'evm' || chain.startsWith('via-') ? 'the other chain' : chainName(chain)}, which isn’t connected yet.${explorer ? ' You can check it yourself with the button above.' : ''}`),
            ),
          ),
        ),
      ),
    );
    this.el.append(head, body);
    this.body = body;
    body.scrollTop = scroll;
  }

  /* ---------------------------- networks ---------------------------- */

  private netChip(chain: string): HTMLElement {
    const n = NETWORKS[chain as Network];
    return h('span', { class: 'net-chip', title: n?.blurb ?? '' }, n?.short ?? chainName(chain));
  }

  /** Xahau and the XRP Ledger share addresses: the same address means the same keys. */
  private twinNote(id: string): HTMLElement | null {
    const chain = chainOf(id);
    if (chain === 'xahau') {
      const raw = rawAddress(id);
      return h(
        'div',
        { class: 'twin' },
        icon('key', 13),
        h('div', null, 'Same address on the XRP Ledger: ', this.chip(raw), h('p', { class: 'muted small flush' }, 'Same address means the same master key, so it almost certainly has the same owner. Names above come from the XRP Ledger side.')),
      );
    }
    if (chain === 'xrpl') {
      const twin = extId('xahau', id);
      return h(
        'button',
        { class: 'link small', onclick: () => void this.app.explore(twin), title: 'Xahau uses the same addresses and keys. Look this address up there.' },
        icon('key', 12),
        this.app.model.nodes.has(twin) ? 'Show the same address on Xahau' : 'Look up the same address on Xahau',
      );
    }
    return null;
  }

  /** A cross-chain record from any network (used on pages for addresses on unconnected chains). */
  private crossRow(rec: CrossRecord, me: string): HTMLElement {
    if (rec.network !== 'xrpl-evm' && 'net' in rec.item) return this.txRow(rec.item as ParsedTx, me);
    return this.evmRow(rec.item as EvmEvent, me);
  }

  /* ------------------------- XRPL EVM Sidechain ------------------------ */

  private describeEvm(e: EvmEvent, me: string): Description {
    if (e.cross && e.success) return describeCrossing(e.cross, me);
    const amt: Seg = e.amount ? { amt: e.amount } : 'tokens';
    let d: Description;
    switch (e.kind) {
      case 'native':
      case 'token':
        d = e.from === me ? { icon: 'out', dir: 'out', segs: ['Sent ', amt, ' to ', { a: e.to }] } : e.to === me ? { icon: 'in', dir: 'in', segs: ['Received ', amt, ' from ', { a: e.from }] } : { icon: 'route', dir: 'neutral', segs: [{ a: e.from }, ' sent ', amt, ' to ', { a: e.to }] };
        break;
      case 'bridge-in':
        d = { icon: 'route', dir: 'in', segs: ['Received ', amt, ' delivered by Axelar from another chain'] };
        break;
      case 'mint':
        d = { icon: 'sparkle', dir: 'in', segs: ['Received ', amt, ' (newly created)'] };
        break;
      case 'burn':
        d = { icon: 'flame', dir: 'out', segs: ['Burned ', amt] };
        break;
      default:
        d = e.from === me
          ? { icon: 'activity', dir: 'neutral', segs: ['Called ', { a: e.to }, e.method ? ` (${e.method})` : ''] }
          : { icon: 'activity', dir: 'neutral', segs: [{ a: e.from }, ' called this contract', e.method ? ` (${e.method})` : ''] };
    }
    if (!e.success) d = { icon: 'x', dir: 'neutral', segs: ['Failed: ', ...d.segs] };
    return d;
  }

  private evmRow(e: EvmEvent, me: string): HTMLElement {
    const ds = this.describeEvm(e, me);
    return h(
      'li',
      { class: `act ${ds.dir}${e.success ? '' : ' failed'}` },
      h('span', { class: 'act-ico', title: e.method ?? e.kind }, icon(ds.icon, 14)),
      h(
        'div',
        { class: 'act-main' },
        h('div', { class: 'act-text' }, ...this.segs(ds.segs, me, e.hash)),
        h(
          'div',
          { class: 'act-meta' },
          h('time', { datetime: new Date(e.date).toISOString(), title: fmtDateTime(e.date) }, timeAgo(e.date)),
          e.method ? [' · ', e.method] : '',
          ' · ',
          h('a', { href: NETWORKS['xrpl-evm'].explorer.tx(e.hash), target: '_blank', rel: 'noopener', title: 'Open the transaction on the XRPL EVM explorer' }, 'details', icon('external', 10)),
          ...this.proofLink(e.hash),
        ),
      ),
    );
  }

  private renderEvm(id: string) {
    const app = this.app;
    const ident = app.dir.get(id);
    const acc: EvmAccount | undefined = app.evm.loaded.get(id);
    const info = acc ?? app.evm.probed.get(id);
    const node = app.model.nodes.get(id);
    const kind: NodeKind = node?.kind ?? app.classify(id);
    const scroll = this.body?.scrollTop ?? 0;
    const raw = rawAddress(id);
    clear(this.el);

    const copyBtn = h('button', { class: 'icon-btn', title: 'Copy address', 'aria-label': 'Copy address' }, icon('copy', 14));
    copyBtn.onclick = async () => {
      if (await copyText(raw)) app.toast('Address copied');
    };
    const expanded = !!node?.expanded;
    const head = h(
      'header',
      { class: 'ins-head' },
      h(
        'div',
        { class: 'ins-top' },
        identicon(id),
        h(
          'div',
          { class: 'ins-title' },
          h('h2', null, ident.name ? h('span', null, ident.name) : h('span', { class: 'unnamed mono' }, shortForeign(raw))),
          h('div', { class: 'kind', title: KIND_HINT[kind] }, shapeGlyph(kind, 12), KIND_LABEL[kind], this.netChip('xrpl-evm'), node?.state === 'loading' ? h('span', { class: 'spinner', 'aria-label': 'Loading' }) : null),
        ),
        h('button', { class: 'icon-btn close', title: 'Close (Esc)', 'aria-label': 'Close details', onclick: () => app.select(null) }, icon('x', 16)),
      ),
      h('div', { class: 'addr-row' }, h('code', { class: 'addr', title: 'Address on the XRPL EVM Sidechain' }, raw), copyBtn),
      h(
        'div',
        { class: 'ins-actions' },
        h('button', { class: 'btn primary', onclick: () => (expanded ? app.collapse(id) : void app.expand(id)) }, icon('network', 15), expanded ? 'Collapse' : 'Show connections'),
        h('a', { class: 'btn', href: NETWORKS['xrpl-evm'].explorer.account(raw), target: '_blank', rel: 'noopener' }, icon('external', 15), 'Explorer'),
        h('button', { class: `icon-btn${node?.pinned ? ' on' : ''}`, onclick: () => (app.view.togglePin(id), this.render()), title: node?.pinned ? 'Unpin' : 'Pin in place', 'aria-label': 'Pin' }, icon('pin', 15)),
        h('button', { class: 'icon-btn', onclick: () => app.view.focusNode(id), title: 'Center on map', 'aria-label': 'Center' }, icon('crosshair', 15)),
      ),
    );

    // At a glance
    const stats: HTMLElement[] = [];
    const stat = (label: string, value: Node | string, sub?: Node | string | null) =>
      stats.push(h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub' }, sub) : null));
    if (info) {
      if (!info.exists) stat('Status', 'Never used', 'This address has no activity on the XRPL EVM Sidechain');
      else {
        stat('XRP balance', fmtXrp(info.balance), 'XRP pays the fees on this chain');
        stat('Type', info.token ? `${info.token.type} token` : info.isContract ? 'Smart contract' : 'Regular address', info.isContract ? (info.verified ? 'Source code published' : 'Source code not published') : 'Controlled by a private key');
        if (info.token) stat('Token', `${info.token.symbol}`, [info.token.holders != null ? `${fmtNum(info.token.holders)} holders` : '', info.token.supply != null ? ` · supply ${fmtNum(info.token.supply)}` : ''].join(''));
      }
    }
    const glance = this.section('At a glance', null, info ? h('div', { class: 'stats' }, ...stats) : node?.state === 'error' ? h('p', { class: 'muted' }, 'Not available.') : this.skeleton(3));

    // Who is this?
    const claims = ident.claims.map((c) =>
      h('li', { class: 'claim' }, h('span', { class: 'claim-ico' }, icon(c.source === 'Your label' ? 'tag' : 'user', 15)), h('div', null, h('div', { class: 'claim-text' }, c.text), h('div', { class: 'claim-src' }, c.source))),
    );
    const who = this.section(
      'Who is this?',
      null,
      claims.length ? h('ul', { class: 'claims' }, ...claims) : h('p', { class: 'muted' }, 'No public name. Most addresses on this chain are anonymous, and contracts only get names when their authors publish the source code.'),
      ident.userNote ? h('p', { class: 'user-note' }, icon('tag', 13), ident.userNote) : null,
      this.editingLabel ? this.labelForm(id, ident) : h('button', { class: 'link small', onclick: () => ((this.editingLabel = true), this.render()) }, icon('tag', 13), ident.userLabel ? 'Edit your private label' : 'Add your own private label'),
    );

    const events = acc?.events ?? [];
    const crosses = events.filter((e) => e.cross && e.cross.direction !== 'internal' && (e.cross.local === id || doorOf(id)));
    const holdings = acc?.holdings ?? [];
    const body = h(
      'div',
      { class: 'ins-body' },
      node?.state === 'error' && !acc
        ? h('div', { class: 'banners' }, h('div', { class: 'banner warn' }, icon('alert', 16), h('div', null, h('strong', null, 'Couldn’t load this address'), h('p', null, 'The XRPL EVM explorer didn’t answer. ', h('button', { class: 'link', onclick: () => void app.loadEvm(id).catch(() => {}) }, 'Try again')))))
        : null,
      this.bridgeSection(id, events, !!acc, false),
      who,
      glance,
      crosses.length ? this.section('Cross-chain activity', `${crosses.length} transfer${crosses.length > 1 ? 's' : ''}`, h('ul', { class: 'acts' }, ...crosses.slice(0, 8).map((e) => this.evmRow(e, id)))) : null,
      holdings.length
        ? this.section(
            'Tokens it holds',
            null,
            h('ul', { class: 'tok-list' }, ...holdings.slice(0, 15).map((x) => h('li', null, h('span', { class: 'tok-cur' }, x.token.symbol), h('span', { class: 'tok-val' }, fmtNum(x.value)), h('span', { class: 'tok-iss' }, this.chip(`ext:xrpl-evm:${x.token.address}`))))),
          )
        : null,
      acc ? this.dealsWithItems(id, summarizeFlows(id, events as { date: number; flows: Flow[] }[]), 'XRP') : null,
      acc
        ? this.section(
            'Recent activity',
            `${events.length} loaded`,
            events.length ? h('ul', { class: 'acts' }, ...events.slice(0, this.activityShown).map((e) => this.evmRow(e, id))) : h('p', { class: 'muted' }, 'No activity found.'),
            h(
              'div',
              { class: 'row' },
              events.length > this.activityShown ? h('button', { class: 'btn small', onclick: () => ((this.activityShown += 40), this.render()) }, 'Show more') : null,
              events.length <= this.activityShown && !acc.done
                ? h('button', { class: 'btn small', onclick: async (ev: Event) => ((ev.currentTarget as HTMLButtonElement).disabled = true, (this.activityShown += 40), await app.loadMoreHistory(id)) }, icon('history', 13), 'Load older history')
                : null,
            ),
          )
        : this.section('Recent activity', null, this.skeleton(5)),
      h('footer', { class: 'ins-foot' }, icon('info', 13), h('p', null, 'Data comes from the XRPL EVM Sidechain’s public explorer (Blockscout). Names come from the explorer and can be wrong; most contracts are unnamed.')),
    );
    this.el.append(head, body);
    this.body = body;
    body.scrollTop = scroll;
  }
}

function isBlackholeAddr(a: string) {
  return a === 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' || a === 'rrrrrrrrrrrrrrrrrrrrBZbvji' || a === 'rrrrrrrrrrrrrrrrrrrn5RM1rHd';
}

/** Deterministic, monochrome 5×5 avatar so each address is recognizable at a glance. */
export function identicon(addr: string, size = 40): HTMLElement {
  let hsh = 2166136261;
  for (let i = 0; i < addr.length; i++) hsh = Math.imul(hsh ^ addr.charCodeAt(i), 16777619) >>> 0;
  const cells: string[] = [];
  let bits = hsh;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const on = bits & 1;
      bits = bits >>> 1 || Math.imul(hsh, 2654435761) >>> 0;
      if (!on) continue;
      cells.push(`<rect x="${x * 4 + 2}" y="${y * 4 + 2}" width="4" height="4"/>`);
      if (x < 2) cells.push(`<rect x="${(4 - x) * 4 + 2}" y="${y * 4 + 2}" width="4" height="4"/>`);
    }
  }
  const el = document.createElement('div');
  el.className = 'avatar identicon';
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="currentColor">${cells.join('')}</svg>`;
  return el;
}
