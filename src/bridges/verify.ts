/**
 * Confirms cross-chain links on the destination network, turning "declared"
 * (written in the transaction) into "confirmed" (found on the other side):
 *  - Burn 2 Mint: the Xahau Import embeds the XRP Ledger burn; hashing it must give the burn's ID.
 *  - Axelar:      the XRPL EVM delivery's message names the XRP Ledger sender, recipient and amount,
 *                 and sends back to the XRP Ledger arrive as a payment from Axelar's gateway.
 *  - Teleport:    an identical payout to the same address on the other network.
 */
import type { XrplClient } from '../xrpl/client';
import type { EvmLoader } from '../chains/evm';
import { NETWORKS, xpopBurnHash, type Network } from '../chains/chains';
import { parseAmount, rippleTimeToMs, type Amt } from '../xrpl/amount';
import { chainName } from './registry';
import type { CrossChain } from './decode';

export type Evidence = 'declared' | 'checking' | 'confirmed' | 'not-found' | 'unavailable';

export interface Check {
  status: Evidence;
  /** Plain-English explanation of how (or why not). */
  how: string;
  other?: { network: Network; hash: string; href: string; date?: number };
}

export interface Crossing {
  hash: string;
  date: number;
  network: Network;
  cross: CrossChain;
  /** The raw transaction (needed for Xahau Imports, which carry their proof). */
  tx?: any;
}

const AXELAR_GATEWAY = 'rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw';
const TELEPORT = 'rTeLeproT3BVgjWoYrDYpKbBLXPaVMkge';
const MIN = 60_000;
const HOUR = 60 * MIN;

const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);

interface LedgerTx {
  hash: string;
  type: string;
  account: string;
  destination?: string;
  date: number;
  delivered: Amt | null;
  tx: any;
}

async function history(client: XrplClient, account: string, opts: { forward?: boolean; limit?: number; native: string }): Promise<LedgerTx[] | null> {
  try {
    const r = await client.request('account_tx', { account, limit: opts.limit ?? 200, forward: !!opts.forward, ledger_index_min: -1, ledger_index_max: -1 });
    return (r.transactions ?? []).map((e: any) => {
      const tx = e.tx ?? e.tx_json;
      const meta = e.meta ?? {};
      return {
        hash: tx.hash ?? e.hash,
        type: tx.TransactionType,
        account: tx.Account,
        destination: tx.Destination,
        date: rippleTimeToMs(tx.date),
        delivered: meta.TransactionResult === 'tesSUCCESS' ? (parseAmount(meta.delivered_amount ?? tx.Amount, opts.native) ?? null) : null,
        tx,
      };
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'actNotFound') return null;
    throw e;
  }
}

export interface VerifierDeps {
  xrpl: XrplClient;
  xahau: () => XrplClient;
  evm: EvmLoader;
}

export class Verifier {
  private results = new Map<string, Check>();
  private running = new Map<string, Promise<Check>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  onChange?: (hash: string, check: Check) => void;

  constructor(private deps: VerifierDeps) {}

  get(hash: string): Check | undefined {
    return this.results.get(hash);
  }

  /** Is the other side on a network we can read, through a bridge we know how to check? */
  static canVerify(c: CrossChain): boolean {
    if (c.direction === 'internal') return false;
    if (c.bridge === 'b2m' || c.bridge === 'teleport') return c.chain === 'xahau' || c.chain === 'xrpl';
    if (c.bridge === 'axelar') return c.chain === 'xrpl-evm' || c.chain === 'xrpl';
    return false;
  }

  check(x: Crossing): Promise<Check> {
    const done = this.results.get(x.hash);
    if (done && done.status !== 'checking') return Promise.resolve(done);
    const running = this.running.get(x.hash);
    if (running) return running;
    if (!Verifier.canVerify(x.cross)) {
      const c: Check = { status: 'unavailable', how: `${chainName(x.cross.chain)} isn’t connected to GraphXRP yet, so this can’t be checked here.` };
      this.results.set(x.hash, c);
      return Promise.resolve(c);
    }
    this.set(x.hash, { status: 'checking', how: `Looking for it on ${chainName(x.cross.chain)}…` });
    const p = this.slot()
      .then(() => this.run(x))
      .catch((e): Check => ({ status: 'unavailable', how: `Couldn’t check right now (${(e as Error).message}).` }))
      .then((c) => {
        this.active--;
        this.waiting.shift()?.();
        this.running.delete(x.hash);
        this.set(x.hash, c);
        return c;
      });
    this.running.set(x.hash, p);
    return p;
  }

  private set(hash: string, c: Check) {
    this.results.set(hash, c);
    this.onChange?.(hash, c);
  }

  private slot(): Promise<void> {
    if (this.active < 2) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((ok) =>
      this.waiting.push(() => {
        this.active++;
        ok();
      }),
    );
  }

  private async run(x: Crossing): Promise<Check> {
    const c = x.cross;
    if (c.bridge === 'b2m') return c.direction === 'out' ? this.burnImported(x) : this.importProof(x);
    if (c.bridge === 'teleport') return this.teleport(x);
    if (c.bridge === 'axelar') {
      if (x.network === 'xrpl' && c.direction === 'out') return this.axelarDelivered(x);
      if (x.network === 'xrpl-evm' && c.direction === 'in') return this.axelarArrived(x);
      if (x.network === 'xrpl-evm' && c.direction === 'out') return this.axelarReturned(x);
    }
    return { status: 'unavailable', how: 'This kind of crossing can’t be checked yet.' };
  }

  /** XRP Ledger burn → find the Xahau Import whose embedded transaction is this burn. */
  private async burnImported(x: Crossing): Promise<Check> {
    const account = x.cross.address ?? x.cross.local;
    const list = await history(this.deps.xahau(), account, { forward: true, limit: 60, native: 'XAH' });
    if (!list) return { status: 'not-found', how: 'This address doesn’t exist on Xahau, so the burn hasn’t been imported (yet). Burned fees only become XAH once someone imports the proof.' };
    for (const t of list) {
      if (t.type !== 'Import' || !t.tx.Blob) continue;
      if ((await xpopBurnHash(t.tx.Blob)) === x.hash) {
        return {
          status: 'confirmed',
          how: 'Found the Import on Xahau. It contains this exact XRP Ledger transaction, checked by Xahau’s validators, so the link is cryptographic.',
          other: { network: 'xahau', hash: t.hash, href: NETWORKS.xahau.explorer.tx(t.hash), date: t.date },
        };
      }
    }
    return { status: 'not-found', how: 'No Import of this burn among the address’s first Xahau transactions. The burned XRP may never have been claimed as XAH.' };
  }

  /** Xahau Import → recover the XRP Ledger burn from the proof it carries. */
  private async importProof(x: Crossing): Promise<Check> {
    const burn = x.tx?.Blob ? await xpopBurnHash(x.tx.Blob) : null;
    return {
      status: 'confirmed',
      how: 'Xahau only accepts an Import together with proof (signed by XRP Ledger validators) of the burn on the XRP Ledger. The proof contains that transaction.',
      other: burn ? { network: 'xrpl', hash: burn, href: NETWORKS.xrpl.explorer.tx(burn) } : undefined,
    };
  }

  /** Teleport: the same amount, to/from the same address, on the other network, close in time. */
  private async teleport(x: Crossing): Promise<Check> {
    const c = x.cross;
    const user = c.address ?? c.local;
    const otherNet: Network = x.network === 'xrpl' ? 'xahau' : 'xrpl';
    const client = otherNet === 'xahau' ? this.deps.xahau() : this.deps.xrpl;
    const list = await history(client, user, { limit: 200, native: otherNet === 'xahau' ? 'XAH' : 'XRP' });
    if (!list) return { status: 'not-found', how: `This address doesn’t exist on ${NETWORKS[otherNet].name}.` };
    const amount = c.amount?.value;
    const match = list.find((t) => {
      if (t.type !== 'Payment' || !t.delivered || amount == null || !same(t.delivered.value, amount)) return false;
      if (otherNet === 'xahau' ? !t.delivered.isXrp : t.delivered.currency !== 'XAH') return false;
      return c.direction === 'out'
        ? t.account === TELEPORT && t.destination === user && t.date >= x.date - 10 * MIN && t.date <= x.date + 12 * HOUR
        : t.account === user && t.destination === TELEPORT && t.date <= x.date + 10 * MIN && t.date >= x.date - 12 * HOUR;
    });
    if (!match) return { status: 'not-found', how: `No matching Teleport ${c.direction === 'out' ? 'payout' : 'deposit'} for this address on ${NETWORKS[otherNet].name} within 12 hours.` };
    const mins = Math.max(1, Math.round(Math.abs(match.date - x.date) / MIN));
    return {
      status: 'confirmed',
      how: `Matched on ${NETWORKS[otherNet].name}: the same amount ${c.direction === 'out' ? 'paid out to' : 'deposited by'} the same address about ${mins} minute${mins > 1 ? 's' : ''} ${c.direction === 'out' ? 'later' : 'earlier'}. (Matched by address, amount and time; Teleport doesn’t publish a receipt.)`,
      other: { network: otherNet, hash: match.hash, href: NETWORKS[otherNet].explorer.tx(match.hash), date: match.date },
    };
  }

  /** XRP Ledger deposit to Axelar → find the delivery on the XRPL EVM Sidechain. */
  private async axelarDelivered(x: Crossing): Promise<Check> {
    const c = x.cross;
    const dest = (c.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(dest)) return { status: 'unavailable', how: 'The destination isn’t an address GraphXRP can look up.' };
    const evm = this.deps.evm;
    const found = await evm.deliveriesTo(dest, x.date - 10 * MIN);
    const deliveries = found.items.filter((d) => d.method === 'execute' && d.date >= x.date - 10 * MIN && d.date <= x.date + 48 * HOUR).sort((a, b) => a.date - b.date);
    const expectedWei = c.amount?.isXrp ? BigInt(Math.round(c.amount.value * 1e6)) * 10n ** 12n : null;
    for (const d of deliveries.slice(0, 8)) {
      const its = await evm.arrival(d.hash);
      if (!its || (its.sourceChain ?? '').toLowerCase() !== 'xrpl' || its.sourceAddress !== c.local || its.destination.toLowerCase() !== dest) continue;
      if (expectedWei != null && its.amount !== expectedWei) continue;
      return {
        status: 'confirmed',
        how: 'Found the delivery on the XRPL EVM Sidechain. Axelar’s relayed message names this XRP Ledger sender, the recipient and the same amount.',
        other: { network: 'xrpl-evm', hash: d.hash, href: NETWORKS['xrpl-evm'].explorer.tx(d.hash), date: d.date },
      };
    }
    if (!found.complete) {
      return {
        status: 'unavailable',
        how: `The recipient is very busy, so the search only reached back to ${new Date(found.oldest).toLocaleDateString()}. This transfer is older; check it on the explorer.`,
      };
    }
    return { status: 'not-found', how: 'No matching delivery reached this address on the XRPL EVM Sidechain in the 48 hours after this transaction.' };
  }

  /** XRPL EVM delivery from the XRP Ledger: the message itself names the sender; find their deposit too. */
  private async axelarArrived(x: Crossing): Promise<Check> {
    const c = x.cross;
    const base: Check = { status: 'confirmed', how: 'This delivery was made by Axelar, and its relayed message names the XRP Ledger sender and amount.' };
    if (c.chain !== 'xrpl' || !c.address) return base;
    const list = await history(this.deps.xrpl, c.address, { limit: 200, native: 'XRP' }).catch(() => null);
    const dest = c.local.split(':').pop()?.toLowerCase();
    const hexDest = dest?.replace(/^0x/, '');
    const deposit = list?.find((t) => {
      if (t.type !== 'Payment' || t.destination !== AXELAR_GATEWAY || t.date > x.date) return false;
      return (t.tx.Memos ?? []).some((m: any) => typeof m.Memo?.MemoData === 'string' && hexDest && hexToText(m.Memo.MemoData).toLowerCase().replace(/^0x/, '') === hexDest);
    });
    return deposit ? { ...base, other: { network: 'xrpl', hash: deposit.hash, href: NETWORKS.xrpl.explorer.tx(deposit.hash), date: deposit.date } } : base;
  }

  /** XRPL EVM send to the XRP Ledger → find Axelar's payout there. */
  private async axelarReturned(x: Crossing): Promise<Check> {
    const c = x.cross;
    if (c.chain !== 'xrpl' || !c.address) return { status: 'unavailable', how: `${chainName(c.chain)} isn’t connected yet.` };
    const list = await history(this.deps.xrpl, c.address, { limit: 200, native: 'XRP' });
    if (!list) return { status: 'not-found', how: 'The destination doesn’t exist on the XRP Ledger.' };
    const match = list.find(
      (t) => t.type === 'Payment' && t.account === AXELAR_GATEWAY && t.destination === c.address && t.date >= x.date - 10 * MIN && t.date <= x.date + 48 * HOUR && (!c.amount || (t.delivered?.isXrp && same(t.delivered.value, c.amount.value))),
    );
    if (!match) return { status: 'not-found', how: 'No matching payout from Axelar’s gateway to this address on the XRP Ledger yet.' };
    return {
      status: 'confirmed',
      how: 'Found Axelar’s payout on the XRP Ledger: the same amount to the named address, after this transaction.',
      other: { network: 'xrpl', hash: match.hash, href: NETWORKS.xrpl.explorer.tx(match.hash), date: match.date },
    };
  }
}

function hexToText(hex: string): string {
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}
