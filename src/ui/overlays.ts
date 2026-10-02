/** Tooltip, context menu, toasts, welcome card and help dialog. */
import type { App } from '../app';
import { KIND_LABEL } from '../app';
import { h, clear, copyText } from './dom';
import { icon, shapeGlyph, lineGlyph } from './icons';
import { EDGE_HINT, EDGE_LABEL } from './panels';
import { fmtNum, fmtXrp, fmtDate, shortAddr } from '../xrpl/amount';
import type { GEdge, GNode, Leg } from '../graph/model';
import { chainName, explorerFor, isExternal, parseExt } from '../bridges/registry';

/* ------------------------------- tooltip ------------------------------- */

export function buildTooltip(app: App): HTMLElement {
  const el = h('div', { class: 'tooltip panel', role: 'tooltip' });
  app.onHover = (target, x, y) => {
    if (!target) {
      el.classList.remove('show');
      return;
    }
    clear(el);
    if (target.node) el.append(...nodeTip(app, target.node));
    else if (target.edge) el.append(...edgeTip(app, target.edge));
    el.classList.add('show');
    const r = el.getBoundingClientRect();
    let left = x + 16;
    let top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 16;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  };
  return el;
}

function nodeTip(app: App, n: GNode): Node[] {
  if (isExternal(n.id)) {
    const { chain, address } = parseExt(n.id);
    const count = app.crossLog.get(n.id)?.size ?? 0;
    return [
      h('div', { class: 'tt-title' }, app.dir.label(n.id)),
      h('div', { class: 'tt-kind' }, shapeGlyph('external', 11), address ? `Address on ${chainName(chain)}` : 'Another blockchain'),
      address ? h('div', { class: 'tt-addr' }, address) : null,
      h('div', { class: 'tt-facts' }, `Named in ${count} XRP Ledger transaction${count === 1 ? '' : 's'}`),
      h('div', { class: 'tt-hint' }, 'Click to see what the XRP Ledger says about it'),
    ].filter((x): x is HTMLDivElement => !!x);
  }
  const ident = app.dir.get(n.id);
  const out: Node[] = [
    h('div', { class: 'tt-title' }, ident.name ? app.dir.label(n.id) : shortAddr(n.id), ident.claims.some((c) => c.verified) ? h('span', { class: 'verified' }, icon('checkCircle', 12)) : null),
    h('div', { class: 'tt-kind' }, shapeGlyph(n.kind, 11), KIND_LABEL[n.kind]),
  ];
  if (ident.name) out.push(h('div', { class: 'tt-addr' }, n.id));
  const facts: string[] = [];
  if (n.balance != null) facts.push(fmtXrp(n.balance));
  facts.push(`${n.degree} link${n.degree === 1 ? '' : 's'} on map`);
  out.push(h('div', { class: 'tt-facts' }, facts.join(' · ')));
  const hint = n.state === 'stub' ? 'Click to look it up · double-click to expand' : n.expanded ? 'Click for details' : 'Click for details · double-click to expand';
  out.push(h('div', { class: 'tt-hint' }, hint));
  return out;
}

function legText(app: App, e: GEdge, from: string, to: string, leg: Leg): Node | null {
  if (!leg.count) return null;
  const A = app.dir.label(from);
  const B = app.dir.label(to);
  const totals = [...leg.totals.values()].sort((a, b) => (a.isXrp ? -1 : b.isXrp ? 1 : b.value - a.value));
  const amounts = totals
    .slice(0, 3)
    .map((t) => `${fmtNum(t.value)} ${t.currency}`)
    .join(', ');
  const more = totals.length > 3 ? ` +${totals.length - 3} more` : '';
  let text: string;
  switch (e.type) {
    case 'payment':
      text = `${A} → ${B}: ${leg.count} transfer${leg.count > 1 ? 's' : ''}${amounts ? ` · ${amounts}${more}` : ''}`;
      break;
    case 'activation':
      text = `${A} created ${B}${amounts ? ` by sending ${amounts}` : ''}`;
      break;
    case 'trust':
      text = totals.length ? `${A} holds ${totals.map((t) => `${fmtNum(t.value)} ${t.currency}`).slice(0, 3).join(', ')}${more} issued by ${B}` : `${A} trusts tokens from ${B}`;
      break;
    case 'control':
      text = `${A} can sign for ${B}${e.role ? ` (${e.role})` : ''}`;
      break;
    case 'crosschain':
      text = `${A} \u2192 ${B}: ${leg.count} cross-chain transfer${leg.count > 1 ? 's' : ''}${amounts ? ` \u00b7 ${amounts}${more}` : ''} (declared)`;
      break;
    default:
      text = `${A} ↔ ${B}: traded ${leg.count} time${leg.count > 1 ? 's' : ''}`;
  }
  return h('div', { class: 'tt-leg' }, text, leg.last ? h('span', { class: 'tt-date' }, ` · last ${fmtDate(leg.last)}`) : null);
}

function edgeTip(app: App, e: GEdge): Node[] {
  return [
    h('div', { class: 'tt-title' }, lineGlyph(e.type, 18), EDGE_LABEL[e.type]),
    legText(app, e, e.a, e.b, e.ab),
    legText(app, e, e.b, e.a, e.ba),
    h('div', { class: 'tt-hint' }, EDGE_HINT[e.type]),
  ].filter((x): x is HTMLElement => !!x);
}

/* ----------------------------- context menu ---------------------------- */

export function buildContextMenu(app: App, openHelp: () => void): HTMLElement {
  const el = h('div', { class: 'ctx panel', role: 'menu' });
  const close = () => el.classList.remove('show');
  document.addEventListener('pointerdown', (e) => !el.contains(e.target as Node) && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  window.addEventListener('blur', close);

  const item = (ic: string, label: string, run: () => void, extra = '') =>
    h(
      'button',
      {
        class: `ctx-item ${extra}`,
        role: 'menuitem',
        onclick: () => {
          close();
          run();
        },
      },
      icon(ic, 14),
      label,
    );

  app.onContext = (id, x, y) => {
    clear(el);
    if (id && isExternal(id)) {
      const { chain, address } = parseExt(id);
      const n = app.model.nodes.get(id)!;
      const ex = address ? explorerFor(chain, address) : undefined;
      el.append(
        h('div', { class: 'ctx-title' }, app.dir.label(id)),
        item('info', 'Open details', () => app.select(id)),
        item('crosshair', 'Center here', () => app.view.focusNode(id)),
        item('pin', n.pinned ? 'Unpin' : 'Pin in place', () => app.view.togglePin(id)),
        item('eyeoff', 'Hide', () => app.hide(id)),
        address ? h('div', { class: 'ctx-sep' }) : '',
        address ? item('copy', 'Copy address', async () => (await copyText(address)) && app.toast('Address copied')) : '',
        ex ? item('external', `Open on ${ex.name}`, () => window.open(ex.href, '_blank', 'noopener')) : '',
      );
    } else if (id) {
      const n = app.model.nodes.get(id)!;
      el.append(
        h('div', { class: 'ctx-title' }, app.dir.label(id)),
        item('info', 'Open details', () => app.select(id)),
        item('network', n.expanded ? 'Collapse connections' : 'Show connections', () => (n.expanded ? app.collapse(id) : void app.expand(id))),
        item('sprout', 'Trace origin', () => {
          app.select(id);
          void app.traceOrigin(id);
        }),
        item('route', 'Follow the money', () => {
          app.select(id);
          void app.traceFunding(id);
        }),
        h('div', { class: 'ctx-sep' }),
        item('crosshair', 'Center here', () => app.view.focusNode(id)),
        item('pin', n.pinned ? 'Unpin' : 'Pin in place', () => app.view.togglePin(id)),
        item('eyeoff', 'Hide', () => app.hide(id)),
        h('div', { class: 'ctx-sep' }),
        item('copy', 'Copy address', async () => (await copyText(id)) && app.toast('Address copied')),
        item('external', 'Open in XRPScan', () => window.open(`https://xrpscan.com/account/${id}`, '_blank', 'noopener')),
      );
    } else {
      el.append(
        item('fit', 'Fit everything', () => app.view.fit()),
        app.view.trail ? item('x', 'Clear highlighted trail', () => app.clearTrail()) : '',
        app.hiddenCount() ? item('eyeoff', `Show ${app.hiddenCount()} hidden`, () => app.unhideAll()) : '',
        item('help', 'How to read this map', openHelp),
      );
    }
    el.classList.add('show');
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    el.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  };
  return el;
}

/* -------------------------------- toasts ------------------------------- */

export function buildToasts(app: App): HTMLElement {
  const el = h('div', { class: 'toasts', 'aria-live': 'polite' });
  app.on('toast', ({ text, tone }) => {
    const t = h('div', { class: `toast panel ${tone ?? 'info'}` }, icon(tone === 'error' ? 'alert' : 'info', 14), text);
    el.append(t);
    setTimeout(() => t.classList.add('out'), tone === 'error' ? 5000 : 2600);
    setTimeout(() => t.remove(), tone === 'error' ? 5400 : 3000);
  });
  return el;
}

/* ---------------------------- welcome & help --------------------------- */

const STARTERS: { label: string; note: string; addr: string; kind: string }[] = [
  { label: 'Ripple USD (RLUSD)', note: 'stablecoin issuer', addr: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', kind: 'issuer' },
  { label: 'Binance', note: 'exchange wallet', addr: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', kind: 'exchange' },
  { label: 'XRP / RLUSD pool', note: 'AMM pool', addr: 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3', kind: 'amm' },
  { label: 'Sologenic (SOLO)', note: 'blackholed issuer', addr: 'rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz', kind: 'issuer' },
  { label: 'Axelar bridge', note: 'to XRPL EVM & Ethereum', addr: 'rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw', kind: 'bridge' },
  { label: 'Genesis account', note: 'where XRP began', addr: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', kind: 'wallet' },
];

export function buildWelcome(app: App, openHelp: () => void): HTMLElement {
  const el = h(
    'div',
    { class: 'welcome' },
    h(
      'div',
      { class: 'welcome-card panel' },
      h('h1', null, 'See who’s who on the XRP Ledger'),
      h(
        'p',
        { class: 'lead' },
        'The XRP Ledger is a public record: every account and every payment is open for anyone to read. This map lets you walk through it, one account at a time.',
      ),
      h(
        'ul',
        { class: 'welcome-points' },
        h('li', null, shapeGlyph('wallet', 14), h('span', null, h('strong', null, 'Shapes are accounts. '), 'Squares are exchanges, diamonds issue tokens, hexagons are trading pools.')),
        h('li', null, lineGlyph('payment', 22), h('span', null, h('strong', null, 'Lines are relationships. '), 'Money sent, tokens held, and who created whom.')),
        h('li', null, icon('shield', 14), h('span', null, h('strong', null, 'Names show their source. '), 'You can check where every name came from.')),
      ),
      h('div', { class: 'welcome-label' }, 'Start with a well-known account, or search above'),
      h(
        'div',
        { class: 'starters' },
        ...STARTERS.map((s) =>
          h(
            'button',
            { class: 'starter', onclick: () => void app.explore(s.addr) },
            shapeGlyph(s.kind, 12),
            h('span', { class: 'st-label' }, s.label),
            h('span', { class: 'st-note' }, s.note),
          ),
        ),
      ),
      h('p', { class: 'welcome-foot' }, 'Click to inspect · double-click to expand · drag to move · scroll to zoom · ', h('button', { class: 'link', onclick: openHelp }, 'full guide')),
    ),
  );
  const sync = () => el.classList.toggle('hidden', app.model.nodes.size > 0);
  app.on('graph', sync);
  app.on('select', sync);
  return el;
}

export function buildHelp(): { el: HTMLElement; open: () => void } {
  const dlg = h('dialog', { class: 'help panel', 'aria-label': 'How to read this map' }) as HTMLDialogElement;
  const kinds: [string, string, string][] = [
    ['exchange', 'Exchange or service', 'Holds funds for many customers. You’ll often see a “destination tag” on payments to them.'],
    ['issuer', 'Token issuer', 'Creates tokens such as stablecoins. Holding its token means trusting it to honor it.'],
    ['amm', 'AMM pool', 'A robot account that trades two assets by formula. Nobody controls it.'],
    ['wallet', 'Wallet', 'Any other account. Usually an individual.'],
    ['flagged', 'Flagged', 'A public directory reported it (scam, hack, spam). Labels marked with ⚠.'],
    ['inactive', 'Inactive', 'No account exists there now: deleted, or never funded.'],
    ['bridge', 'Bridge door', 'Run by a cross-chain bridge. Funds sent here leave the XRP Ledger for another blockchain.'],
    ['external', 'On another chain', 'An address on a different blockchain, named in an XRP Ledger transaction. Shown as an outline because it can\u2019t be opened here yet.'],
  ];
  const edges: [string, string][] = [
    ['payment', 'Payments. Dots travel in the direction the money went; thicker = more transfers.'],
    ['activation', 'Account creation. New accounts need XRP from an existing one: this is its “parent”.'],
    ['trust', 'Token holding. Points from a holder to the issuer whose token it holds.'],
    ['dex', 'Trading. The two traded on the built-in exchange or with an AMM pool.'],
    ['control', 'Control. One account holds a key that can sign for the other.'],
    ['crosschain', 'Crossed chains. Funds headed to (or arriving from) another blockchain, as declared in the transaction.'],
  ];
  dlg.append(
    h(
      'div',
      { class: 'help-inner' },
      h('div', { class: 'help-head' }, h('h2', null, 'How to read this map'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 16))),
      h(
        'div',
        { class: 'help-cols' },
        h(
          'section',
          null,
          h('h3', null, 'Accounts'),
          h('ul', { class: 'help-list' }, ...kinds.map(([k, t, d]) => h('li', null, shapeGlyph(k, 16), h('div', null, h('strong', null, t), h('p', null, d))))),
          h('p', { class: 'muted small' }, 'A ring around a shape means someone publicly named it. Faded shapes haven’t been opened yet: click one to look it up.'),
        ),
        h(
          'section',
          null,
          h('h3', null, 'Lines'),
          h('ul', { class: 'help-list' }, ...edges.map(([t, d]) => h('li', null, lineGlyph(t, 26), h('p', null, d)))),
          h('h3', null, 'Getting around'),
          h(
            'ul',
            { class: 'help-keys' },
            h('li', null, h('kbd', null, 'Click'), 'Open an account’s details'),
            h('li', null, h('kbd', null, 'Double-click'), 'Show its connections'),
            h('li', null, h('kbd', null, 'Hover'), 'Light up its neighborhood'),
            h('li', null, h('kbd', null, 'Drag'), 'Move accounts or pan the map'),
            h('li', null, h('kbd', null, 'Right-click'), 'More actions'),
            h('li', null, h('kbd', null, '/'), 'Search'),
            h('li', null, h('kbd', null, 'F'), 'Fit to screen'),
            h('li', null, h('kbd', null, 'E'), 'Expand the selected account'),
            h('li', null, h('kbd', null, 'T'), 'Trace where it came from'),
            h('li', null, h('kbd', null, 'Alt ← / →'), 'Back and forward'),
          ),
        ),
      ),
      h(
        'section',
        { class: 'help-sources' },
        h('h3', null, 'Where the information comes from'),
        h(
          'p',
          null,
          'Balances, settings and history are read live from public XRP Ledger servers. Nobody can edit them. Names come from public directories (XRPScan, Xaman, Bithomp) and from the website an account names for itself. A website counts as confirmed only when it lists the account back in its official ',
          h('code', null, 'xrp-ledger.toml'),
          ' file.',
        ),
        h('p', null, 'Your browser talks to those services directly. Labels and notes you add stay in this browser.'),
      ),
    ),
  );
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  return { el: dlg, open: () => dlg.showModal() };
}
