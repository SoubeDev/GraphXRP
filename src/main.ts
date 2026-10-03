import './styles.css';
import { App } from './app';
import { h } from './ui/dom';
import { buildTopBar } from './ui/chrome';
import { Inspector } from './ui/inspector';
import { buildLegend, buildSettings, buildZoom } from './ui/panels';
import { buildContextMenu, buildHelp, buildToasts, buildTooltip, buildWelcome } from './ui/overlays';
import { hasWalletApi } from './wallets/probe';

const root = document.getElementById('app')!;
const stage = h('div', { class: 'stage' });
root.append(stage);

const app = new App(stage);
app.start();

const help = buildHelp();
const settings = buildSettings(app);
root.append(
  buildWelcome(app, help.open),
  buildTopBar(app, help.open),
  h('div', { class: 'bottom-left' }, buildLegend(app, settings.toggle)),
  settings.el,
  buildZoom(app),
  buildTooltip(app),
  buildContextMenu(app, help.open),
  buildToasts(app),
  help.el,
);
new Inspector(app, root);

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !t.matches('input, textarea, select'))) {
    e.preventDefault();
    root.querySelector<HTMLInputElement>('.search-input')?.focus();
    return;
  }
  if (t.matches('input, textarea, select') || t.isContentEditable || e.metaKey || e.ctrlKey) return;
  const sel = app.selected;
  if (e.altKey && e.key === 'ArrowLeft') history.back();
  else if (e.altKey && e.key === 'ArrowRight') history.forward();
  else if (e.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
    if (app.view.trail) app.clearTrail();
    else app.select(null);
  } else if (e.key === 'f' || e.key === 'F') app.view.fit();
  else if ((e.key === 'e' || e.key === 'E') && sel) void app.expand(sel);
  else if ((e.key === 't' || e.key === 'T') && sel) void app.traceOrigin(sel);
  else if (e.key === '?') help.open();
  else if (e.key === '+' || e.key === '=') app.view.zoomBy(1.3);
  else if (e.key === '-' || e.key === '_') app.view.zoomBy(1 / 1.3);
});

app.routeFromHash();

// Your wallets: only when running locally with the wallet API. Loaded on demand, so the public site never loads it.
void hasWalletApi().then((ok) => {
  if (ok) import('./wallets').then((m) => m.mount(app, root)).catch((e) => console.error('Wallets failed to load:', e));
});

// Handy for poking around from the browser console during development.
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
