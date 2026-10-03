/** Top bar: brand, search, history trail, live status, theme and help. */
import type { App } from '../app';
import { h, clear } from './dom';
import { icon, shapeGlyph } from './icons';
import { isAddress, isTxHash, shortAddr } from '../xrpl/amount';
import { isExternal, parseExt } from '../bridges/registry';
import { nodeId } from '../chains/chains';

const FOREIGN_RE = /^(0x[0-9a-fA-F]{40}|core1[02-9ac-hj-np-z]{38,58})$/;

interface Result {
  title: string;
  tag?: string;
  sub: string;
  kind: string;
  verified?: boolean;
  onMap?: boolean;
  run: () => void;
}

export function buildTopBar(app: App, openHelp: () => void): HTMLElement {
  const search = buildSearch(app);
  const status = buildStatus(app);
  const themeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Toggle light/dark theme', title: 'Toggle theme' });
  const paintTheme = () => {
    clear(themeBtn);
    themeBtn.append(icon(app.isDark() ? 'sun' : 'moon', 16));
  };
  themeBtn.onclick = () => {
    app.updateSettings({ theme: app.isDark() ? 'light' : 'dark' });
    paintTheme();
  };
  paintTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTheme);

  return h(
    'div',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-left' },
      h('div', { class: 'brand panel', title: 'GraphXRP: explore the XRP Ledger as a map' }, logo(), h('span', null, 'Graph', h('b', null, 'XRP'))),
      h('div', { class: 'search-col' }, search, buildCrumbs(app)),
    ),
    h('div', { class: 'topbar-right panel' }, status, themeBtn, h('button', { class: 'icon-btn', 'aria-label': 'How to read this map', title: 'How to read this map (?)', onclick: openHelp }, icon('help', 16))),
  );
}

function logo() {
  const s = document.createElement('span');
  s.className = 'logo';
  s.innerHTML =
    '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><g stroke="currentColor" stroke-opacity=".45" stroke-width="1.6"><path d="M9 22 16 10l7 12z" fill="none"/></g><circle cx="16" cy="10" r="3.4" fill="var(--k-issuer)"/><rect x="5.6" y="18.6" width="6.8" height="6.8" rx="1.8" fill="var(--k-exchange)"/><circle cx="23" cy="22" r="3.4" fill="var(--k-amm)"/></svg>';
  return s;
}

function buildSearch(app: App): HTMLElement {
  const input = h('input', {
    type: 'search',
    class: 'search-input',
    placeholder: 'Search a name, website, address (r… or 0x…) or transaction…',
    'aria-label': 'Search the XRP Ledger',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': 'search-results',
  });
  const list = h('ul', { class: 'search-results panel', id: 'search-results', role: 'listbox' });
  const wrap = h('div', { class: 'search panel' }, icon('search', 16, 'search-ico'), input, h('kbd', { class: 'search-kbd', title: 'Press / to search' }, '/'), list);
  let results: Result[] = [];
  let active = 0;

  const run = (r: Result) => {
    r.run();
    input.value = '';
    close();
    input.blur();
  };

  const close = () => {
    list.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
  };

  const render = () => {
    clear(list);
    if (!results.length) {
      const q = input.value.trim();
      if (q.length >= 2) {
        const msg = /^X[1-9A-HJ-NP-Za-km-z]{40,}$/.test(q)
          ? 'X-addresses aren’t supported yet. Paste the classic address starting with “r”.'
          : FOREIGN_RE.test(q)
            ? 'That’s an address on another blockchain. It appears on the map once an XRP Ledger account you explore sends funds to it across a bridge.'
          : app.dir.directoryState === 'loading'
            ? 'Loading the name directory…'
            : 'No known name matches. Paste an address (starts with “r”) or a 64-character transaction hash.';
        list.append(h('li', { class: 'search-empty' }, msg));
        list.classList.add('open');
      } else close();
      return;
    }
    results.forEach((r, i) => {
      const li = h(
        'li',
        { class: `search-item${i === active ? ' active' : ''}`, role: 'option', 'aria-selected': i === active ? 'true' : 'false' },
        shapeGlyph(r.kind, 13),
        h(
          'div',
          { class: 'si-main' },
          h('div', { class: 'si-title' }, r.title, r.tag ? h('span', { class: 'tag' }, r.tag) : null, r.verified ? h('span', { class: 'verified', title: 'Verified by XRPScan' }, icon('checkCircle', 13)) : null),
          h('div', { class: 'si-sub' }, r.sub),
        ),
        r.onMap ? h('span', { class: 'si-onmap' }, 'on map') : null,
      );
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        run(r);
      });
      li.addEventListener('mousemove', () => {
        if (active !== i) {
          active = i;
          render();
        }
      });
      list.append(li);
    });
    list.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  };

  const update = () => {
    const q = input.value.trim();
    results = [];
    active = 0;
    // Your own wallets (local wallet manager) come first.
    const extra = q.length >= 2 ? (app.ext.search?.(q) ?? []).slice(0, 4) : [];
    for (const x of extra) results.push({ ...x, onMap: false });
    const mine = new Set(extra.map((x) => x.address));
    if (isAddress(q)) {
      const named = app.dir.get(q).name;
      results.push({ title: named ? app.dir.label(q) : 'Explore this address', sub: `${q} \u00b7 XRP Ledger`, kind: app.classify(q), onMap: app.model.nodes.has(q), run: () => void app.explore(q) });
      // Xahau uses the same addresses (and the same keys).
      const x = nodeId('xahau', q);
      results.push({ title: 'Same address on Xahau', sub: `${q} \u00b7 Xahau`, kind: 'wallet', onMap: app.model.nodes.has(x), run: () => void app.explore(x) });
    } else if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      const id = nodeId('xrpl-evm', q);
      results.push({ title: app.dir.get(id).name ?? 'Explore on the XRPL EVM Sidechain', sub: `${q.toLowerCase()} \u00b7 XRPL EVM Sidechain`, kind: app.classify(id), onMap: app.model.nodes.has(id), run: () => void app.explore(id) });
      const low = q.toLowerCase();
      for (const other of app.model.nodes.keys()) {
        if (other === id || !isExternal(other) || parseExt(other).address?.toLowerCase() !== low) continue;
        results.push({ title: app.dir.label(other), sub: 'Same address on another chain \u00b7 on the map', kind: 'external', onMap: true, run: () => (app.select(other), app.view.focusNode(other)) });
      }
    } else if (isTxHash(q)) {
      results.push({ title: 'Open this transaction', sub: `${q.slice(0, 20)}…`, kind: 'wallet', run: () => void app.openTx(q.toUpperCase()) });
    } else if (FOREIGN_RE.test(q)) {
      const low = q.toLowerCase();
      for (const id of app.model.nodes.keys()) {
        if (!isExternal(id) || parseExt(id).address?.toLowerCase() !== low) continue;
        results.push({
          title: app.dir.label(id),
          sub: 'Address on another chain \u00b7 named in XRP Ledger transactions',
          kind: 'external',
          onMap: true,
          run: () => {
            app.select(id);
            app.view.focusNode(id);
          },
        });
      }
    } else if (q.length >= 2) {
      for (const hit of app.dir.search(q, 8)) {
        if (mine.has(hit.address)) continue;
        results.push({
          title: hit.name,
          tag: hit.tag,
          sub: [hit.domain, shortAddr(hit.address), hit.source === 'label' ? 'your label' : null].filter(Boolean).join(' · '),
          kind: app.classify(hit.address),
          verified: hit.verified,
          onMap: app.model.nodes.has(hit.address),
          run: () => void app.explore(hit.address),
        });
      }
    }
    render();
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      active = Math.min(results.length - 1, active + 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      active = Math.max(0, active - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (results[active]) run(results[active]);
    } else if (e.key === 'Escape') {
      input.value = '';
      close();
      input.blur();
    }
  });
  return wrap;
}

function buildCrumbs(app: App): HTMLElement {
  const el = h('nav', { class: 'crumbs', 'aria-label': 'Recently visited accounts' });
  const render = () => {
    clear(el);
    const list = app.visited.slice(-6);
    if (list.length < 2) {
      el.classList.remove('show');
      return;
    }
    el.classList.add('show');
    el.append(
      h('button', { class: 'icon-btn small', title: 'Back (Alt+←)', 'aria-label': 'Back', onclick: () => history.back() }, icon('left', 14)),
      h('button', { class: 'icon-btn small', title: 'Forward (Alt+→)', 'aria-label': 'Forward', onclick: () => history.forward() }, icon('right', 14)),
    );
    list.forEach((id, i) => {
      if (i) el.append(h('span', { class: 'crumb-sep' }, '›'));
      el.append(
        h(
          'button',
          {
            class: `crumb${id === app.selected ? ' current' : ''}`,
            title: id,
            onclick: () => {
              app.select(id);
              app.view.focusNode(id);
            },
          },
          app.dir.label(id),
        ),
      );
    });
  };
  app.on('select', render);
  app.on('graph', render);
  return el;
}

function buildStatus(app: App): HTMLElement {
  const dot = h('span', { class: 'status-dot' });
  const text = h('span', { class: 'status-text' });
  const el = h('div', { class: 'status', role: 'status' }, dot, text);
  let last = 0;
  const render = () => {
    const c = app.client;
    el.dataset.state = c.state;
    el.title =
      c.state === 'connected'
        ? `Connected to ${c.server}. A new ledger (a page in the shared record) closes every 3–5 seconds.`
        : `Connecting to ${c.server || 'a public XRPL server'}…`;
    text.textContent = c.state === 'connected' ? (c.ledgerIndex ? `Live · ledger ${c.ledgerIndex.toLocaleString()}` : 'Live') : 'Connecting…';
    if (c.ledgerIndex !== last) {
      last = c.ledgerIndex;
      dot.classList.remove('pulse');
      void dot.offsetWidth;
      dot.classList.add('pulse');
    }
  };
  app.client.onChange(render);
  // Other networks connect on demand; show them next to the XRP Ledger once they do.
  const others = h('span', { class: 'status-others' });
  el.append(others);
  app.on('networks', () => {
    const x = app.xahauConnected;
    others.textContent = x ? ` \u00b7 Xahau ${x.state === 'connected' ? (x.ledgerIndex ? x.ledgerIndex.toLocaleString() : 'live') : '\u2026'}` : '';
    others.title = x ? `Also connected to Xahau via ${x.server}` : '';
  });
  render();
  return el;
}
