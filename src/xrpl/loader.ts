/** Loads and caches everything we show about an account, straight from the ledger. */
import { XrplClient, XrplError } from './client';
import { parseTx, type ParsedTx } from './parse';
import { parseAmount, hexToAscii, decodeCurrency, type Amt } from './amount';
import { F, has } from './flags';

export interface TrustLine {
  peer: string;
  currency: string;
  /** > 0: this account holds the peer's token. < 0: the peer holds this account's token. */
  balance: number;
  limit: number;
  limitPeer: number;
}

export interface Activation {
  parent?: string;
  date?: number;
  amount?: Amt | null;
  hash?: string;
  via?: string;
  /** Why no parent is known. */
  unknown?: 'genesis' | 'history' | 'none';
}

export interface AmmPool {
  asset1: Amt;
  asset2: Amt;
  feePct: number;
  lp?: Amt;
}

export interface AccountData {
  address: string;
  exists: boolean;
  balance: number;
  flags: number;
  domain?: string;
  regularKey?: string;
  signers?: { quorum: number; entries: { account: string; weight: number }[] };
  transferRate?: number;
  ammId?: string;
  amm?: AmmPool;
  ownerCount: number;
  lines: TrustLine[];
  linesMore: boolean;
  obligations: Amt[];
  txs: ParsedTx[];
  txMarker?: unknown;
  txDone: boolean;
  activation?: Activation;
}

const TX_PAGE = 200;
const EARLIEST_LEDGER = 32570; // the oldest ledger whose history survives

export function cleanDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  try {
    return new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

export interface Probe {
  exists: boolean;
  balance: number;
  flags: number;
  ammId?: string;
  domain?: string;
}

export class Loader {
  private accounts = new Map<string, Promise<AccountData>>();
  private probes = new Map<string, Promise<Probe>>();
  private amms = new Map<string, Promise<AmmPool | null>>();
  readonly probed = new Map<string, Probe>();
  private activations = new Map<string, Promise<Activation>>();
  /** Synchronous view of everything that finished loading. */
  readonly loaded = new Map<string, AccountData>();
  /** Called when late-arriving details (like issued totals) are added to loaded data. */
  onUpdate?: (addr: string) => void;

  constructor(private c: XrplClient) {}

  account(addr: string, force = false): Promise<AccountData> {
    const cached = this.accounts.get(addr);
    if (cached && !force) return cached;
    const p = this.load(addr).then((d) => {
      this.loaded.set(addr, d);
      return d;
    });
    this.accounts.set(addr, p);
    p.catch(() => this.accounts.delete(addr));
    return p;
  }

  private async load(addr: string): Promise<AccountData> {
    const c = this.c;
    const [infoR, linesR, txR, actR] = await Promise.allSettled([
      this.accountRoot(addr),
      c.request('account_lines', { account: addr, ledger_index: 'validated', limit: 200 }),
      c.request('account_tx', { account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: TX_PAGE, forward: false }),
      this.activation(addr),
    ]);

    let exists = true;
    let info: any = {};
    let signerList: any;
    if (infoR.status === 'fulfilled') {
      info = infoR.value.root;
      signerList = infoR.value.signerList;
    } else {
      const err = infoR.reason as XrplError;
      if (err.code === 'actNotFound') exists = false;
      else if (err.code === 'actMalformed') throw new XrplError('actMalformed', 'That doesn’t look like a valid XRPL address.');
      else throw err;
    }

    const data: AccountData = {
      address: addr,
      exists,
      balance: exists ? Number(info.Balance) / 1e6 : 0,
      flags: Number(info.Flags ?? 0),
      domain: info.Domain ? cleanDomain(hexToAscii(info.Domain)) : undefined,
      regularKey: info.RegularKey,
      signers: signerList
        ? {
            quorum: signerList.SignerQuorum,
            entries: (signerList.SignerEntries ?? []).map((e: any) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })),
          }
        : undefined,
      transferRate: info.TransferRate ? (Number(info.TransferRate) / 1e9 - 1) * 100 : undefined,
      ammId: info.AMMID,
      ownerCount: Number(info.OwnerCount ?? 0),
      lines: [],
      linesMore: false,
      obligations: [],
      txs: [],
      txDone: false,
      activation: actR.status === 'fulfilled' ? actR.value : undefined,
    };

    if (linesR.status === 'fulfilled') {
      data.lines = (linesR.value.lines ?? []).map((l: any) => ({
        peer: l.account,
        currency: decodeCurrency(l.currency),
        balance: Number(l.balance),
        limit: Number(l.limit),
        limitPeer: Number(l.limit_peer),
      }));
      data.linesMore = !!linesR.value.marker;
    }
    if (txR.status === 'fulfilled') {
      data.txs = (txR.value.transactions ?? []).map(parseTx);
      data.txMarker = txR.value.marker;
      data.txDone = !txR.value.marker;
    } else if (!exists) {
      throw new XrplError('actNotFound', 'This address has never been used on the XRP Ledger.');
    }

    // Issued-token totals can take a while for big issuers, so they fill in afterwards.
    const looksLikeIssuer = data.lines.some((l) => l.balance < 0) || has(data.flags, F.DefaultRipple);
    if (exists && looksLikeIssuer && !data.ammId) {
      c.request('gateway_balances', { account: addr, ledger_index: 'validated', strict: true }, 30000)
        .then((r) => {
          data.obligations = Object.entries(r.obligations ?? {})
            .map(([cur, v]) => ({ value: Number(v), currency: decodeCurrency(cur), issuer: addr, isXrp: false }))
            .sort((a, b) => b.value - a.value);
          this.onUpdate?.(addr);
        })
        .catch(() => {});
    }
    if (data.ammId) {
      const pool = await this.ammInfo(addr);
      if (pool) data.amm = pool;
    }
    return data;
  }

  /**
   * The account's root record. Some public servers answer account_info with an
   * "internal" error for certain accounts (e.g. AMM pools); ledger_entry still works.
   */
  private async accountRoot(addr: string, low = false): Promise<{ root: any; signerList?: any }> {
    try {
      const r = await this.c.request('account_info', { account: addr, ledger_index: 'validated', signer_lists: !low }, 25000, low);
      return { root: r.account_data ?? {}, signerList: (r.signer_lists ?? r.account_data?.signer_lists)?.[0] };
    } catch (e) {
      if ((e as XrplError).code !== 'internal') throw e;
      const r = await this.c.request('ledger_entry', { account_root: addr, ledger_index: 'validated' }, 25000, low).catch((err: XrplError) => {
        throw err.code === 'entryNotFound' ? new XrplError('actNotFound', 'Account not found.') : err;
      });
      if (!r.node) throw new XrplError('actNotFound', 'Account not found.');
      return { root: r.node };
    }
  }

  /** Cheap background lookup used to classify accounts we haven't opened yet. */
  probe(addr: string): Promise<Probe> {
    const cached = this.probes.get(addr);
    if (cached) return cached;
    const p = this.accountRoot(addr, true)
      .then(
        ({ root: i }): Probe => {
          return { exists: true, balance: Number(i.Balance) / 1e6, flags: Number(i.Flags ?? 0), ammId: i.AMMID, domain: i.Domain ? cleanDomain(hexToAscii(i.Domain)) : undefined };
        },
        (e: XrplError): Probe => {
          if (e.code === 'actNotFound') return { exists: false, balance: 0, flags: 0 };
          throw e;
        },
      )
      .then((pr) => {
        this.probed.set(addr, pr);
        return pr;
      });
    this.probes.set(addr, p);
    p.catch(() => this.probes.delete(addr));
    return p;
  }

  /** Pool assets of an AMM account (cached; `low` = background priority). */
  ammInfo(addr: string, low = false): Promise<AmmPool | null> {
    const cached = this.amms.get(addr);
    if (cached) return cached;
    const p = this.c
      .request('amm_info', { amm_account: addr, ledger_index: 'validated' }, 20000, low)
      .then((r): AmmPool | null => {
        const a = r.amm;
        const asset1 = parseAmount(a?.amount);
        const asset2 = parseAmount(a?.amount2);
        return asset1 && asset2 ? { asset1, asset2, feePct: Number(a.trading_fee ?? 0) / 1000, lp: parseAmount(a.lp_token) ?? undefined } : null;
      })
      .catch(() => null);
    this.amms.set(addr, p);
    return p;
  }

  /** Who created (activated) this account: its very first transaction. */
  activation(addr: string): Promise<Activation> {
    const cached = this.activations.get(addr);
    if (cached) return cached;
    const p = this.c
      .request('account_tx', { account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 1, forward: true })
      .then((r): Activation => {
        const e = r.transactions?.[0];
        if (!e) return { unknown: 'none' };
        const t = parseTx(e);
        if (t.created.includes(addr)) {
          return { parent: t.account, date: t.date, amount: t.type === 'Payment' ? t.delivered : null, hash: t.hash, via: t.type };
        }
        return { unknown: Number(r.ledger_index_min) <= EARLIEST_LEDGER ? 'genesis' : 'history' };
      });
    this.activations.set(addr, p);
    p.catch(() => this.activations.delete(addr));
    return p;
  }

  async moreTx(data: AccountData): Promise<ParsedTx[]> {
    if (data.txDone) return [];
    const r = await this.c.request('account_tx', {
      account: data.address,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: TX_PAGE,
      forward: false,
      marker: data.txMarker,
    });
    const page: ParsedTx[] = (r.transactions ?? []).map(parseTx);
    data.txs.push(...page);
    data.txMarker = r.marker;
    data.txDone = !r.marker;
    return page;
  }

  async tx(hash: string): Promise<ParsedTx> {
    const r = await this.c.request('tx', { transaction: hash });
    return parseTx(r);
  }
}

/* ------------------------------------------------------------------ */

export interface Counterparty {
  address: string;
  count: number;
  xrpIn: number;
  xrpOut: number;
  last: number;
  kinds: Set<string>;
}

export interface FlowSummary {
  counterparties: Counterparty[];
  xrpIn: number;
  xrpOut: number;
  from: number;
  to: number;
  txCount: number;
}

/** Aggregate who an account deals with, based on its loaded history. */
export function summarize(data: AccountData): FlowSummary {
  const me = data.address;
  const map = new Map<string, Counterparty>();
  let xrpIn = 0;
  let xrpOut = 0;
  for (const t of data.txs) {
    for (const f of t.flows) {
      if (f.from !== me && f.to !== me) continue;
      const other = f.from === me ? f.to : f.from;
      let c = map.get(other);
      if (!c) map.set(other, (c = { address: other, count: 0, xrpIn: 0, xrpOut: 0, last: 0, kinds: new Set() }));
      c.count++;
      c.kinds.add(f.type);
      c.last = Math.max(c.last, t.date);
      if (f.amount?.isXrp && (f.type === 'payment' || f.type === 'activation')) {
        if (f.to === me) {
          c.xrpIn += f.amount.value;
          xrpIn += f.amount.value;
        } else {
          c.xrpOut += f.amount.value;
          xrpOut += f.amount.value;
        }
      }
    }
  }
  const dates = data.txs.map((t) => t.date).filter(Boolean);
  return {
    counterparties: [...map.values()].sort((a, b) => score(b) - score(a)),
    xrpIn,
    xrpOut,
    from: dates.length ? Math.min(...dates) : 0,
    to: dates.length ? Math.max(...dates) : 0,
    txCount: data.txs.length,
  };
}

/** Rank counterparties: value moved matters more than raw count, so dust spam doesn't crowd out real relationships. */
const score = (c: Counterparty) => Math.log10(1 + c.count) * 3 + Math.log10(1 + c.xrpIn + c.xrpOut) * 2;
