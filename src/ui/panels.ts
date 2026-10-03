/** Legend (doubles as filter), Obsidian-style graph settings, and zoom controls. */
import type { App } from '../app';
import { KIND_LABEL, KIND_HINT } from '../app';
import { h, clear } from './dom';
import { icon, shapeGlyph, lineGlyph } from './icons';
import { edgeCurrencies } from '../graph/view';
import { DEFAULTS, type Settings } from '../settings';
import { NETWORKS, isNetwork } from '../chains/chains';
import { chainName } from '../bridges/registry';
import type { NodeKind } from '../graph/model';
import type { EdgeType } from '../xrpl/parse';

export const EDGE_LABEL: Record<EdgeType, string> = {
  payment: 'Payments',
  activation: 'Created the account',
  trust: 'Holds tokens from',
  dex: 'Traded with (DEX / AMM)',
  control: 'Can sign for',
  crosschain: 'Crossed to another chain',
  contract: 'Used a smart contract',
};

export const EDGE_HINT: Record<EdgeType, string> = {
  payment: 'Money moved between the two. Moving dots show the direction.',
  activation: 'The first account sent the XRP that brought the second one to life.',
  trust: 'The holder opted in to hold a token created by the issuer (arrow points at the issuer).',
  dex: 'Their orders matched on the built-in exchange, or one traded with an AMM pool.',
  control: 'The first account holds a key that can sign transactions for the second.',
  crosschain: 'Funds moving to (or from) another network, usually through a bridge. Dashed: declared in the transaction. Solid: confirmed on the other network. It\u2019s declared in the XRP Ledger transaction; arrival on the other chain isn\u2019t verified here.',
  contract: 'One account called a program (smart contract) on the XRPL EVM Sidechain, for example a token or a bridge.',
};

const KINDS: NodeKind[] = ['exchange', 'issuer', 'amm', 'bridge', 'contract', 'wallet', 'external', 'flagged', 'inactive'];
const EDGES: EdgeType[] = ['payment', 'activation', 'trust', 'dex', 'control', 'crosschain', 'contract'];
/** Shown in the legend only once something of that kind is on the map. */
const OPTIONAL_KINDS = new Set<NodeKind>(['contract', 'external', 'flagged', 'inactive']);
const OPTIONAL_EDGES = new Set<EdgeType>(['contract']);

export function buildLegend(app: App, toggleSettings: () => void): HTMLElement {
  const el = h('div', { class: 'legend panel', role: 'region', 'aria-label': 'Legend and filters' });
  let collapsed = window.innerWidth < 760;
  const render = () => {
    clear(el);
    const counts = new Map<string, number>();
    for (const n of app.model.nodes.values()) if (!n.hidden) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    const ncounts = new Map<string, number>();
    for (const n of app.model.nodes.values()) if (!n.hidden) ncounts.set(n.chain, (ncounts.get(n.chain) ?? 0) + 1);
    const ecounts = new Map<string, number>();
    for (const e of app.model.edges.values()) ecounts.set(e.type, (ecounts.get(e.type) ?? 0) + 1);

    const head = h(
      'div',
      { class: 'legend-head' },
      h('button', { class: 'legend-toggle', 'aria-expanded': String(!collapsed), onclick: () => ((collapsed = !collapsed), render()) }, icon(collapsed ? 'right' : 'left', 13), 'Legend'),
      h('button', { class: 'icon-btn small', title: 'Graph settings', 'aria-label': 'Graph settings', onclick: toggleSettings }, icon('settings', 15)),
    );
    el.append(head);
    if (collapsed) return;

    const kindRows = KINDS.filter((k) => !OPTIONAL_KINDS.has(k) || (counts.get(k) ?? 0) > 0).map((k) => {
      const on = app.settings.kinds[k];
      return h(
        'button',
        {
          class: `legend-row${on ? '' : ' off'}`,
          title: `${KIND_HINT[k]}\nClick to ${on ? 'hide' : 'show'}.`,
          'aria-pressed': String(on),
          onclick: () => app.updateSettings({ kinds: { ...app.settings.kinds, [k]: !on } }, { refresh: true }),
        },
        shapeGlyph(k, 14),
        h('span', { class: 'lg-label' }, KIND_LABEL[k]),
        h('span', { class: 'lg-count' }, String(counts.get(k) ?? 0)),
      );
    });
    const edgeRows = EDGES.filter((t) => !OPTIONAL_EDGES.has(t) || (ecounts.get(t) ?? 0) > 0).map((t) => {
      const on = app.settings.edgeTypes[t];
      return h(
        'button',
        {
          class: `legend-row${on ? '' : ' off'}`,
          title: `${EDGE_HINT[t]}\nClick to ${on ? 'hide' : 'show'}.`,
          'aria-pressed': String(on),
          onclick: () => app.updateSettings({ edgeTypes: { ...app.settings.edgeTypes, [t]: !on } }, { refresh: true }),
        },
        lineGlyph(t, 22),
        h('span', { class: 'lg-label' }, EDGE_LABEL[t]),
        h('span', { class: 'lg-count' }, String(ecounts.get(t) ?? 0)),
      );
    });
    const netRows =
      ncounts.size > 1
        ? [...ncounts.entries()]
            .sort((a, b) => (a[0] === 'xrpl' ? -1 : b[0] === 'xrpl' ? 1 : (isNetwork(b[0]) ? 1 : 0) - (isNetwork(a[0]) ? 1 : 0) || b[1] - a[1]))
            .map(([chain, count]) => {
              const on = app.settings.chains[chain] !== false;
              const name = isNetwork(chain) ? NETWORKS[chain].name : chainName(chain);
              return h(
                'button',
                {
                  class: `legend-row${on ? '' : ' off'}`,
                  title: `${isNetwork(chain) ? NETWORKS[chain].blurb : 'Not connected: only XRP Ledger transactions that point here are known.'}\nClick to ${on ? 'hide' : 'show'}.`,
                  'aria-pressed': String(on),
                  onclick: () => app.updateSettings({ chains: { ...app.settings.chains, [chain]: !on } }, { refresh: true }),
                },
                h('span', { class: `net-dot${isNetwork(chain) ? '' : ' off-net'}`, 'aria-hidden': 'true' }),
                h('span', { class: 'lg-label' }, name),
                h('span', { class: 'lg-count' }, String(count)),
              );
            })
        : [];
    el.append(
      netRows.length ? h('div', { class: 'legend-group' }, h('div', { class: 'lg-title' }, 'Networks'), ...netRows) : '',
      h('div', { class: 'legend-group' }, h('div', { class: 'lg-title' }, 'Accounts'), ...kindRows),
      h('div', { class: 'legend-group' }, h('div', { class: 'lg-title' }, 'Lines'), ...edgeRows),
      h(
        'div',
        { class: 'legend-note' },
        h('span', { class: 'ring-sample', 'aria-hidden': 'true' }),
        'Ring = publicly named. Faded = not opened yet.',
      ),
    );
  };
  app.on('graph', render);
  app.on('settings', render);
  render();
  return el;
}

export function buildSettings(app: App): { el: HTMLElement; toggle: () => void } {
  const el = h('div', { class: 'settings panel', role: 'dialog', 'aria-label': 'Graph settings' });
  let open = false;
  const toggle = () => {
    open = !open;
    el.classList.toggle('open', open);
    if (open) {
      render();
      app.emit('panel', 'settings');
    }
  };
  app.on('panel', (p) => p !== 'settings' && open && toggle());

  const slider = (label: string, key: keyof Settings, min: number, max: number, step: number, opts: { forces?: boolean; refresh?: boolean; hint?: string } = {}) => {
    const val = h('span', { class: 'sl-val' }, String(app.settings[key]));
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(app.settings[key]), 'aria-label': label });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = String(v);
      app.updateSettings({ [key]: v } as Partial<Settings>, opts);
    });
    return h('label', { class: 'set-row slider', title: opts.hint ?? '' }, h('span', { class: 'set-label' }, label, val), input);
  };
  const toggleRow = (label: string, key: keyof Settings, opts: { refresh?: boolean; hint?: string } = {}) => {
    const input = h('input', { type: 'checkbox', checked: !!app.settings[key] });
    input.addEventListener('change', () => app.updateSettings({ [key]: input.checked } as Partial<Settings>, opts));
    return h('label', { class: 'set-row toggle', title: opts.hint ?? '' }, h('span', { class: 'set-label' }, label), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
  };
  const group = (title: string, ...rows: (Node | null)[]) => h('details', { class: 'set-group', open: true }, h('summary', null, title), ...rows);

  const render = () => {
    clear(el);
    const filter = h('input', { type: 'search', class: 'set-input', placeholder: 'Highlight accounts by name…', value: (el.dataset.filter ?? ''), 'aria-label': 'Highlight accounts by name' });
    filter.addEventListener('input', () => {
      el.dataset.filter = filter.value;
      const q = filter.value.trim().toLowerCase();
      if (!q) app.view.matches = null;
      else {
        const m = new Set<string>();
        for (const n of app.model.nodes.values()) if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) m.add(n.id);
        app.view.matches = m;
      }
      app.view.invalidate();
    });

    const currencies = new Set<string>();
    for (const e of app.model.edges.values()) for (const c of edgeCurrencies(e)) currencies.add(c);
    const cur = h(
      'select',
      { class: 'set-input', 'aria-label': 'Only show one currency' },
      h('option', { value: '' }, 'All currencies'),
      ...[...currencies].sort((a, b) => (a === 'XRP' ? -1 : b === 'XRP' ? 1 : a.localeCompare(b))).map((c) => h('option', { value: c }, c)),
    );
    cur.value = app.settings.currency;
    cur.addEventListener('change', () => app.updateSettings({ currency: cur.value }, { refresh: true }));

    const hidden = app.hiddenCount();
    const server = h('input', { type: 'url', class: 'set-input', placeholder: 'wss://… (blank = public servers)', value: app.settings.server, 'aria-label': 'Ledger server' });
    server.addEventListener('change', () => {
      const v = server.value.trim();
      if (v && !/^wss?:\/\//.test(v)) {
        app.toast('Server address must start with wss://', 'error');
        return;
      }
      app.updateSettings({ server: v });
      app.toast(v ? `Switched to ${v}` : 'Using public servers');
    });

    el.append(
      h('div', { class: 'set-head' }, h('strong', null, 'Graph settings'), h('button', { class: 'icon-btn small', 'aria-label': 'Close settings', onclick: toggle }, icon('x', 14))),
      h(
        'div',
        { class: 'set-body' },
        group(
          'Filters',
          h('div', { class: 'set-row' }, filter),
          h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Currency'), cur),
          toggleRow('Unopened accounts', 'showStubs', { refresh: true, hint: 'Accounts that appear as counterparties but haven’t been looked up yet' }),
          toggleRow('Unconnected accounts', 'showOrphans', { refresh: true }),
          hidden ? h('button', { class: 'link small', onclick: () => (app.unhideAll(), render()) }, `Show ${hidden} hidden account${hidden > 1 ? 's' : ''}`) : null,
        ),
        group(
          'Display',
          toggleRow('Arrows', 'arrows'),
          toggleRow('Animate money flow', 'particles', { hint: 'Moving dots travel in the direction value moved' }),
          slider('Label threshold', 'labels', 0, 1, 0.05, { hint: 'Higher shows more names at lower zoom' }),
          slider('Node size', 'nodeSize', 0.5, 2, 0.05, { refresh: true }),
          slider('Line thickness', 'linkWidth', 0.3, 3, 0.1),
        ),
        group(
          'Forces',
          slider('Center force', 'centerForce', 0, 1, 0.01, { forces: true }),
          slider('Repel force', 'repelForce', 0, 20, 0.5, { forces: true }),
          slider('Link force', 'linkForce', 0, 1, 0.01, { forces: true }),
          slider('Link distance', 'linkDistance', 10, 300, 1, { forces: true }),
        ),
        group(
          'Exploring',
          slider('Connections per expand', 'neighborLimit', 10, 200, 5, { hint: 'How many counterparties to add when you expand an account' }),
          h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Ledger server'), server),
        ),
        h(
          'div',
          { class: 'set-actions' },
          h(
            'button',
            {
              class: 'btn small',
              onclick: () => {
                const keep = { theme: app.settings.theme, server: app.settings.server };
                app.updateSettings({ ...structuredClone(DEFAULTS), ...keep }, { refresh: true, forces: true });
                render();
              },
            },
            'Reset settings',
          ),
          h(
            'button',
            {
              class: 'btn small danger',
              onclick: () => {
                if (confirm('Remove every account from the map?')) app.clearGraph();
              },
            },
            icon('trash', 13),
            'Clear map',
          ),
        ),
      ),
    );
  };
  app.on('graph', () => open && !el.contains(document.activeElement) && render());
  return { el, toggle };
}

export function buildZoom(app: App): HTMLElement {
  const count = h('span', { class: 'counts', 'aria-live': 'polite' });
  const render = () => {
    count.textContent = `${app.view.nodes.length} accounts · ${app.view.edges.length} links`;
  };
  app.on('graph', render);
  app.on('settings', render);
  return h(
    'div',
    { class: 'zoom panel' },
    count,
    h('button', { class: 'icon-btn small', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => app.view.zoomBy(1.4) }, icon('plus', 15)),
    h('button', { class: 'icon-btn small', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => app.view.zoomBy(1 / 1.4) }, icon('minus', 15)),
    h('button', { class: 'icon-btn small', title: 'Fit everything (F)', 'aria-label': 'Fit to screen', onclick: () => app.view.fit() }, icon('fit', 15)),
  );
}
