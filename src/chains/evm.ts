/**
 * XRPL EVM Sidechain, read through its public Blockscout explorer API.
 * Turns transactions and token transfers into graph flows, and decodes the
 * Axelar messages that move value to and from the XRP Ledger.
 */
import type { Amt } from '../xrpl/amount';
import type { Flow } from '../xrpl/parse';
import type { CrossChain } from '../bridges/decode';
import { extId } from '../bridges/registry';
import { nodeId, rawAddress } from './chains';

const API = 'https://explorer.xrplevm.org/api/v2';

/** Blockscout's pseudo-address for the chain's native coin (XRP) shown as a token. */
export const EVM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/** Axelar's Interchain Token Service: the same address on every EVM chain. */
export const AXELAR_ITS = '0xb5fb4be02232b1bba4dc8f81dc24c26980de9e3c';
/** Axelar's token id for XRP (observed in deliveries from the XRP Ledger). */
const XRP_TOKEN_ID = 'ba5a21ca88ef6bba2bfff5088994f90e1077e2a1cc3dcc38bd261f00fce2824f';
const ZERO = '0x0000000000000000000000000000000000000000';

export const KNOWN_EVM: Record<string, string> = {
  [AXELAR_ITS]: 'Axelar Interchain Token Service',
};

export const evmId = (address: string) => nodeId('xrpl-evm', address);

export interface EvmToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  type: string;
}

export interface EvmEvent {
  hash: string;
  date: number;
  success: boolean;
  method?: string;
  kind: 'native' | 'token' | 'call' | 'bridge-out' | 'bridge-in' | 'mint' | 'burn';
  from: string;
  to: string;
  amount: Amt | null;
  cross: CrossChain | null;
  flows: Flow[];
  /** Index within the transaction, to keep flow keys unique. */
  part: number;
}

export interface EvmInfo {
  exists: boolean;
  balance: number;
  isContract: boolean;
  verified: boolean;
  name?: string;
  tags: string[];
  token?: { symbol: string; name: string; type: string; holders?: number; supply?: number };
}

export interface EvmAccount extends EvmInfo {
  id: string;
  address: string;
  events: EvmEvent[];
  holdings: { token: EvmToken; value: number }[];
  txNext?: Record<string, unknown> | null;
  ttNext?: Record<string, unknown> | null;
  done: boolean;
}

/* ------------------------------------------------------------------ */
/* Blockscout HTTP client                                              */
/* ------------------------------------------------------------------ */

class Blockscout {
  private active = 0;
  private queue: (() => void)[] = [];

  async get(path: string, params?: Record<string, unknown> | null): Promise<any> {
    await this.slot();
    try {
      const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}` : '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        try {
          const r = await fetch(`${API}${path}${qs}`, { signal: ctl.signal });
          if (r.status === 404) return null;
          if (r.status === 429) {
            const wait = Math.min(Number(r.headers.get('x-ratelimit-reset')) || 2000, 15000);
            await new Promise((ok) => setTimeout(ok, wait));
            continue;
          }
          if (!r.ok) throw new Error(`XRPL EVM explorer answered ${r.status}`);
          return await r.json();
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error('XRPL EVM explorer is rate limiting; try again shortly.');
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private slot(): Promise<void> {
    if (this.active < 4) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((ok) =>
      this.queue.push(() => {
        this.active++;
        ok();
      }),
    );
  }
}

/* ------------------------------------------------------------------ */
/* ABI decoding for Axelar ITS messages                                */
/* ------------------------------------------------------------------ */

function hexBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function word(b: Uint8Array, off: number): bigint {
  return BigInt(`0x${toHex(b.subarray(off, off + 32)) || '0'}`);
}

/** A dynamic `bytes`/`string` value whose offset sits at `base + head`. */
function dyn(b: Uint8Array, base: number, head: number): Uint8Array {
  const start = base + Number(word(b, base + head));
  const len = Number(word(b, start));
  return b.subarray(start + 32, start + 32 + len);
}

export interface ItsTransfer {
  sourceChain?: string;
  sourceAddress: string;
  destination: string;
  amount: bigint;
  tokenId: string;
}

/**
 * ITS payloads: a hub wrapper (type 4, RECEIVE_FROM_HUB: original source chain +
 * inner payload) around an INTERCHAIN_TRANSFER (type 0: tokenId, source address,
 * destination address, amount, data).
 */
export function decodeItsPayload(payloadHex: string): ItsTransfer | null {
  try {
    const b = hexBytes(payloadHex);
    let inner = b;
    let sourceChain: string | undefined;
    if (Number(word(b, 0)) === 4) {
      sourceChain = new TextDecoder().decode(dyn(b, 0, 32));
      inner = dyn(b, 0, 64);
    }
    if (Number(word(inner, 0)) !== 0) return null;
    const src = dyn(inner, 0, 64);
    const dst = dyn(inner, 0, 96);
    const ascii = new TextDecoder().decode(src);
    return {
      sourceChain,
      sourceAddress: /^[\x21-\x7e]+$/.test(ascii) ? ascii : `0x${toHex(src)}`,
      destination: dst.length === 20 ? `0x${toHex(dst)}` : new TextDecoder().decode(dst),
      amount: word(inner, 128),
      tokenId: toHex(inner.subarray(32, 64)),
    };
  } catch {
    return null;
  }
}

const decodeAscii = (hex: string) => {
  try {
    const s = new TextDecoder().decode(hexBytes(hex));
    return /^[\x21-\x7e]+$/.test(s) ? s : hex;
  } catch {
    return hex;
  }
};

function remoteNode(chain: string, address: string): string {
  return chain === 'xrpl' ? address : extId(chain, /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address);
}

const fromWei = (v: string | number | bigint | undefined, decimals = 18): number => {
  if (v == null) return 0;
  try {
    const big = typeof v === 'bigint' ? v : BigInt(String(v).split('.')[0]);
    const scale = 10n ** BigInt(decimals);
    return Number(big / scale) + Number(big % scale) / Number(scale);
  } catch {
    return Number(v) / 10 ** decimals;
  }
};

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

const ARRIVALS_TO_DECODE = 12;

export class EvmLoader {
  readonly api = new Blockscout();
  readonly loaded = new Map<string, EvmAccount>();
  readonly probed = new Map<string, EvmInfo>();
  private accounts = new Map<string, Promise<EvmAccount>>();
  private probes = new Map<string, Promise<EvmInfo>>();
  private arrivals = new Map<string, Promise<ItsTransfer | null>>();

  account(id: string, force = false): Promise<EvmAccount> {
    const cached = this.accounts.get(id);
    if (cached && !force) return cached;
    const p = this.load(id).then((a) => {
      this.loaded.set(id, a);
      this.probed.set(id, a);
      return a;
    });
    this.accounts.set(id, p);
    p.catch(() => this.accounts.delete(id));
    return p;
  }

  probe(id: string): Promise<EvmInfo> {
    const cached = this.probes.get(id);
    if (cached) return cached;
    const p = this.api.get(`/addresses/${rawAddress(id)}`).then((info) => {
      const r = toInfo(id, info);
      this.probed.set(id, r);
      return r;
    });
    this.probes.set(id, p);
    p.catch(() => this.probes.delete(id));
    return p;
  }

  private async load(id: string): Promise<EvmAccount> {
    const a = rawAddress(id).toLowerCase();
    const [infoR, txR, ttR, balR] = await Promise.allSettled([
      this.api.get(`/addresses/${a}`),
      this.api.get(`/addresses/${a}/transactions`),
      this.api.get(`/addresses/${a}/token-transfers`),
      this.api.get(`/addresses/${a}/token-balances`),
    ]);
    if (infoR.status === 'rejected') throw infoR.reason;
    const acc: EvmAccount = {
      ...toInfo(id, infoR.value),
      id,
      address: a,
      events: [],
      holdings: [],
      done: false,
    };
    if (txR.status === 'fulfilled' && txR.value) {
      acc.events.push(...(txR.value.items ?? []).map((t: any) => txEvent(t)));
      acc.txNext = txR.value.next_page_params;
    }
    if (ttR.status === 'fulfilled' && ttR.value) {
      acc.events.push(...(ttR.value.items ?? []).map((t: any) => transferEvent(t)).filter((e: EvmEvent | null): e is EvmEvent => !!e));
      acc.ttNext = ttR.value.next_page_params;
    }
    if (balR.status === 'fulfilled' && Array.isArray(balR.value)) {
      acc.holdings = balR.value
        .filter((b: any) => b.token && (b.token.address_hash ?? b.token.address ?? '').toLowerCase() !== EVM_NATIVE)
        .map((b: any) => {
          const token = toToken(b.token);
          return { token, value: fromWei(b.value, token.decimals) };
        })
        .filter((h: { value: number }) => h.value > 0)
        .sort((x: { value: number }, y: { value: number }) => y.value - x.value);
    }
    acc.done = !acc.txNext && !acc.ttNext;
    acc.events.sort((x, y) => y.date - x.date);
    await this.decodeArrivals(acc.events);
    return acc;
  }

  async more(acc: EvmAccount): Promise<EvmEvent[]> {
    const page: EvmEvent[] = [];
    if (acc.txNext) {
      const r = await this.api.get(`/addresses/${acc.address}/transactions`, acc.txNext);
      page.push(...(r?.items ?? []).map((t: any) => txEvent(t)));
      acc.txNext = r?.next_page_params;
    }
    if (acc.ttNext) {
      const r = await this.api.get(`/addresses/${acc.address}/token-transfers`, acc.ttNext);
      page.push(...(r?.items ?? []).map((t: any) => transferEvent(t)).filter((e: EvmEvent | null): e is EvmEvent => !!e));
      acc.ttNext = r?.next_page_params;
    }
    await this.decodeArrivals(page);
    acc.events.push(...page);
    acc.events.sort((x, y) => y.date - x.date);
    acc.done = !acc.txNext && !acc.ttNext;
    return page;
  }

  /** Read who sent an Axelar delivery (and from which chain) out of the relayed message. */
  arrival(hash: string): Promise<ItsTransfer | null> {
    let p = this.arrivals.get(hash);
    if (!p) {
      p = this.api
        .get(`/transactions/${hash}`)
        .then((tx) => {
          const payload = (tx?.decoded_input?.parameters ?? []).find((x: any) => x.name === 'payload')?.value;
          return typeof payload === 'string' ? decodeItsPayload(payload) : null;
        })
        .catch(() => null);
      this.arrivals.set(hash, p);
    }
    return p;
  }

  /**
   * Token deliveries to an address, newest first, paging back until `since` (used to
   * confirm bridge transfers). `complete` says whether the search reached that far.
   */
  async deliveriesTo(
    address: string,
    since: number,
    pages = 6,
  ): Promise<{ items: { hash: string; date: number; value: bigint; token: string; method?: string; type?: string }[]; complete: boolean; oldest: number }> {
    const out: { hash: string; date: number; value: bigint; token: string; method?: string; type?: string }[] = [];
    let next: Record<string, unknown> | null | undefined;
    let oldest = Infinity;
    for (let i = 0; i < pages; i++) {
      const r = await this.api.get(`/addresses/${address.toLowerCase()}/token-transfers`, next ?? undefined);
      for (const t of r?.items ?? []) {
        oldest = Math.min(oldest, Date.parse(t.timestamp));
        if ((t.to?.hash ?? '').toLowerCase() !== address.toLowerCase()) continue;
        out.push({
          hash: t.transaction_hash,
          date: Date.parse(t.timestamp),
          value: BigInt(t.total?.value ?? 0),
          token: (t.token?.address_hash ?? t.token?.address ?? '').toLowerCase(),
          method: t.method ?? undefined,
          type: t.type,
        });
      }
      next = r?.next_page_params;
      if (!next || oldest < since) return { items: out, complete: true, oldest };
    }
    return { items: out, complete: false, oldest };
  }

  private async decodeArrivals(events: EvmEvent[]) {
    const pending = events.filter((e) => e.kind === 'bridge-in' && !e.cross).slice(0, ARRIVALS_TO_DECODE);
    await Promise.all(
      pending.map(async (e) => {
        const its = await this.arrival(e.hash);
        if (!its) return;
        const chain = (its.sourceChain ?? 'unknown').toLowerCase();
        const node = remoteNode(chain, its.sourceAddress);
        const amount: Amt | null = its.tokenId === XRP_TOKEN_ID ? { value: fromWei(its.amount), currency: 'XRP', isXrp: true } : e.amount;
        e.cross = { bridge: 'axelar', direction: 'in', chain, address: its.sourceAddress, node, local: e.to, amount, detail: 'delivered by Axelar' };
        e.flows.push({ from: node, to: e.to, type: 'crosschain', amount });
      }),
    );
  }
}

function toInfo(id: string, info: any): EvmInfo {
  if (!info) return { exists: false, balance: 0, isContract: false, verified: false, tags: [] };
  const raw = rawAddress(id).toLowerCase();
  const tags = ((info.metadata?.tags ?? []) as any[]).map((t) => t?.name).filter(Boolean);
  const tok = info.token;
  return {
    exists: true,
    balance: fromWei(info.coin_balance ?? 0),
    isContract: !!info.is_contract,
    verified: !!info.is_verified,
    name: KNOWN_EVM[raw] ?? info.name ?? info.ens_domain_name ?? undefined,
    tags,
    token: tok
      ? {
          symbol: tok.symbol ?? '?',
          name: tok.name ?? tok.symbol ?? 'Token',
          type: tok.type ?? 'token',
          holders: tok.holders_count != null ? Number(tok.holders_count) : tok.holders != null ? Number(tok.holders) : undefined,
          supply: tok.total_supply != null ? fromWei(tok.total_supply, Number(tok.decimals ?? 18)) : undefined,
        }
      : undefined,
  };
}

function toToken(t: any): EvmToken {
  return {
    address: (t.address_hash ?? t.address ?? '').toLowerCase(),
    symbol: t.symbol ?? '?',
    name: t.name ?? t.symbol ?? 'Token',
    decimals: Number(t.decimals ?? 18),
    type: t.type ?? 'ERC-20',
  };
}

function txEvent(t: any): EvmEvent {
  const from = evmId(t.from.hash);
  const toAddr: string | undefined = t.to?.hash ?? t.created_contract?.hash;
  const to = toAddr ? evmId(toAddr) : from;
  const value = fromWei(t.value);
  const success = t.status === 'ok' || t.result === 'success';
  const ev: EvmEvent = {
    hash: t.hash,
    date: Date.parse(t.timestamp),
    success,
    method: t.method ?? undefined,
    kind: 'call',
    from,
    to,
    amount: value > 0 ? { value, currency: 'XRP', isXrp: true } : null,
    cross: null,
    flows: [],
    part: 0,
  };
  const params: any[] = t.decoded_input?.parameters ?? [];
  const param = (n: string) => params.find((p) => p.name === n)?.value;
  if (success && toAddr?.toLowerCase() === AXELAR_ITS && t.method === 'interchainTransfer' && param('destinationChain')) {
    // Leaving this chain through Axelar: the call names the destination chain and address.
    const chain = String(param('destinationChain')).toLowerCase();
    const address = decodeAscii(String(param('destinationAddress') ?? ''));
    const tokenId = String(param('tokenId') ?? '').replace(/^0x/, '');
    const amount: Amt | null = tokenId === XRP_TOKEN_ID ? { value: fromWei(param('amount')), currency: 'XRP', isXrp: true } : null;
    const node = remoteNode(chain, address);
    ev.kind = 'bridge-out';
    ev.cross = { bridge: 'axelar', direction: 'out', chain, address, node, local: from, amount, detail: param('gasValue') ? `plus ${+fromWei(param('gasValue')).toFixed(4)} XRP gas` : undefined };
    ev.flows.push({ from, to: node, type: 'crosschain', amount }, { from, to, type: 'contract' });
    return ev;
  }
  if (!success) return ev;
  if (value > 0) {
    ev.kind = 'native';
    ev.flows.push({ from, to, type: 'payment', amount: ev.amount });
  } else if (t.to?.is_contract) {
    ev.flows.push({ from, to, type: 'contract' });
  }
  return ev;
}

function transferEvent(t: any): EvmEvent | null {
  const token = toToken(t.token ?? {});
  if (token.type !== 'ERC-20') return null; // NFTs and others: skip for now
  const fromRaw = (t.from?.hash ?? ZERO).toLowerCase();
  const toRaw = (t.to?.hash ?? ZERO).toLowerCase();
  const value = fromWei(t.total?.value, Number(t.total?.decimals ?? token.decimals));
  const isNative = token.address === EVM_NATIVE;
  const amount: Amt = { value, currency: token.symbol, issuer: isNative ? undefined : evmId(token.address), isXrp: isNative };
  const from = evmId(fromRaw);
  const to = evmId(toRaw);
  const ev: EvmEvent = {
    hash: t.transaction_hash,
    date: Date.parse(t.timestamp),
    success: true,
    method: t.method ?? undefined,
    kind: 'token',
    from,
    to,
    amount,
    cross: null,
    flows: [],
    part: Number(t.log_index ?? 0) + 1,
  };
  if (fromRaw === ZERO) {
    // Minted to this address. Minting by Axelar's `execute` is a delivery from another chain.
    ev.kind = t.method === 'execute' ? 'bridge-in' : 'mint';
    return ev;
  }
  if (toRaw === ZERO) {
    ev.kind = 'burn';
    return ev;
  }
  ev.flows.push({ from, to, type: 'payment', amount });
  return ev;
}
