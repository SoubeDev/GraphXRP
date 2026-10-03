/** Send XRP or a token from one of your wallets, with checks before anything is signed. */
import { h, clear } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { fmtNum, shortAddr } from '../../xrpl/amount';
import type { Ctx } from '../index';
import { NETWORKS, explorerUrl } from '../networks';
import { TxError, encodeCurrency, tokenValue, xrpToDrops } from '../ledger';
import { normalizeAddress } from '../keys';
import type { StoredWallet } from '../types';
import { datalist, errText, field, input, modal, netPill, note } from './kit';
import { runTx } from './tx';

interface Asset {
  key: string;
  label: string;
  /** Raw currency code; undefined for XRP. */
  code?: string;
  issuer?: string;
  balance?: number;
  /** Issuing your own token: the currency is typed in. */
  issue?: boolean;
}

const TF_SET_NO_RIPPLE = 0x00020000;
const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

export function openSend(ctx: Ctx, w: StoredWallet, preset: { code?: string; issuer?: string; to?: string } = {}) {
  const { store, ledger } = ctx;
  const net = w.networkId;
  const real = NETWORKS[net].real;
  const d = ledger.session(net).loader.loaded.get(w.address);
  const info = ledger.cached(net, w.address);

  const assets: Asset[] = [{ key: 'XRP', label: 'XRP' }];
  for (const l of d?.lines ?? []) {
    if (l.balance > 0) assets.push({ key: `${l.code}|${l.peer}`, label: `${l.currency} · ${ctx.name(net, l.peer)}`, code: l.code, issuer: l.peer, balance: l.balance });
  }
  const issuedCodes = new Map<string, string>();
  for (const l of d?.lines ?? []) if (l.balance < 0) issuedCodes.set(l.code, l.currency);
  for (const [code, currency] of issuedCodes) assets.push({ key: `${code}|${w.address}`, label: `${currency} · issue your own`, code, issuer: w.address });
  assets.push({ key: 'issue', label: 'Issue a token…', issue: true });

  const m = modal(`Send from ${w.label}`, undefined);
  m.dlg.querySelector('.wd-head h2')?.append(' ', netPill(net));

  const listId = `w-send-to-${w.id}`;
  const others = store.onNetwork(net).filter((x) => x.id !== w.id);
  const to = input({ placeholder: 'Address (r…) or one of your wallets', list: listId, value: preset.to ?? '' });
  const toInfo = h('span');
  const amount = input({ placeholder: '0.00', inputmode: 'decimal' });
  const assetSel = h('select', { class: 'w-input', 'aria-label': 'Currency' }, ...assets.map((a) => h('option', { value: a.key }, a.label)));
  const presetKey = preset.code && preset.issuer ? `${preset.code}|${preset.issuer}` : '';
  if (assets.some((a) => a.key === presetKey)) assetSel.value = presetKey;
  const issueCode = input({ placeholder: 'Currency code, e.g. USD', maxlength: '40' });
  const issueRow = field('Token to issue', issueCode, 'The recipient needs a trust line to this wallet for it.');
  const tag = input({ placeholder: 'Optional', inputmode: 'numeric' });
  const memo = input({ placeholder: 'Optional, visible to everyone', maxlength: '200' });
  const avail = h('span', { class: 'w-hint' });
  const check = h('div');
  const msg = h('div');
  const go = h('button', { class: 'btn primary', type: 'button' });

  const asset = () => assets.find((a) => a.key === assetSel.value) ?? assets[0];
  const reserve = () => {
    const r = ledger.reserve(net);
    return r.base + (info?.ownerCount ?? d?.ownerCount ?? 0) * r.inc;
  };
  const maxXrp = () => Math.max(0, Math.floor(((info?.balance ?? d?.balance ?? 0) - reserve() - 0.0001) * 1e6) / 1e6);

  const recipient = (): { address: string; mine?: StoredWallet } | null => {
    const v = to.value.trim();
    if (!v) return null;
    const mine = others.find((x) => x.label.toLowerCase() === v.toLowerCase());
    if (mine) return { address: mine.address, mine };
    const address = normalizeAddress(v);
    return address ? { address, mine: store.find(address, net) } : null;
  };

  const paintAsset = () => {
    const a = asset();
    issueRow.style.display = a.issue ? '' : 'none';
    clear(avail);
    if (!a.code && !a.issue) {
      const max = maxXrp();
      avail.append(`${fmtNum(max)} XRP available · `, h('button', { class: 'link', type: 'button', onclick: () => ((amount.value = String(max)), schedule()) }, 'Max'));
    } else if (a.balance != null) {
      avail.append(`${fmtNum(a.balance)} available · `, h('button', { class: 'link', type: 'button', onclick: () => ((amount.value = String(a.balance)), schedule()) }, 'Max'));
    } else avail.append('As the issuer, you can send any amount.');
  };

  const paintTo = () => {
    const r = recipient();
    const v = to.value.trim();
    toInfo.textContent = !v ? '' : !r ? 'Not a valid address or wallet name.' : r.address === w.address ? 'That’s this wallet.' : r.mine ? `→ ${r.mine.label} (your wallet) · ${shortAddr(r.address)}` : real && ctx.app.dir.get(r.address).name ? `→ ${ctx.app.dir.label(r.address)}` : '';
  };

  /** What the form currently describes, or an error message. */
  const read = (): { error: string } | { dest: string; mine?: StoredWallet; amt: number; a: Asset; code?: string; issuer?: string; tagN?: number } => {
    const r = recipient();
    if (!r) return { error: 'Enter a destination address or the name of one of your wallets.' };
    if (r.address === w.address) return { error: 'You can’t send to the same wallet.' };
    const amt = Number(amount.value.replace(/[,_\s]/g, ''));
    if (!(amt > 0)) return { error: 'Enter an amount.' };
    const a = asset();
    let code = a.code;
    const issuer = a.issue ? w.address : a.issuer;
    if (a.issue) {
      try {
        code = encodeCurrency(issueCode.value);
      } catch (e) {
        return { error: errText(e) };
      }
    }
    if (!code && amt > maxXrp()) return { error: `That’s more than the ${fmtNum(maxXrp())} XRP available (the reserve stays locked).` };
    if (a.balance != null && issuer !== w.address && amt > a.balance) return { error: `That’s more than the ${fmtNum(a.balance)} you hold.` };
    let tagN: number | undefined;
    if (tag.value.trim()) {
      tagN = Number(tag.value.trim());
      if (!Number.isInteger(tagN) || tagN < 0 || tagN > 4294967295) return { error: 'A destination tag is a whole number from 0 to 4294967295.' };
    }
    return { dest: r.address, mine: r.mine, amt, a, code, issuer, tagN };
  };

  let timer = 0;
  let checkSeq = 0;
  let blocked = false;
  const schedule = () => {
    paintTo();
    clearTimeout(timer);
    timer = window.setTimeout(runCheck, 350);
  };
  async function runCheck() {
    const seq = ++checkSeq;
    const f = read();
    clear(check);
    blocked = false;
    if ('error' in f) return;
    const res = await ledger.checkDestination(net, f.dest, { xrp: f.code ? undefined : f.amt, code: f.code, issuer: f.issuer, value: f.amt }, f.tagN).catch(() => ({ level: 'ok' as const, text: undefined, missingLine: false }));
    if (seq !== checkSeq) return;
    blocked = res.level === 'error';
    if (res.level === 'ok' || !res.text) return;
    const fix =
      res.missingLine && f.mine && !f.mine.watchOnly && f.code && f.issuer
        ? h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: async (e: Event) => {
                const b = e.currentTarget as HTMLButtonElement;
                b.disabled = true;
                const cur = f.a.issue ? issueCode.value.trim() : (f.a.label.split(' · ')[0] ?? 'token');
                const ok = await runTx(ctx, f.mine!, { TransactionType: 'TrustSet', LimitAmount: { currency: f.code!, issuer: f.issuer!, value: '1000000000' }, Flags: TF_SET_NO_RIPPLE }, `Trust line for ${cur} on ${f.mine!.label}`);
                b.disabled = false;
                if (ok) void runCheck();
              },
            },
            icon('link', 13),
            `Add the trust line on ${f.mine.label}`,
          )
        : null;
    check.append(note(res.level, [res.text, fix ? h('div', { class: 'w-fix' }, fix) : null]));
  }

  for (const el of [to, amount, tag, issueCode]) el.addEventListener('input', schedule);
  assetSel.addEventListener('change', () => {
    paintAsset();
    schedule();
  });

  const form = h(
    'div',
    { class: 'w-form' },
    field('To', to, toInfo),
    datalist(listId, others.map((x) => ({ value: x.label, label: x.address }))),
    h('div', { class: 'w-field' }, h('span', { class: 'w-label' }, 'Amount'), h('div', { class: 'w-amount' }, amount, assetSel), avail),
    issueRow,
    h('div', { class: 'w-field-row' }, field('Destination tag', tag), field('Memo', memo)),
    check,
    msg,
  );
  m.body.append(form);
  const cancel = h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Cancel');
  m.foot.append(cancel, go);
  go.append(icon('send', 14), real ? 'Review' : 'Send');
  paintAsset();
  paintTo();
  setTimeout(() => (preset.to ? amount : to).focus());

  go.onclick = async () => {
    clear(msg);
    const f = read();
    if ('error' in f) return msg.replaceChildren(note('error', f.error));
    if (blocked) return msg.replaceChildren(note('error', 'Fix the problem above first.'));
    const curLabel = f.code ? (f.a.issue ? issueCode.value.trim() : f.a.label.split(' · ')[0]) : 'XRP';
    const toName = f.mine?.label ?? ctx.name(net, f.dest);
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Destination: f.dest,
      Amount: f.code ? { currency: f.code, issuer: f.issuer, value: tokenValue(f.amt) } : xrpToDrops(f.amt),
    };
    if (f.tagN != null) tx.DestinationTag = f.tagN;
    if (memo.value.trim()) tx.Memos = [{ Memo: { MemoType: hex('text/plain'), MemoData: hex(memo.value.trim()) } }];
    const summary = `${fmtNum(f.amt)} ${curLabel} to ${toName}`;

    if (real && !(await review(summary, f.dest))) return;
    const secrets = await ctx.secrets(w, `Enter your vault password to send from “${w.label}”.`);
    if (!secrets) return;

    m.busy(true);
    form.classList.add('w-dim-form');
    go.disabled = true;
    cancel.disabled = true;
    const status = h('span', { class: 'w-status' }, h('span', { class: 'spinner', style: { marginLeft: '0' } }), 'Preparing…');
    m.foot.prepend(status);
    try {
      const t = await ledger.submit(w, secrets, tx, (s) => (status.lastChild!.textContent = s));
      m.busy(false);
      done(summary, t.hash);
    } catch (e) {
      m.busy(false);
      status.remove();
      form.classList.remove('w-dim-form');
      go.disabled = false;
      cancel.disabled = false;
      const hash = e instanceof TxError ? e.hash : undefined;
      msg.replaceChildren(note('error', [errText(e), hash ? [' ', h('a', { href: explorerUrl(net, 'tx', hash), target: '_blank', rel: 'noopener' }, 'Details', icon('external', 10))] : null]));
    }
  };

  /** Mainnet: one more look before signing. */
  function review(summary: string, dest: string): Promise<boolean> {
    return new Promise((resolve) => {
      const saved = [...m.body.childNodes];
      const savedFoot = [...m.foot.childNodes];
      const restore = () => {
        m.body.replaceChildren(...saved);
        m.foot.replaceChildren(...savedFoot);
      };
      m.body.replaceChildren(
        h(
          'div',
          { class: 'w-review' },
          h('div', { class: 'w-review-big' }, summary),
          h('div', { class: 'w-review-line mono' }, dest),
          tag.value.trim() ? h('div', { class: 'w-review-line' }, `Destination tag ${tag.value.trim()}`) : null,
          memo.value.trim() ? h('div', { class: 'w-review-line' }, `Memo: ${memo.value.trim()}`) : null,
          h('div', { class: 'w-review-line muted' }, 'Network fee: about 0.00001 XRP'),
        ),
        note('warn', 'This sends real XRP Ledger funds on mainnet. It can’t be undone. Check the address.'),
      );
      m.foot.replaceChildren(
        h('button', { class: 'btn', type: 'button', onclick: () => (restore(), resolve(false)) }, 'Back'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => (restore(), resolve(true)) }, icon('key', 14), 'Sign and send on Mainnet'),
      );
    });
  }

  function done(summary: string, hash: string) {
    m.body.replaceChildren(
      h(
        'div',
        { class: 'w-done' },
        h('span', { class: 'w-done-ico' }, icon('checkCircle', 26)),
        h('h3', null, 'Sent'),
        h('p', null, summary),
        h('a', { class: 'link', href: explorerUrl(net, 'tx', hash), target: '_blank', rel: 'noopener' }, 'View the transaction', icon('external', 11)),
      ),
    );
    m.foot.replaceChildren(
      h('button', { class: 'btn', type: 'button', onclick: () => (m.close(), openSend(ctx, w)) }, 'Send another'),
      h('button', { class: 'btn primary', type: 'button', onclick: m.close }, 'Done'),
    );
  }
}
