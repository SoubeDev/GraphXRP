/** "Add wallets": create new ones, import secrets, watch an address, or restore a backup. */
import { h, clear } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { shortAddr } from '../../xrpl/amount';
import type { Ctx } from '../index';
import { NETWORKS, type NetworkId } from '../networks';
import { DEFAULT_DERIVATION_PATH, DETECTED_LABEL, deriveFromSecret, detectSecret, generateKeys, normalizeAddress, type DerivedKeys, type GenerateFormat } from '../keys';
import { nextNames } from '../store';
import { findLegacy, importIncoming, importLegacy, readBackup, type Incoming } from '../importer';
import type { KeyAlgorithm } from '../types';
import { checkbox, datalist, errText, field, input, modal, note, seg, withBusy } from './kit';
import { ensureUnlocked } from './vaultui';

type Mode = 'create' | 'import' | 'watch' | 'restore';

export function openAdd(ctx: Ctx, opts: { mode?: Mode; net?: NetworkId } = {}) {
  const { store } = ctx;
  let mode: Mode = opts.mode ?? 'create';
  let net: NetworkId = opts.net ?? 'testnet';
  const m = modal('Add wallets', 'Saved on this computer. Test-network keys stay readable for your scripts; mainnet keys are encrypted.');
  const groupsId = 'w-add-groups';

  /* -------- inputs live across mode switches so nothing typed is lost -------- */
  const createName = input({ maxlength: '40' });
  const createCount = input({ type: 'number', min: '1', max: '10', value: '1', inputmode: 'numeric', style: { width: '80px' } });
  const createGroup = input({ list: groupsId, placeholder: 'Optional, e.g. the app you’re testing' });
  const fund = checkbox('Fund from the faucet', true, 'Free test XRP, so the wallet is ready to use.');
  let algorithm: KeyAlgorithm = 'ed25519';
  let format: GenerateFormat = 'seed';

  const secretBox = h('textarea', { class: 'w-input mono', rows: '3', placeholder: 'sEd… seed, a 12–24 word recovery phrase, or secret numbers.\nSeveral seeds? Put one per line.', spellcheck: 'false', autocomplete: 'off' });
  const importName = input({ maxlength: '40' });
  const importGroup = input({ list: groupsId, placeholder: 'Optional' });
  const derivation = input({ value: DEFAULT_DERIVATION_PATH });
  const detected = h('div', { class: 'w-detect' });

  const watchAddr = input({ placeholder: 'r… address' });
  const watchName = input({ maxlength: '40', placeholder: 'Its public name, if it has one' });
  /** A watched account is named after its public identity (mainnet), else its short address. */
  const watchLabel = (address: string) => (net === 'mainnet' ? ctx.app.dir.get(address).name : undefined) ?? shortAddr(address);
  watchAddr.addEventListener('input', () => {
    const a = normalizeAddress(watchAddr.value);
    watchName.placeholder = a ? watchLabel(a) : 'Its public name, if it has one';
  });
  const watchGroup = input({ list: groupsId, placeholder: 'Optional' });

  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'w-file' });
  let incoming: Incoming | null = null;
  const restoreInfo = h('div');

  const msg = h('div');
  const content = h('div', { class: 'w-form' });
  const go = h('button', { class: 'btn primary', type: 'button' });

  /* ----------------------------- live feedback ----------------------------- */

  const secretLines = () => secretBox.value.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulk = () => {
    const lines = secretLines();
    return lines.length > 1 && lines.every((l) => detectSecret(l) === 'seed');
  };
  const detect = () => {
    clear(detected);
    const v = secretBox.value.trim();
    if (!v) return;
    if (bulk()) {
      detected.append(note('ok', `${secretLines().length} family seeds`));
      return;
    }
    const kind = detectSecret(v);
    if (kind === 'unknown' || kind === 'address') {
      detected.append(note('warn', DETECTED_LABEL[kind]));
      return;
    }
    try {
      const k = deriveFromSecret(v, { derivationPath: derivation.value });
      const dup = store.find(k.address, net);
      detected.append(note(dup ? 'warn' : 'ok', [`${DETECTED_LABEL[kind]} → `, h('code', null, shortAddr(k.address)), dup ? ` (already here as “${dup.label}”)` : '']));
    } catch (e) {
      detected.append(note('error', errText(e)));
    }
  };
  secretBox.addEventListener('input', detect);
  derivation.addEventListener('input', detect);

  file.addEventListener('change', async () => {
    incoming = null;
    clear(restoreInfo);
    const f = file.files?.[0];
    if (!f) return paint();
    try {
      incoming = readBackup(JSON.parse(await f.text()), net);
      const fresh = incoming.wallets.filter((w) => !store.find(w.address, w.networkId)).length;
      const nets = [...new Set(incoming.wallets.map((w) => NETWORKS[w.networkId].name))].join(', ');
      restoreInfo.append(
        note(fresh ? 'ok' : 'info', [
          `Found ${incoming.wallets.length} wallet${incoming.wallets.length === 1 ? '' : 's'}${nets ? ` (${nets})` : ''}. `,
          fresh ? `${fresh} new.` : 'All of them are already here.',
          incoming.unreadable ? ` ${incoming.unreadable} couldn’t be read.` : '',
        ]),
      );
    } catch (e) {
      restoreInfo.append(note('error', `Couldn’t read that file: ${errText(e)}`));
    }
    paint();
  });

  /* --------------------------------- layout -------------------------------- */

  const modes = seg<Mode>(
    [
      { value: 'create', label: 'Create', hint: 'Generate new keys' },
      { value: 'import', label: 'Import', hint: 'From a seed, recovery phrase or secret numbers' },
      { value: 'watch', label: 'Watch', hint: 'Follow an address without keys' },
      { value: 'restore', label: 'Restore', hint: 'From a backup file or XRPL Wallet Manager' },
    ],
    mode,
    (v) => {
      mode = v;
      paint();
    },
  );
  const nets = seg<NetworkId>(
    [
      { value: 'testnet', label: 'Testnet' },
      { value: 'devnet', label: 'Devnet' },
      { value: 'mainnet', label: 'Mainnet', hint: 'Real XRP. Keys are encrypted with a password.' },
    ],
    net,
    (v) => {
      net = v;
      paint();
      detect();
    },
  );
  nets.classList.add('w-seg-net');

  function suggestName(el: HTMLInputElement) {
    const [s] = nextNames(store, net, 1);
    el.placeholder = s;
    return s;
  }

  function paint() {
    clear(content);
    clear(msg);
    const real = NETWORKS[net].real;
    const netRow = h('div', { class: 'w-field' }, h('span', { class: 'w-label' }, mode === 'restore' ? 'Wallets without a network go to' : 'Network'), nets);
    const realNote = real
      ? note('warn', [h('strong', null, 'Mainnet holds real XRP. '), mode === 'watch' ? 'Watching is read-only: no keys are stored.' : 'Keys are encrypted with your vault password before they’re saved. GraphXRP isn’t a backup: keep your own copy of each seed.'])
      : null;
    if (mode === 'create') {
      suggestName(createName);
      content.append(
        netRow,
        h('div', { class: 'w-field-row' }, field('Name', createName), field('How many', createCount)),
        field('Group', createGroup),
        real ? '' : fund.el,
        h(
          'details',
          { class: 'w-adv' },
          h('summary', null, 'Key options'),
          h(
            'div',
            { class: 'w-form' },
            h(
              'div',
              { class: 'w-field' },
              h('span', { class: 'w-label' }, 'Write the secret as'),
              seg<GenerateFormat>(
                [
                  { value: 'seed', label: 'Family seed' },
                  { value: 'mnemonic', label: 'Recovery phrase' },
                  { value: 'secretNumbers', label: 'Secret numbers', hint: 'Xaman’s 8 rows of numbers (secp256k1)' },
                ],
                format,
                (v) => (format = v),
              ),
            ),
            h(
              'div',
              { class: 'w-field' },
              h('span', { class: 'w-label' }, 'Key type'),
              seg<KeyAlgorithm>(
                [
                  { value: 'ed25519', label: 'Ed25519' },
                  { value: 'secp256k1', label: 'secp256k1' },
                ],
                algorithm,
                (v) => (algorithm = v),
              ),
              h('span', { class: 'w-hint' }, 'Applies to family seeds. Recovery phrases and secret numbers use secp256k1.'),
            ),
          ),
        ),
        realNote ?? note('info', `${NETWORKS[net].name} XRP is free and has no value. Fund wallets any time from the faucet.`),
      );
      go.replaceChildren(icon('plus', 14), 'Create');
    } else if (mode === 'import') {
      suggestName(importName);
      content.append(
        netRow,
        field('Secret', secretBox),
        detected,
        h('div', { class: 'w-field-row' }, field('Name', importName), field('Group', importGroup)),
        h('details', { class: 'w-adv' }, h('summary', null, 'Recovery phrase options'), h('div', { class: 'w-form' }, field('Derivation path', derivation, 'Only used for recovery phrases. Change it to reach other accounts from the same phrase.'))),
        realNote ?? '',
      );
      go.replaceChildren(icon('key', 14), 'Import');
    } else if (mode === 'watch') {
      content.append(netRow, field('Address', watchAddr), h('div', { class: 'w-field-row' }, field('Name', watchName), field('Group', watchGroup)), realNote ?? '');
      go.replaceChildren(icon('eye', 14), 'Watch');
    } else {
      const legacy = h('div');
      content.append(
        legacy,
        field(
          'Backup file',
          file,
          'A GraphXRP backup, an XRPL Wallet Manager backup or its data/store.json, or a list like [{ "label": "Alice", "seed": "s…" }].',
        ),
        restoreInfo,
        netRow,
      );
      void findLegacy().then((n) => {
        if (!n || mode !== 'restore') return;
        const b = h('button', { class: 'btn small', type: 'button' }, icon('download', 13), `Import ${n} wallet${n === 1 ? '' : 's'}`);
        b.onclick = () => void withBusy(b, 'Importing…', () => run(() => importLegacy(ctx)));
        legacy.append(h('div', { class: 'w-legacy' }, h('div', null, h('strong', null, 'XRPL Wallet Manager is running'), h('p', null, `It has ${n} wallet${n === 1 ? '' : 's'} you can bring over. Nothing is deleted there.`)), b));
      });
      go.replaceChildren(icon('upload', 14), 'Restore');
      go.disabled = !incoming?.wallets.length;
      return;
    }
    go.disabled = false;
  }

  /* --------------------------------- actions ------------------------------- */

  async function run(job: () => Promise<{ added: number; skipped: number; unreadable: number }>) {
    try {
      const r = await job();
      const parts = [`Added ${r.added} wallet${r.added === 1 ? '' : 's'}`];
      if (r.skipped) parts.push(`${r.skipped} already here`);
      if (r.unreadable) parts.push(`${r.unreadable} couldn’t be read`);
      ctx.toast(parts.join(' · '));
      m.close();
      ctx.open(null);
    } catch (e) {
      msg.replaceChildren(note('error', errText(e)));
    }
  }

  /** Save new wallets; on mainnet the vault must be unlocked first (or created). */
  async function save(items: { label: string; group?: string; keys?: DerivedKeys; address?: string; autoLabel?: boolean }[]) {
    const real = NETWORKS[net].real;
    if (real && items.some((i) => i.keys) && !(await ensureUnlocked(store, 'Enter your vault password to encrypt the new mainnet keys.'))) return null;
    const made = await ctx.build(net, items);
    await store.mutate((d) => void d.wallets.push(...made));
    return made;
  }

  const actions: Record<Mode, () => Promise<void>> = {
    async create() {
      const count = Math.max(1, Math.min(10, Math.floor(Number(createCount.value) || 1)));
      const typed = createName.value.trim();
      const names = count === 1 ? [typed || createName.placeholder] : typed ? Array.from({ length: count }, (_, i) => `${typed} ${i + 1}`) : nextNames(store, net, count);
      const keyFormat = format;
      const items = names.map((label) => ({ label, group: createGroup.value, keys: generateKeys(keyFormat, keyFormat === 'seed' ? algorithm : 'secp256k1') }));
      const made = await save(items);
      if (!made) return;
      m.close();
      ctx.open(made.length === 1 ? made[0].id : null);
      ctx.toast(`Created ${made.length === 1 ? made[0].label : `${made.length} wallets`} on ${NETWORKS[net].name}`);
      if (!NETWORKS[net].real && fund.input.checked) for (const w of made) await ctx.fund(w);
    },

    async import() {
      const lines = bulk() ? secretLines() : [secretBox.value.trim()];
      if (!lines[0]) throw new Error('Paste a seed, recovery phrase or secret numbers.');
      const keys = lines.map((l) => deriveFromSecret(l, { derivationPath: derivation.value }));
      const fresh = keys.filter((k, i) => !store.find(k.address, net) && keys.findIndex((x) => x.address === k.address) === i);
      if (!fresh.length) throw new Error(`Already here: ${keys.map((k) => store.find(k.address, net)?.label ?? shortAddr(k.address)).join(', ')}.`);
      const base = importName.value.trim();
      const names = fresh.length === 1 ? [base || importName.placeholder] : base ? fresh.map((_, i) => `${base} ${i + 1}`) : nextNames(store, net, fresh.length);
      const made = await save(fresh.map((k, i) => ({ label: names[i], group: importGroup.value, keys: k })));
      if (!made) return;
      m.close();
      ctx.open(made.length === 1 ? made[0].id : null);
      ctx.toast(`Imported ${made.length === 1 ? made[0].label : `${made.length} wallets`}${keys.length > fresh.length ? ` (${keys.length - fresh.length} already here)` : ''}`);
    },

    async watch() {
      const address = normalizeAddress(watchAddr.value);
      if (!address) throw new Error('That isn’t a valid XRP Ledger address.');
      const dup = store.find(address, net);
      if (dup) throw new Error(`Already here as “${dup.label}”.`);
      const typed = watchName.value.trim();
      const made = await save([{ label: typed || watchLabel(address), group: watchGroup.value, address, autoLabel: !typed }]);
      if (!made) return;
      m.close();
      ctx.open(made[0].id);
    },

    async restore() {
      if (!incoming) throw new Error('Choose a backup file first.');
      const inc = incoming;
      await run(() => importIncoming(ctx, inc, askPassword));
    },
  };

  go.onclick = () =>
    void withBusy(go, 'Working…', async () => {
      clear(msg);
      m.busy(true);
      try {
        await actions[mode]();
      } catch (e) {
        msg.replaceChildren(note('error', errText(e)));
      } finally {
        m.busy(false);
      }
    });

  m.body.append(modes, content, datalist(groupsId, store.groups().map((g) => ({ value: g }))), msg);
  m.foot.append(h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Cancel'), go);
  paint();
  setTimeout(() => (mode === 'import' ? secretBox : mode === 'watch' ? watchAddr : createName).focus());
}

/** Password of the vault a backup came from (when it differs from this one). */
function askPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal('Backup password', 'This backup’s mainnet keys were encrypted with a different vault password.', { onClose: () => !done && resolve(null) });
    const pw = input({ type: 'password', autocomplete: 'off', placeholder: 'The password used when the backup was made' });
    const ok = h(
      'button',
      {
        class: 'btn primary',
        onclick: () => {
          done = true;
          m.close();
          resolve(pw.value);
        },
      },
      'Continue',
    );
    pw.addEventListener('keydown', (e) => e.key === 'Enter' && ok.click());
    m.body.append(field('Backup’s vault password', pw));
    m.foot.append(h('button', { class: 'btn', onclick: m.close }, 'Cancel'), ok);
    setTimeout(() => pw.focus());
  });
}
