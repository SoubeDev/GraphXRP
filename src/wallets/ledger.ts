/**
 * Talking to the networks wallets live on: one connection per network (mainnet
 * shares the explorer's), live account streams, the faucet, and signing.
 */
import type { App } from '../app';
import { XrplClient, XrplError } from '../xrpl/client';
import { Loader, type AccountData } from '../xrpl/loader';
import { parseTx, type ParsedTx } from '../xrpl/parse';
import { F, has } from '../xrpl/flags';
import { NETWORKS, NETWORK_IDS, type NetworkId } from './networks';
import { signerFrom } from './keys';
import type { Secrets, StoredWallet } from './types';

export interface Session {
  net: NetworkId;
  client: XrplClient;
  loader: Loader;
}

export interface AccountInfo {
  exists: boolean;
  balance: number;
  ownerCount: number;
  flags: number;
}

export class TxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hash?: string,
  ) {
    super(message);
  }
}

const HINTS: Record<string, string> = {
  tecUNFUNDED_PAYMENT: 'Not enough XRP to cover the amount and the reserve.',
  tecUNFUNDED_OFFER: 'The offer isn’t funded.',
  tecNO_DST: 'The destination account doesn’t exist yet.',
  tecNO_DST_INSUF_XRP: 'The destination doesn’t exist, and the amount is too small to create it.',
  tecDST_TAG_NEEDED: 'The destination requires a destination tag.',
  tecPATH_DRY: 'No way to deliver this: check trust lines and balances.',
  tecPATH_PARTIAL: 'Only part could be delivered (the issuer may charge a transfer fee).',
  tecNO_LINE: 'The destination has no trust line for this token.',
  tecNO_LINE_INSUF_RESERVE: 'Not enough XRP reserve to open a trust line.',
  tecINSUF_RESERVE_LINE: 'Not enough XRP reserve to hold another trust line.',
  tecINSUFFICIENT_RESERVE: 'This would put the account below its XRP reserve.',
  tecNO_AUTH: 'The issuer must approve this trust line first.',
  tecNO_PERMISSION: 'This account isn’t allowed to do that.',
  tecNO_ISSUER: 'The token issuer doesn’t exist.',
  tecFROZEN: 'The trust line or token is frozen.',
  tefPAST_SEQ: 'Sequence number already used. Try again.',
  tefMAX_LEDGER: 'The transaction expired before the ledger included it.',
  temBAD_AMOUNT: 'The amount is invalid.',
  temREDUNDANT: 'That would do nothing (for example, sending to yourself).',
  temDST_IS_SRC: 'The destination is the same as the sender.',
  temBAD_CURRENCY: 'Invalid currency code.',
  temDISABLED: 'That feature isn’t enabled on this network.',
  telINSUF_FEE_P: 'The network is busy and the fee was too low. Try again.',
};

export const describeResult = (code: string, fallback?: string) => HINTS[code] ?? fallback ?? code;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Highest fee we'll pay without asking (drops). Normal fees are 10–15 drops. */
const MAX_FEE_DROPS = 5000;

export class Ledger {
  private sessions = new Map<NetworkId, Session>();
  /** Hashes submitted from here, so the live stream doesn't announce them twice. */
  private local = new Set<string>();
  private watched = new Map<NetworkId, Set<string>>();
  private listeners = new Set<() => void>();
  private txListeners = new Set<(net: NetworkId, t: ParsedTx, touched: string[]) => void>();
  private pendingInfo = new Map<string, Promise<AccountInfo | null>>();
  /** Debounced re-reads after live activity, and recent activity per account (busy ones re-read less often). */
  private timers = new Map<string, number>();
  private lastRead = new Map<string, number>();
  private hits = new Map<string, number[]>();
  /** Latest balance per `${net}:${address}`; null = not activated. */
  readonly info = new Map<string, AccountInfo | null>();

  constructor(private app: App) {}

  session(net: NetworkId): Session {
    let s = this.sessions.get(net);
    if (s) return s;
    if (net === 'mainnet') s = { net, client: this.app.client, loader: this.app.loader };
    else {
      const client = new XrplClient(NETWORKS[net].servers);
      client.start();
      s = { net, client, loader: new Loader(client) };
    }
    s.client.onTransaction((msg) => this.onStream(net, msg));
    this.sessions.set(net, s);
    return s;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onTx(fn: (net: NetworkId, t: ParsedTx, touched: string[]) => void): () => void {
    this.txListeners.add(fn);
    return () => this.txListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Stream live transactions for these accounts. Networks without wallets never connect. */
  watch(byNet: Map<NetworkId, string[]>) {
    for (const net of NETWORK_IDS) {
      const list = byNet.get(net) ?? [];
      this.watched.set(net, new Set(list));
      if (list.length || this.sessions.has(net)) this.session(net).client.watchAccounts(list);
    }
  }

  private onStream(net: NetworkId, msg: any) {
    const tx = msg.transaction ?? msg.tx_json;
    if (!tx) return;
    const t = parseTx({ tx: { ...tx, hash: tx.hash ?? msg.hash }, meta: msg.meta, ledger_index: msg.ledger_index, close_time_iso: msg.close_time_iso });
    if (!t.date) t.date = Date.now();
    const mine = this.watched.get(net) ?? new Set();
    const touched = [...affected(t)].filter((a) => mine.has(a));
    if (!touched.length) return;
    for (const a of touched) this.absorb(net, a, t);
    if (this.local.has(t.hash)) return;
    for (const fn of this.txListeners) fn(net, t, touched);
  }

  /**
   * Live activity on an account: show the transaction right away, then re-read
   * balances and trust lines shortly after. Busy accounts (a token issuer, say)
   * are re-read at most every 30 s so they don't flood the server.
   */
  private absorb(net: NetworkId, address: string, t: ParsedTx) {
    const key = `${net}:${address}`;
    const d = this.session(net).loader.loaded.get(address);
    if (d && !d.txs.some((x) => x.hash === t.hash)) d.txs.unshift(t);
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((ms) => now - ms < 30_000);
    recent.push(now);
    this.hits.set(key, recent);
    this.emit();
    if (this.timers.has(key)) return;
    const gap = recent.length > 3 ? 30_000 : 3000;
    const wait = Math.max(1200, (this.lastRead.get(key) ?? 0) + gap - now);
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        this.lastRead.set(key, Date.now());
        void this.refresh(net, address);
      }, wait),
    );
  }

  /* ----------------------------- reading ----------------------------- */

  cached(net: NetworkId, address: string): AccountInfo | null | undefined {
    return this.info.get(`${net}:${address}`);
  }

  /** Balance and settings (cheap; used by the wallet list). */
  accountInfo(net: NetworkId, address: string, force = false): Promise<AccountInfo | null> {
    const key = `${net}:${address}`;
    const pending = this.pendingInfo.get(key);
    if (pending && !force) return pending;
    const p = this.session(net)
      .client.request('account_info', { account: address, ledger_index: 'validated' }, 25000, !force)
      .then(
        (r): AccountInfo => ({ exists: true, balance: Number(r.account_data.Balance) / 1e6, ownerCount: Number(r.account_data.OwnerCount ?? 0), flags: Number(r.account_data.Flags ?? 0) }),
        (e: XrplError) => {
          if (e.code === 'actNotFound') return null;
          throw e;
        },
      )
      .then((v) => {
        this.info.set(key, v);
        this.emit();
        return v;
      })
      .finally(() => this.pendingInfo.delete(key));
    this.pendingInfo.set(key, p);
    return p;
  }

  /** Everything the detail view shows: history, trust lines, settings. Null if not activated. */
  async account(net: NetworkId, address: string, force = false): Promise<AccountData | null> {
    try {
      return await this.session(net).loader.account(address, force);
    } catch (e) {
      if ((e as XrplError).code === 'actNotFound') return null;
      throw e;
    }
  }

  /** Something happened to this account: re-read it (and let the map know on mainnet). */
  async refresh(net: NetworkId, address: string) {
    const s = this.session(net);
    await this.accountInfo(net, address, true).catch(() => {});
    if (s.loader.loaded.has(address) || net !== 'mainnet') {
      await s.loader.account(address, true).catch(() => {});
    }
    if (net === 'mainnet') {
      this.app.syncNode(address);
      this.app.emit('account', address);
    }
    this.emit();
  }

  reserve(net: NetworkId) {
    const c = this.session(net).client;
    return { base: c.reserveBase, inc: c.reserveInc };
  }

  /* ------------------------------ faucet ------------------------------ */

  async fund(net: NetworkId, address: string): Promise<number | undefined> {
    const url = NETWORKS[net].faucet;
    if (!url) throw new Error(`${NETWORKS[net].name} has no faucet.`);
    const before = (await this.accountInfo(net, address, true).catch(() => null))?.balance ?? 0;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: address, userAgent: 'graphxrp' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(res.status === 429 ? 'The faucet is rate-limiting. Wait a minute and try again.' : `The faucet said ${res.status}${text ? `: ${text.slice(0, 140)}` : ''}`);
    }
    const body = (await res.json().catch(() => ({}))) as { amount?: number; transactionHash?: string };
    if (body.transactionHash) this.local.add(body.transactionHash);
    // The funding payment usually validates within a few ledgers.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const now = await this.accountInfo(net, address, true).catch(() => null);
      if (now && now.balance > before) break;
    }
    await this.refresh(net, address);
    return body.amount;
  }

  /* ----------------------------- preflight ---------------------------- */

  /** Problems with sending to `dest` that the ledger would reject (or that are worth a heads-up). */
  async checkDestination(net: NetworkId, dest: string, amount: { xrp?: number; code?: string; issuer?: string; value?: number }, tag?: number): Promise<{ level: 'ok' | 'warn' | 'error'; text?: string; missingLine?: boolean }> {
    const { client } = this.session(net);
    let info: any;
    try {
      info = (await client.request('account_info', { account: dest, ledger_index: 'validated' })).account_data;
    } catch (e) {
      if ((e as XrplError).code !== 'actNotFound') return { level: 'ok' };
      const base = client.reserveBase;
      if (amount.code) return { level: 'error', text: 'That account doesn’t exist yet, so it can’t hold tokens. Send it some XRP first.' };
      if ((amount.xrp ?? 0) < base) return { level: 'error', text: `That account isn’t activated yet. Send at least ${base} XRP to create it.` };
      return { level: 'warn', text: `That account doesn’t exist yet. This payment will create it (${base} XRP stays locked as its reserve).` };
    }
    const flags = Number(info.Flags ?? 0);
    if (has(flags, F.RequireDestTag) && tag == null) return { level: 'error', text: 'The destination requires a destination tag (exchanges use it to tell customers apart).' };
    if (has(flags, F.DepositAuth)) return { level: 'warn', text: 'The destination only accepts payments from senders it has approved.' };
    if (amount.code && amount.issuer && dest !== amount.issuer) {
      const lines = await client.request('account_lines', { account: dest, peer: amount.issuer, ledger_index: 'validated' }).catch(() => null);
      const line = lines?.lines?.find((l: any) => l.currency === amount.code);
      if (!line) return { level: 'error', text: 'The destination hasn’t opted in to this token (no trust line).', missingLine: true };
      const room = Number(line.limit) - Number(line.balance);
      if (amount.value != null && amount.value > room) return { level: 'warn', text: `The destination’s trust line only has room for ${room} more.` };
    }
    if (!amount.code && has(flags, F.DisallowXRP)) return { level: 'warn', text: 'The destination asked not to receive XRP (a request, not a hard block).' };
    return { level: 'ok' };
  }

  /* ------------------------------ signing ----------------------------- */

  /**
   * Fill in, sign and submit a transaction, then wait until a validated ledger
   * includes it. Rejects with a TxError explaining any failure.
   */
  async submit(w: StoredWallet, secrets: Secrets, tx: Record<string, unknown>, step: (text: string) => void = () => {}): Promise<ParsedTx> {
    const { client } = this.session(w.networkId);
    step('Preparing…');
    const [info, fee] = await Promise.all([client.request('account_info', { account: w.address, ledger_index: 'current' }), client.request('fee')]);
    const base = Number(fee.drops?.base_fee ?? 10);
    const open = Number(fee.drops?.open_ledger_fee ?? base);
    const feeDrops = Math.max(base, Math.ceil(open * 1.1));
    if (feeDrops > MAX_FEE_DROPS) throw new TxError('fee', `The network is very busy (fee ${feeDrops / 1e6} XRP). Try again in a moment.`);
    const prepared = {
      ...tx,
      Account: w.address,
      Sequence: info.account_data.Sequence,
      Fee: String(feeDrops),
      LastLedgerSequence: Number(info.ledger_current_index) + 20,
    };
    const signer = signerFrom(w.publicKey, secrets);
    if (signer.classicAddress !== w.address) throw new TxError('keys', 'The stored keys don’t belong to this address.');
    step('Signing…');
    const { tx_blob, hash } = signer.sign(prepared as never);
    this.local.add(hash);
    step('Submitting…');
    const r = await client.request('submit', { tx_blob });
    const prelim: string = r.engine_result;
    if (/^(tem|tef|tel)/.test(prelim)) throw new TxError(prelim, describeResult(prelim, r.engine_result_message), hash);
    step('Waiting for the ledger to confirm…');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(1200);
      try {
        const res = await client.request('tx', { transaction: hash });
        if (res.validated) {
          const t = parseTx(res);
          void this.refresh(w.networkId, w.address);
          if (!t.success) throw new TxError(t.result, describeResult(t.result), hash);
          return t;
        }
      } catch (e) {
        if (e instanceof TxError) throw e;
        if ((e as XrplError).code !== 'txnNotFound') throw e;
      }
      if (client.ledgerIndex > prepared.LastLedgerSequence) throw new TxError('tefMAX_LEDGER', describeResult('tefMAX_LEDGER'), hash);
    }
    throw new TxError('timeout', 'Timed out waiting for the ledger to confirm.', hash);
  }
}

/** Every account a transaction touched (sender, destination, balances and trust lines it changed). */
function affected(t: ParsedTx): Set<string> {
  const out = new Set<string>([t.account]);
  if (t.destination) out.add(t.destination);
  for (const f of t.flows) {
    out.add(f.from);
    out.add(f.to);
  }
  for (const wrap of t.meta?.AffectedNodes ?? []) {
    const n: any = Object.values(wrap)[0];
    const f = n?.FinalFields ?? n?.NewFields ?? {};
    if (n?.LedgerEntryType === 'AccountRoot' && f.Account) out.add(f.Account);
    if (n?.LedgerEntryType === 'RippleState') {
      if (f.HighLimit?.issuer) out.add(f.HighLimit.issuer);
      if (f.LowLimit?.issuer) out.add(f.LowLimit.issuer);
    }
  }
  return out;
}

/* ------------------------------ amounts ------------------------------ */

/** Currency code as the ledger wants it: 3 characters, or 40 hex digits for longer names. */
export function encodeCurrency(code: string): string {
  const c = code.trim();
  if (/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  if (c.length === 3 && c.toUpperCase() !== 'XRP' && /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(c)) return c;
  const bytes = new TextEncoder().encode(c);
  if (!bytes.length || bytes.length > 20 || c.toUpperCase() === 'XRP') throw new Error('Use a 3-character code (like USD) or a name up to 20 bytes.');
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().padEnd(40, '0');
}

/** Decimal string for a token amount (at most 15 significant digits). */
export const tokenValue = (v: number) => String(Number(v.toPrecision(15)));

export const xrpToDrops = (xrp: number) => String(Math.round(xrp * 1e6));
