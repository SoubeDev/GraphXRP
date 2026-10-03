/** Dialogs for the mainnet vault: create it, unlock it, change its password. */
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { IDLE_MINUTES, changePassword, createVault, isUnlocked, unlock } from '../vault';
import type { WalletStore } from '../store';
import { errText, field, input, modal, note } from './kit';

const MIN_LENGTH = 10;

function password(placeholder: string, autocomplete: string): HTMLInputElement {
  return input({ type: 'password', placeholder, autocomplete });
}

/** Ask for the vault password. Resolves true once unlocked. */
export function promptUnlock(store: WalletStore, reason = 'Enter your vault password to use mainnet keys.'): Promise<boolean> {
  const meta = store.vault;
  if (!meta) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const m = modal('Unlock mainnet keys', reason, { onClose: () => !done && resolve(false) });
    const pw = password('Vault password', 'current-password');
    const msg = h('div');
    const go = h('button', { class: 'btn primary', type: 'submit' }, icon('unlock', 14), 'Unlock');
    const form = h(
      'form',
      { class: 'w-form' },
      field('Password', pw),
      msg,
      h('p', { class: 'muted small flush' }, `Stays unlocked until you lock it or for ${IDLE_MINUTES} minutes of inactivity. Reloading the page locks it.`),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      go.disabled = true;
      msg.replaceChildren(note('info', 'Checking…'));
      const ok = await unlock(meta, pw.value);
      go.disabled = false;
      if (!ok) {
        msg.replaceChildren(note('error', 'That password doesn’t match.'));
        pw.select();
        return;
      }
      done = true;
      m.close();
      resolve(true);
    };
    m.body.append(form);
    m.foot.append(h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Cancel'), go);
    go.onclick = () => form.requestSubmit();
    setTimeout(() => pw.focus());
  });
}

/** First mainnet wallet: choose the password that encrypts mainnet keys. */
export function promptCreateVault(store: WalletStore): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal('Protect your mainnet keys', 'Mainnet keys are encrypted with a password before they’re saved to disk.', { onClose: () => !done && resolve(false) });
    const pw = password(`At least ${MIN_LENGTH} characters`, 'new-password');
    const again = password('Type it again', 'new-password');
    const msg = h('div');
    const go = h('button', { class: 'btn primary', type: 'button' }, icon('lock', 14), 'Create vault');
    m.body.append(
      h(
        'div',
        { class: 'w-form' },
        field('Vault password', pw),
        field('Confirm password', again),
        note('warn', [h('strong', null, 'It can’t be recovered. '), 'If you forget it, the mainnet keys saved here can’t be decrypted. Keep your own backup of each seed.']),
        h('p', { class: 'muted small flush' }, 'Test-network keys stay readable so scripts can use them. Only mainnet keys are encrypted, and they’re never served to scripts.'),
        msg,
      ),
    );
    go.onclick = async () => {
      if (pw.value.length < MIN_LENGTH) return msg.replaceChildren(note('error', `Use at least ${MIN_LENGTH} characters.`));
      if (pw.value !== again.value) return msg.replaceChildren(note('error', 'The two passwords don’t match.'));
      m.busy(true);
      go.disabled = true;
      msg.replaceChildren(note('info', 'Creating the vault…'));
      try {
        const meta = await createVault(pw.value);
        await store.mutate((d) => {
          d.vault = meta;
        });
        done = true;
        m.busy(false);
        m.close();
        resolve(true);
      } catch (e) {
        m.busy(false);
        go.disabled = false;
        msg.replaceChildren(note('error', errText(e)));
      }
    };
    m.foot.append(h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Cancel'), go);
    setTimeout(() => pw.focus());
  });
}

/** Make sure mainnet keys can be used right now (creating the vault on first use). */
export async function ensureUnlocked(store: WalletStore, reason?: string): Promise<boolean> {
  if (isUnlocked() && store.vault) return true;
  return store.vault ? promptUnlock(store, reason) : promptCreateVault(store);
}

export function changePasswordDialog(store: WalletStore, done: (text: string) => void) {
  const meta = store.vault;
  if (!meta) return;
  const m = modal('Change vault password', 'Every mainnet key is re-encrypted with the new password.');
  const old = password('Current password', 'current-password');
  const pw = password(`At least ${MIN_LENGTH} characters`, 'new-password');
  const again = password('Type it again', 'new-password');
  const msg = h('div');
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Change password');
  m.body.append(h('div', { class: 'w-form' }, field('Current password', old), field('New password', pw), field('Confirm new password', again), msg));
  go.onclick = async () => {
    if (pw.value.length < MIN_LENGTH) return msg.replaceChildren(note('error', `Use at least ${MIN_LENGTH} characters.`));
    if (pw.value !== again.value) return msg.replaceChildren(note('error', 'The new passwords don’t match.'));
    m.busy(true);
    go.disabled = true;
    msg.replaceChildren(note('info', 'Re-encrypting…'));
    try {
      const res = await changePassword(meta, old.value, pw.value, store.wallets);
      const byId = new Map(res.wallets.map((w) => [w.id, w]));
      await store.mutate((d) => {
        d.vault = res.meta;
        d.wallets = d.wallets.map((w) => byId.get(w.id) ?? w);
      });
      m.busy(false);
      m.close();
      done('Vault password changed');
    } catch (e) {
      m.busy(false);
      go.disabled = false;
      msg.replaceChildren(note('error', errText(e)));
    }
  };
  m.foot.append(h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Cancel'), go);
  setTimeout(() => old.focus());
}
