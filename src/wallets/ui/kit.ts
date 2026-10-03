/** Small UI building blocks for the wallet screens (same `h()` style as the rest of the app). */
import { h, clear, copyText, type Child } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { NETWORKS, type NetworkId } from '../networks';

/* -------------------------------- dialog ------------------------------- */

export interface Modal {
  dlg: HTMLDialogElement;
  body: HTMLElement;
  foot: HTMLElement;
  close: () => void;
  /** While busy, Esc and the close button do nothing. */
  busy: (on: boolean) => void;
}

export function modal(title: string, sub?: string, opts: { wide?: boolean; onClose?: () => void } = {}): Modal {
  const dlg = h('dialog', { class: `w-dialog panel${opts.wide ? ' wide' : ''}`, 'aria-label': title }) as HTMLDialogElement;
  const body = h('div', { class: 'wd-body' });
  const foot = h('div', { class: 'wd-foot' });
  let busy = false;
  const close = () => {
    if (dlg.open) dlg.close();
  };
  dlg.append(
    h(
      'div',
      { class: 'wd-head' },
      h('div', null, h('h2', null, title), sub ? h('p', { class: 'wd-sub' }, sub) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => !busy && close() }, icon('x', 16)),
    ),
    body,
    foot,
  );
  dlg.addEventListener('cancel', (e) => busy && e.preventDefault());
  dlg.addEventListener('close', () => {
    dlg.remove();
    opts.onClose?.();
  });
  document.body.append(dlg);
  dlg.showModal();
  return {
    dlg,
    body,
    foot,
    close,
    busy: (on) => {
      busy = on;
      dlg.classList.toggle('busy', on);
    },
  };
}

/* -------------------------------- fields ------------------------------- */

export function field(label: string, control: HTMLElement, hint?: Child): HTMLElement {
  return h('label', { class: 'w-field' }, h('span', { class: 'w-label' }, label), control, hint ? h('span', { class: 'w-hint' }, hint) : null);
}

export function input(props: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { class: 'w-input', autocomplete: 'off', spellcheck: 'false', ...props });
}

export function datalist(id: string, options: { value: string; label?: string }[]): HTMLDataListElement {
  return h('datalist', { id }, ...options.map((o) => h('option', { value: o.value }, o.label ?? '')));
}

/** Segmented control. Read the current value from `.value`. */
export function seg<T extends string>(options: { value: T; label: string; hint?: string }[], value: T, onChange: (v: T) => void): HTMLElement & { value: T } {
  const el = h('div', { class: 'w-seg', role: 'radiogroup' }) as unknown as HTMLElement & { value: T };
  el.value = value;
  const paint = () => {
    for (const b of el.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.v === el.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  for (const o of options) {
    el.append(
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'data-v': o.value,
          title: o.hint ?? '',
          onclick: () => {
            if (el.value === o.value) return;
            el.value = o.value;
            paint();
            onChange(o.value);
          },
        },
        o.label,
      ),
    );
  }
  paint();
  return el;
}

export function checkbox(label: string, checked: boolean, hint?: string): { el: HTMLElement; input: HTMLInputElement } {
  const inp = h('input', { type: 'checkbox', checked });
  return { el: h('label', { class: 'w-check' }, inp, h('span', null, label, hint ? h('span', { class: 'w-hint block' }, hint) : null)), input: inp };
}

/** A line of feedback under a form: ok / warn / error. */
export function note(level: 'ok' | 'warn' | 'error' | 'info', text: Child): HTMLElement {
  const ic = level === 'error' || level === 'warn' ? 'alert' : level === 'ok' ? 'checkCircle' : 'info';
  return h('div', { class: `w-note ${level}` }, icon(ic, 14), h('div', null, text));
}

/* --------------------------- pills and menus --------------------------- */

export function netPill(net: NetworkId): HTMLElement {
  const n = NETWORKS[net];
  return h('span', { class: `net-pill ${net}`, title: n.real ? 'Mainnet: real XRP. Keys are encrypted.' : `${n.name}: test XRP with no value` }, n.name);
}

export interface MenuItem {
  icon: string;
  label: string;
  run: () => void;
  danger?: boolean;
}

let openMenu: HTMLElement | null = null;

/** A small popover menu under `anchor` (styled like the map's context menu). */
export function popMenu(anchor: HTMLElement, items: (MenuItem | 'sep' | null | false)[]) {
  openMenu?.remove();
  const el = h('div', { class: 'ctx panel show w-menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') {
      el.append(h('div', { class: 'ctx-sep' }));
      continue;
    }
    el.append(
      h(
        'button',
        {
          class: `ctx-item${it.danger ? ' danger' : ''}`,
          role: 'menuitem',
          onclick: () => {
            close();
            it.run();
          },
        },
        icon(it.icon, 14),
        it.label,
      ),
    );
  }
  document.body.append(el);
  openMenu = el;
  const r = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8))}px`;
  el.style.top = `${Math.min(r.bottom + 6, window.innerHeight - m.height - 8)}px`;
  const close = () => {
    el.remove();
    if (openMenu === el) openMenu = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e: Event) => !el.contains(e.target as Node) && e.target !== anchor && close();
  const esc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', esc, true);
  // Next tick, so the click that opened the menu doesn't close it.
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  (el.querySelector('button') as HTMLButtonElement | null)?.focus();
}

/* ------------------------------- secrets ------------------------------- */

/**
 * A secret that stays blurred until revealed. `words` shows a numbered grid
 * (recovery phrases, secret numbers). Revealed values hide again after a while.
 */
export function secretBox(value: string, opts: { words?: string[]; labels?: string[]; hideAfterMs?: number; onCopy?: () => void } = {}): HTMLElement {
  let shown = false;
  let timer = 0;
  const content = opts.words
    ? h('div', { class: 'w-words' }, ...opts.words.map((w, i) => h('span', { class: 'w-word' }, h('i', null, opts.labels?.[i] ?? String(i + 1)), w)))
    : h('code', { class: 'w-secret-val' }, value);
  const box = h('div', { class: 'w-secret' }, content);
  const toggle = h('button', { class: 'btn small', type: 'button' });
  const paint = () => {
    box.classList.toggle('shown', shown);
    clear(toggle);
    toggle.append(icon(shown ? 'eyeoff' : 'eye', 13), shown ? 'Hide' : 'Reveal');
  };
  toggle.onclick = () => {
    shown = !shown;
    clearTimeout(timer);
    if (shown) timer = window.setTimeout(() => ((shown = false), paint()), opts.hideAfterMs ?? 60_000);
    paint();
  };
  box.onclick = () => !shown && toggle.click();
  paint();
  const copy = h('button', { class: 'btn small', type: 'button', onclick: async () => (await copyText(value)) && opts.onCopy?.() }, icon('copy', 13), 'Copy');
  return h('div', { class: 'w-secret-wrap' }, box, h('div', { class: 'row' }, toggle, copy));
}

/* -------------------------------- misc -------------------------------- */

export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Run `job` with a button showing progress; restores the button afterwards. */
export async function withBusy<T>(btn: HTMLButtonElement, text: string, job: () => Promise<T>): Promise<T> {
  const old = [...btn.childNodes];
  btn.disabled = true;
  clear(btn);
  btn.append(h('span', { class: 'spinner', style: { marginLeft: '0' } }), text);
  try {
    return await job();
  } finally {
    btn.disabled = false;
    clear(btn);
    btn.append(...old);
  }
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
