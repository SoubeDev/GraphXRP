/** Signing a single transaction from a wallet, with a confirmation step on mainnet. */
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { Ctx } from '../index';
import { NETWORKS } from '../networks';
import type { StoredWallet } from '../types';
import { errText, modal, netPill, note } from './kit';

/** Mainnet only: show what's about to be signed. Resolves true to go ahead. */
export function confirmReal(w: StoredWallet, title: string, lines: (string | HTMLElement)[]): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, undefined, { onClose: () => !done && resolve(false) });
    m.body.append(
      h('div', { class: 'w-review' }, h('div', { class: 'w-review-from' }, 'From ', h('strong', null, w.label), ' ', netPill(w.networkId)), ...lines.map((l) => h('div', { class: 'w-review-line' }, l))),
      note('warn', 'This is a real transaction on the XRP Ledger mainnet. It can’t be undone.'),
    );
    const go = h(
      'button',
      {
        class: 'btn primary',
        onclick: () => {
          done = true;
          m.close();
          resolve(true);
        },
      },
      icon('key', 14),
      'Sign on Mainnet',
    );
    m.foot.append(h('button', { class: 'btn', onclick: m.close }, 'Cancel'), go);
    setTimeout(() => go.focus());
  });
}

/** Confirm (mainnet), unlock, sign and submit; progress and outcome go to toasts. */
export async function runTx(ctx: Ctx, w: StoredWallet, tx: Record<string, unknown>, what: string, detail: (string | HTMLElement)[] = []): Promise<boolean> {
  if (NETWORKS[w.networkId].real && !(await confirmReal(w, what, detail.length ? detail : [what]))) return false;
  const secrets = await ctx.secrets(w, `Enter your vault password to sign with “${w.label}”.`);
  if (!secrets) return false;
  ctx.toast(`${what}…`);
  try {
    await ctx.ledger.submit(w, secrets, tx);
    ctx.toast(`${what}: done`);
    return true;
  } catch (e) {
    ctx.toast(`${what} failed: ${errText(e)}`, 'error');
    return false;
  }
}
