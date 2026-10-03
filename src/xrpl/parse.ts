/**
 * Turns raw ledger transactions into:
 *  - flows: directed relationships between accounts (graph edges), and
 *  - plain-English sentences told from a given account's point of view.
 */
import { parseAmount as parseAmountRaw, rippleTimeToMs, decodeCurrency, fmtNum, type Amt } from './amount';
import { decodeCrossChain, type CrossChain } from '../bridges/decode';
import { XRPL_CTX, type ChainCtx } from '../chains/chains';
import { BRIDGES, chainName, doorOf } from '../bridges/registry';

export type EdgeType = 'payment' | 'activation' | 'trust' | 'dex' | 'control' | 'crosschain' | 'contract';

export interface Flow {
  from: string;
  to: string;
  type: EdgeType;
  amount?: Amt | null;
}

export interface ParsedTx {
  hash: string;
  type: string;
  date: number;
  ledger: number;
  success: boolean;
  result: string;
  account: string;
  destination?: string;
  dtag?: number;
  delivered: Amt | null;
  flows: Flow[];
  created: string[];
  amm?: string;
  /** Cross-chain intent read from the transaction (bridge memos, Burn 2 Mint). */
  cross: CrossChain | null;
  /** Network this transaction lives on, its native currency, and its address → graph-id mapping. */
  net: ChainCtx['chain'];
  native: string;
  id: (address: string) => string;
  tx: any;
  meta: any;
}

interface MetaNode {
  kind: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode';
  type: string;
  fields: any;
  prev: any;
}

function metaNodes(meta: any): MetaNode[] {
  const list = meta?.AffectedNodes ?? [];
  const out: MetaNode[] = [];
  for (const wrap of list) {
    const kind = Object.keys(wrap)[0] as MetaNode['kind'];
    const n = wrap[kind];
    out.push({ kind, type: n.LedgerEntryType, fields: n.NewFields ?? n.FinalFields ?? {}, prev: n.PreviousFields ?? {} });
  }
  return out;
}

export function parseTx(entry: any, ctx: ChainCtx = XRPL_CTX): ParsedTx {
  const parseAmount = (a: unknown) => parseAmountRaw(a, ctx.native);
  const tx = entry.tx ?? entry.tx_json ?? entry;
  const meta = entry.meta ?? entry.metaData ?? {};
  const hash: string = tx.hash ?? entry.hash ?? '';
  const date = tx.date != null ? rippleTimeToMs(tx.date) : entry.close_time_iso ? Date.parse(entry.close_time_iso) : 0;
  const result: string = meta.TransactionResult ?? 'unknown';
  const success = result === 'tesSUCCESS';
  const nodes = metaNodes(meta);
  const account: string = tx.Account;
  const destination: string | undefined = tx.Destination;
  const delivered =
    parseAmount(meta.delivered_amount ?? meta.DeliveredAmount) ?? parseAmount(tx.Amount ?? tx.DeliverMax);

  const created = nodes.filter((n) => n.kind === 'CreatedNode' && n.type === 'AccountRoot').map((n) => n.fields.Account);

  let amm: string | undefined;
  for (const n of nodes) {
    if (n.type === 'AMM' && n.fields.Account) amm = n.fields.Account;
    else if (n.type === 'AccountRoot' && n.fields.AMMID && n.fields.Account) amm ??= n.fields.Account;
  }

  const flows: Flow[] = [];
  const add = (from: string | undefined, to: string | undefined, type: EdgeType, amount?: Amt | null) => {
    if (from && to && from !== to) flows.push({ from, to, type, amount });
  };

  // Accounts whose resting DEX orders were (partly) filled by this tx.
  const offerCounterparties = () => {
    const owners = new Set<string>();
    for (const n of nodes) {
      if (n.type === 'Offer' && n.kind !== 'CreatedNode' && n.prev.TakerGets !== undefined && n.fields.Account !== account) {
        owners.add(n.fields.Account);
      }
    }
    return [...owners].slice(0, 6);
  };

  if (success) {
    switch (tx.TransactionType) {
      case 'Payment':
        if (destination && destination !== account) {
          add(account, destination, created.includes(destination) ? 'activation' : 'payment', delivered);
        }
        for (const o of offerCounterparties()) add(o, account, 'dex');
        if (amm && amm !== destination) add(account, amm, 'dex');
        break;
      case 'OfferCreate':
        for (const o of offerCounterparties()) add(o, account, 'dex');
        if (amm) add(account, amm, 'dex');
        break;
      case 'AMMCreate':
        if (amm) add(account, amm, created.includes(amm) ? 'activation' : 'dex', parseAmount(tx.Amount));
        break;
      case 'AMMDeposit':
      case 'AMMWithdraw':
      case 'AMMVote':
      case 'AMMBid':
      case 'AMMDelete':
      case 'AMMClawback':
        add(account, amm ?? tx.Asset?.issuer, 'dex');
        break;
      case 'EscrowCreate':
      case 'PaymentChannelCreate':
        add(account, destination, 'payment', parseAmount(tx.Amount));
        break;
      case 'CheckCreate':
        add(account, destination, 'payment', parseAmount(tx.SendMax));
        break;
      case 'EscrowFinish': {
        const e = nodes.find((n) => n.type === 'Escrow' && n.kind === 'DeletedNode');
        if (e) add(e.fields.Account, e.fields.Destination, 'payment', parseAmount(e.fields.Amount));
        break;
      }
      case 'CheckCash': {
        const c = nodes.find((n) => n.type === 'Check' && n.kind === 'DeletedNode');
        if (c) add(c.fields.Account, account, 'payment', parseAmount(tx.Amount ?? tx.DeliverMin));
        break;
      }
      case 'PaymentChannelFund':
      case 'PaymentChannelClaim': {
        const ch = nodes.find((n) => n.type === 'PayChannel');
        if (ch) {
          let amt = parseAmount(tx.Amount);
          if (tx.TransactionType === 'PaymentChannelClaim' && ch.prev.Balance !== undefined) {
            amt = { value: (Number(ch.fields.Balance) - Number(ch.prev.Balance)) / 1e6, currency: 'XRP', isXrp: true };
          }
          add(ch.fields.Account, ch.fields.Destination, 'payment', amt);
        }
        break;
      }
      case 'AccountDelete':
        add(account, destination, 'payment', delivered);
        break;
      case 'NFTokenAcceptOffer': {
        const offers = nodes.filter((n) => n.type === 'NFTokenOffer' && n.kind === 'DeletedNode');
        const sell = offers.find((n) => (n.fields.Flags & 1) === 1);
        const buy = offers.find((n) => (n.fields.Flags & 1) === 0);
        if (sell && buy) add(buy.fields.Owner, sell.fields.Owner, 'payment', parseAmount(buy.fields.Amount));
        else if (sell) add(account, sell.fields.Owner, 'payment', parseAmount(sell.fields.Amount));
        else if (buy) add(buy.fields.Owner, account, 'payment', parseAmount(buy.fields.Amount));
        break;
      }
      case 'Clawback': {
        const a = parseAmount(tx.Amount);
        // For token clawback, Amount.issuer holds the *holder's* address.
        if (a && tx.Amount?.issuer) add(tx.Amount.issuer, account, 'payment', { ...a, issuer: account });
        break;
      }
      case 'Remit': // Xahau: send several amounts (and URI tokens) at once
        for (const e of tx.Amounts ?? []) add(account, destination, created.includes(destination ?? '') ? 'activation' : 'payment', parseAmount(e.AmountEntry?.Amount));
        break;
      case 'SetRegularKey':
        if (tx.RegularKey) add(tx.RegularKey, account, 'control');
        break;
      case 'SignerListSet':
        for (const s of tx.SignerEntries ?? []) add(s.SignerEntry?.Account, account, 'control');
        break;
    }
  }

  // Cross-chain: link the XRP Ledger account to the address (or chain) on the other side.
  // Everything above uses raw addresses; map them to graph ids for this network.
  const id = ctx.id;
  const mapAmt = (a: Amt | null | undefined): Amt | null | undefined => (a && a.issuer ? { ...a, issuer: id(a.issuer) } : a);
  if (ctx.chain !== 'xrpl') for (const f of flows) Object.assign(f, { from: id(f.from), to: id(f.to), amount: mapAmt(f.amount) });
  const cross = decodeCrossChain(tx, delivered, success, ctx, meta);
  if (cross?.node && cross.direction === 'out') flows.push({ from: cross.local, to: cross.node, type: 'crosschain', amount: cross.amount });
  if (cross?.node && cross.direction === 'in') flows.push({ from: cross.node, to: cross.local, type: 'crosschain', amount: cross.amount });

  return {
    hash,
    type: tx.TransactionType,
    date,
    ledger: tx.ledger_index ?? entry.ledger_index ?? 0,
    success,
    result,
    account: id(account),
    destination: destination ? id(destination) : undefined,
    dtag: tx.DestinationTag,
    delivered: mapAmt(delivered) ?? null,
    flows,
    created: created.map(id),
    amm: amm ? id(amm) : undefined,
    cross,
    net: ctx.chain,
    native: ctx.native,
    id,
    tx,
    meta,
  };
}

/* ------------------------------------------------------------------ */
/* Plain-English descriptions                                          */
/* ------------------------------------------------------------------ */

export type Seg = string | { a: string } | { amt: Amt } | { tag: number } | { badge: string; tip: string };

export interface Description {
  icon: string;
  dir: 'in' | 'out' | 'neutral';
  segs: Seg[];
}

const PARTIAL_PAYMENT = 0x00020000;

export function describe(p: ParsedTx, me: string): Description {
  const tx = p.tx;
  const mine = p.account === me;
  const amt = (a: unknown): Seg => {
    const x = parseAmountRaw(a, p.native, p.id);
    return x ? { amt: x } : 'an amount';
  };
  let d: Description;

  const cross = p.success && p.cross ? describeCrossing(p.cross, me) : null;
  if (cross) return cross;

  switch (p.type) {
    case 'Payment': {
      const dst = p.destination!;
      const value: Seg = p.delivered ? { amt: p.delivered } : 'funds';
      const partial = (tx.Flags & PARTIAL_PAYMENT) !== 0;
      const tag: Seg[] = p.dtag != null ? [' ', { tag: p.dtag }] : [];
      const activated = p.created.includes(dst);
      if (p.account === dst) {
        d = { icon: 'repeat', dir: 'neutral', segs: ['Swapped currencies on the DEX, receiving ', value] };
      } else if (mine) {
        d = activated
          ? { icon: 'sprout', dir: 'out', segs: ['Created a new account ', { a: dst }, ' by sending it ', value] }
          : { icon: 'out', dir: 'out', segs: ['Sent ', value, ' to ', { a: dst }, ...tag] };
      } else if (dst === me) {
        d = activated
          ? { icon: 'sprout', dir: 'in', segs: ['Was brought to life by ', { a: p.account }, ', which sent ', value] }
          : { icon: 'in', dir: 'in', segs: ['Received ', value, ' from ', { a: p.account }, ...tag] };
      } else {
        d = { icon: 'route', dir: 'neutral', segs: [{ a: p.account }, ' sent ', value, ' to ', { a: dst }] };
        if (p.delivered && p.delivered.issuer === me) d.segs.push(' (a token this account issued)');
        else if (p.amm === me) d.segs.push(' (routed through this pool)');
        else d.segs.push(' (passed through this account)');
      }
      if (partial && p.success) d.segs.push(' · partial payment');
      // Payments into or out of a bridge door whose memo we can't read.
      const door = doorOf(dst) ?? doorOf(p.account);
      if (door && p.success && p.account !== dst) {
        d.segs.push(doorOf(dst) ? ` (deposit to the ${door.name} bridge; destination not stated in a readable memo)` : ` (paid out by the ${door.name} bridge)`);
      }
      break;
    }
    case 'OfferCreate': {
      if (!mine) {
        d = { icon: 'repeat', dir: 'neutral', segs: [{ a: p.account }, ' traded against this account’s DEX order'] };
        if (p.amm === me) d.segs = [{ a: p.account }, ' traded with this pool'];
        break;
      }
      const placed = metaNodes(p.meta).some((n) => n.kind === 'CreatedNode' && n.type === 'Offer');
      const filled = p.flows.some((f) => f.type === 'dex');
      const verb = !p.success ? 'Tried to trade' : filled && !placed ? 'Traded' : 'Placed an order to sell';
      d = { icon: 'repeat', dir: 'neutral', segs: [verb + ' ', amt(tx.TakerGets), ' for ', amt(tx.TakerPays), ' on the DEX'] };
      if (p.success && filled && placed) d.segs.push(' (partly filled)');
      break;
    }
    case 'OfferCancel':
      d = { icon: 'x', dir: 'neutral', segs: ['Cancelled a DEX order'] };
      break;
    case 'TrustSet': {
      const lim = tx.LimitAmount;
      const cur = decodeCurrency(lim?.currency);
      if (!mine) {
        d = { icon: 'link', dir: 'neutral', segs: [{ a: p.account }, ` opted in to hold this account’s ${cur}`] };
      } else if (Number(lim?.value) === 0) {
        d = { icon: 'link', dir: 'neutral', segs: [`Stopped trusting ${cur} from `, { a: p.id(lim.issuer) }] };
      } else {
        d = { icon: 'link', dir: 'neutral', segs: [`Opted in to hold up to ${fmtNum(Number(lim.value))} ${cur} issued by `, { a: p.id(lim.issuer) }] };
      }
      break;
    }
    case 'AccountSet': {
      const segs: Seg[] = ['Changed account settings'];
      if (tx.Domain !== undefined) {
        segs.push(tx.Domain ? ' (set its website)' : ' (cleared its website)');
      }
      d = { icon: 'settings', dir: 'neutral', segs };
      break;
    }
    case 'SetRegularKey':
      d = tx.RegularKey
        ? { icon: 'key', dir: 'neutral', segs: ['Gave signing power to ', { a: p.id(tx.RegularKey) }] }
        : { icon: 'key', dir: 'neutral', segs: ['Removed its extra signing key'] };
      break;
    case 'SignerListSet':
      d = tx.SignerEntries?.length
        ? { icon: 'key', dir: 'neutral', segs: [`Set up multi-signature with ${tx.SignerEntries.length} keys`] }
        : { icon: 'key', dir: 'neutral', segs: ['Removed multi-signature'] };
      break;
    case 'EscrowCreate': {
      const until = tx.FinishAfter ? ` until ${new Date(rippleTimeToMs(tx.FinishAfter)).toLocaleDateString()}` : '';
      d =
        tx.Destination === p.account
          ? { icon: 'lock', dir: 'neutral', segs: ['Locked ', amt(tx.Amount), ` in escrow for itself${until}`] }
          : mine
            ? { icon: 'lock', dir: 'out', segs: ['Locked ', amt(tx.Amount), ' in escrow for ', { a: p.id(tx.Destination) }, until] }
            : { icon: 'lock', dir: 'in', segs: [{ a: p.account }, ' locked ', amt(tx.Amount), ` in escrow for this account${until}`] };
      break;
    }
    case 'EscrowFinish': {
      const f = p.flows[0];
      d = f
        ? { icon: 'lock', dir: f.to === me ? 'in' : 'neutral', segs: ['Escrow released: ', f.amount ? { amt: f.amount } : 'funds', ' from ', { a: f.from }, ' to ', { a: f.to }] }
        : { icon: 'lock', dir: 'neutral', segs: ['Released funds from escrow'] };
      break;
    }
    case 'EscrowCancel':
      d = { icon: 'lock', dir: 'neutral', segs: ['Cancelled an escrow'] };
      break;
    case 'CheckCreate':
      d = mine
        ? { icon: 'check', dir: 'out', segs: ['Wrote a check for up to ', amt(tx.SendMax), ' to ', { a: p.id(tx.Destination) }] }
        : { icon: 'check', dir: 'in', segs: [{ a: p.account }, ' wrote a check for up to ', amt(tx.SendMax)] };
      break;
    case 'CheckCash': {
      const f = p.flows[0];
      d = { icon: 'check', dir: mine ? 'in' : 'out', segs: f ? [{ a: f.to }, ' cashed a check from ', { a: f.from }] : ['Cashed a check'] };
      break;
    }
    case 'CheckCancel':
      d = { icon: 'check', dir: 'neutral', segs: ['Cancelled a check'] };
      break;
    case 'PaymentChannelCreate':
      d = { icon: 'route', dir: mine ? 'out' : 'in', segs: [{ a: p.account }, ' opened a payment channel to ', { a: p.id(tx.Destination) }, ' with ', amt(tx.Amount)] };
      break;
    case 'PaymentChannelFund':
    case 'PaymentChannelClaim':
      d = { icon: 'route', dir: 'neutral', segs: [p.type === 'PaymentChannelFund' ? 'Added funds to a payment channel' : 'Settled a payment channel'] };
      break;
    case 'AccountDelete':
      d = mine
        ? { icon: 'trash', dir: 'out', segs: ['Deleted itself and sent the remaining ', p.delivered ? { amt: p.delivered } : 'XRP', ' to ', { a: p.destination! }] }
        : { icon: 'trash', dir: 'in', segs: [{ a: p.account }, ' deleted itself and sent its remaining ', p.delivered ? { amt: p.delivered } : 'XRP', ' here'] };
      break;
    case 'AMMCreate':
      d = { icon: 'droplet', dir: 'neutral', segs: [{ a: p.account }, ' created the pool ', ...(p.amm ? [{ a: p.amm } as Seg] : []), ' with ', amt(tx.Amount), ' + ', amt(tx.Amount2)] };
      break;
    case 'AMMDeposit':
    case 'AMMWithdraw': {
      const verb = p.type === 'AMMDeposit' ? ' added liquidity to ' : ' removed liquidity from ';
      d = { icon: 'droplet', dir: 'neutral', segs: [{ a: p.account }, verb, p.amm ? { a: p.amm } : 'an AMM pool'] };
      break;
    }
    case 'AMMVote':
      d = { icon: 'droplet', dir: 'neutral', segs: [{ a: p.account }, ' voted on the trading fee of ', p.amm ? { a: p.amm } : 'an AMM pool'] };
      break;
    case 'AMMBid':
      d = { icon: 'droplet', dir: 'neutral', segs: [{ a: p.account }, ' bid for the discounted-trading slot of ', p.amm ? { a: p.amm } : 'an AMM pool'] };
      break;
    case 'NFTokenMint':
      d = { icon: 'image', dir: 'neutral', segs: mine ? ['Minted an NFT'] : [{ a: p.account }, ' minted an NFT for this account'] };
      break;
    case 'NFTokenBurn':
      d = { icon: 'flame', dir: 'neutral', segs: ['Burned (destroyed) an NFT'] };
      break;
    case 'NFTokenCreateOffer': {
      const sell = (tx.Flags & 1) === 1;
      d = { icon: 'image', dir: 'neutral', segs: [sell ? 'Offered an NFT for ' : 'Bid ', amt(tx.Amount), sell ? '' : ' on an NFT'] };
      break;
    }
    case 'NFTokenAcceptOffer': {
      const f = p.flows[0];
      if (f) {
        d =
          f.to === me
            ? { icon: 'image', dir: 'in', segs: ['Sold an NFT to ', { a: f.from }, ...(f.amount ? [' for ', { amt: f.amount } as Seg] : [])] }
            : f.from === me
              ? { icon: 'image', dir: 'out', segs: ['Bought an NFT from ', { a: f.to }, ...(f.amount ? [' for ', { amt: f.amount } as Seg] : [])] }
              : { icon: 'image', dir: 'neutral', segs: [{ a: f.from }, ' bought an NFT from ', { a: f.to }] };
      } else d = { icon: 'image', dir: 'neutral', segs: ['Completed an NFT trade'] };
      break;
    }
    case 'NFTokenCancelOffer':
      d = { icon: 'image', dir: 'neutral', segs: ['Cancelled NFT offers'] };
      break;
    case 'DepositPreauth':
      d = tx.Authorize
        ? { icon: 'shield', dir: 'neutral', segs: ['Pre-approved ', { a: p.id(tx.Authorize) }, ' to send payments'] }
        : { icon: 'shield', dir: 'neutral', segs: ['Removed a pre-approval'] };
      break;
    case 'Clawback': {
      const f = p.flows[0];
      d = { icon: 'alert', dir: 'neutral', segs: f ? [{ a: f.to }, ' clawed back ', f.amount ? { amt: f.amount } : 'tokens', ' from ', { a: f.from }] : ['Clawed back tokens'] };
      break;
    }
    // Xahau-only transaction types
    case 'Remit':
      d = mine
        ? { icon: 'out', dir: 'out', segs: ['Sent ', ...remitted(p, amt), ' to ', { a: p.destination! }] }
        : { icon: 'in', dir: 'in', segs: ['Received ', ...remitted(p, amt), ' from ', { a: p.account }] };
      break;
    case 'URITokenMint':
      d = { icon: 'image', dir: 'neutral', segs: [mine ? 'Minted a URI token (Xahau\u2019s NFT)' : 'A URI token was minted'] };
      break;
    case 'URITokenBuy':
      d = { icon: 'image', dir: mine ? 'out' : 'in', segs: mine ? ['Bought a URI token for ', amt(tx.Amount)] : [{ a: p.account }, ' bought a URI token from this account for ', amt(tx.Amount)] };
      break;
    case 'URITokenCreateSellOffer':
      d = { icon: 'image', dir: 'neutral', segs: ['Offered a URI token for ', amt(tx.Amount)] };
      break;
    case 'URITokenCancelSellOffer':
      d = { icon: 'image', dir: 'neutral', segs: ['Cancelled a URI token sale'] };
      break;
    case 'URITokenBurn':
      d = { icon: 'flame', dir: 'neutral', segs: ['Burned a URI token'] };
      break;
    case 'ClaimReward':
      d = { icon: 'coins', dir: 'in', segs: [tx.Flags & 1 ? 'Opted out of balance rewards' : 'Claimed (or signed up for) XAH balance rewards'] };
      break;
    case 'SetHook':
      d = { icon: 'settings', dir: 'neutral', segs: ['Installed or changed hooks (small programs that run on this account)'] };
      break;
    case 'Invoke':
      d = { icon: 'activity', dir: 'neutral', segs: mine ? ['Called a hook'] : [{ a: p.account }, ' called a hook on this account'] };
      break;
    case 'GenesisMint':
      d = { icon: 'coins', dir: 'in', segs: ['New XAH created by the network (governance mint)'] };
      break;
    case 'TicketCreate':
      d = { icon: 'settings', dir: 'neutral', segs: ['Reserved transaction slots (tickets)'] };
      break;
    default: {
      const label = `${(p.type ?? 'Unknown').replace(/([a-z])([A-Z])/g, '$1 $2')} transaction`;
      d = { icon: 'activity', dir: 'neutral', segs: mine ? [label] : [{ a: p.account }, ` — ${label}`] };
    }
  }

  if (!p.success) {
    d.icon = 'x';
    d.dir = 'neutral';
    d.segs = ['Failed: ', ...d.segs, ` (${friendlyResult(p.result)})`];
  }
  return d;
}

export function friendlyResult(code: string): string {
  const map: Record<string, string> = {
    tecUNFUNDED_PAYMENT: 'not enough funds',
    tecUNFUNDED_OFFER: 'not enough funds',
    tecPATH_DRY: 'no path to deliver',
    tecPATH_PARTIAL: 'could only deliver part',
    tecNO_DST: 'destination doesn’t exist',
    tecNO_DST_INSUF_XRP: 'too little XRP to create the account',
    tecDST_TAG_NEEDED: 'missing destination tag',
    tecNO_LINE: 'recipient doesn’t accept this token',
    tecKILLED: 'order couldn’t be filled',
    tecINSUF_RESERVE_OFFER: 'not enough reserve',
    tecNO_PERMISSION: 'not permitted',
    tecFROZEN: 'funds frozen',
  };
  return map[code] ?? code;
}

/** Flatten a description into plain text using a name resolver. */
export function segsToText(segs: Seg[], name: (a: string) => string): string {
  return segs
    .map((s) =>
      typeof s === 'string' ? s : 'a' in s ? name(s.a) : 'amt' in s ? `${fmtNum(s.amt.value)} ${s.amt.currency}` : 'tag' in s ? `(tag ${s.tag})` : `[${s.badge}]`,
    )
    .join('');
}

export const DECLARED: Seg = {
  badge: 'declared',
  tip: 'Declared: the destination is written in this XRP Ledger transaction. GraphXRP can\u2019t see the other chain yet, so it can\u2019t confirm the funds arrived.',
};

/** Sentences for cross-chain transactions (any network), told from `me`'s point of view. */
export function describeCrossing(c: CrossChain, me: string): Description {
  const bridge = BRIDGES[c.bridge].name;
  const value: Seg = c.amount ? { amt: c.amount } : 'funds';
  const extra: Seg[] = c.detail ? [` (${c.detail})`] : [];
  const mismatch: Seg[] = c.doorMismatch ? [` \u00b7 note: not sent to a known ${bridge} door`] : [];
  if (c.direction === 'internal') {
    return { icon: 'route', dir: 'neutral', segs: ['Bridge housekeeping: ', value, ` moved within ${bridge}`, ...extra] };
  }
  const other: Seg = c.node ? { a: c.node } : chainName(c.chain);
  if (c.bridge === 'b2m') {
    return c.local === me
      ? { icon: 'flame', dir: 'out', segs: ['Burned ', value, ' to mint XAH for itself on ', other, ' (Burn 2 Mint) ', DECLARED] }
      : { icon: 'flame', dir: 'neutral', segs: [{ a: c.local }, ' burned ', value, ' to mint XAH on ', other, ' ', DECLARED] };
  }
  if (c.direction === 'out') {
    const segs: Seg[] = c.local === me ? ['Sent ', value, ` via ${bridge} to `, other] : [{ a: c.local }, ' sent ', value, ` via ${bridge} to `, other];
    return { icon: 'route', dir: c.local === me ? 'out' : 'neutral', segs: [...segs, ...extra, ' ', DECLARED, ...mismatch] };
  }
  const segs: Seg[] = c.local === me ? ['Received ', value, ' from ', other, ` via ${bridge}`] : ['Released ', value, ' to ', { a: c.local }, ' from ', other];
  return { icon: 'route', dir: c.local === me ? 'in' : 'neutral', segs: [...segs, ...extra, ' ', DECLARED] };
}

function remitted(p: ParsedTx, amt: (a: unknown) => Seg): Seg[] {
  const list: Seg[] = (p.tx.Amounts ?? []).map((e: any) => amt(e.AmountEntry?.Amount));
  if (p.tx.URITokenIDs?.length) list.push(`${p.tx.URITokenIDs.length} URI token${p.tx.URITokenIDs.length > 1 ? 's' : ''}`);
  if (!list.length) return ['funds'];
  return list.flatMap((x, i) => (i ? [i === list.length - 1 ? ' and ' : ', ', x] : [x]));
}
