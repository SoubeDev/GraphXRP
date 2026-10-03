/**
 * Reads cross-chain intent out of XRP Ledger transactions. Every result here is
 * "declared": the sender (or bridge) wrote it into the transaction. Whether the
 * funds actually arrived happens on the other chain, which we can't see yet.
 *
 * Formats come from each bridge's documentation or published SDK:
 *  - Axelar:   memos type=interchain_transfer, destination_chain, destination_address, gas_fee_amount
 *  - Coreum:   JSON memo {"type":"coreumbridge-xrpl-v1","coreum_recipient":"core1…"}
 *  - Wanchain: memo "CrossChainInfo" = type(1B) + tokenPairID(2B) + toAccount(20B) + fee (hex)
 *  - Flare:    FAssets payment reference, 0x464250526641 ("FBPRfA") + operation code + id
 *  - Xahau:    Burn 2 Mint, OperationLimit = Xahau network ID on AccountSet/SetRegularKey/SignerListSet;
 *              on Xahau, the matching Import (which embeds the XRP Ledger transaction)
 *  - Teleport: XAH tokens paid to the Teleport account on one network are paid out
 *              to the same address on the other (checked by matching the payout)
 */
import { parseAmount, fmtNum, type Amt } from '../xrpl/amount';
import { doorOf, extId, registerDoor, type BridgeId } from './registry';
import { XRPL_CTX, type ChainCtx } from '../chains/chains';

const TELEPORT = 'rTeLeproT3BVgjWoYrDYpKbBLXPaVMkge';

export interface CrossChain {
  bridge: BridgeId;
  /** out = leaving the XRP Ledger, in = arriving, internal = the bridge moving its own funds. */
  direction: 'out' | 'in' | 'internal';
  chain: string;
  /** Address on the other chain, when the transaction states one. */
  address?: string;
  /** Graph node for the other side (an address, or the chain itself). */
  node?: string;
  /** The account on this transaction's own network (graph id). */
  local: string;
  amount: Amt | null;
  detail?: string;
  /** The memo names a bridge, but the payment didn't go to one of that bridge's known doors. */
  doorMismatch?: boolean;
}

interface Memo {
  type: string;
  data: string;
  raw: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function hexText(hex: string | undefined): string {
  if (!hex || hex.length % 2) return '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return utf8.decode(bytes);
}

function readMemos(tx: any): Memo[] {
  return (tx.Memos ?? []).map((w: any) => ({
    type: hexText(w.Memo?.MemoType).trim(),
    data: hexText(w.Memo?.MemoData).trim(),
    raw: String(w.Memo?.MemoData ?? '').toLowerCase(),
  }));
}

const B2M_TYPES = new Set(['AccountSet', 'SetRegularKey', 'SignerListSet']);
const XAHAU_NETWORKS: Record<number, string> = { 21337: 'xahau', 21338: 'xahau-testnet' };

const FASSETS_PREFIX = '464250526641'; // "FBPRfA"
const FASSETS_MINT: Record<number, string> = { 0x0001: 'minting', 0x0012: 'agent self-mint', 0x0018: 'direct minting', 0x0021: 'direct minting' };
const FASSETS_REDEEM: Record<number, string> = { 0x0002: 'redemption', 0x0005: 'redemption from the core vault' };
const FASSETS_INTERNAL: Record<number, string> = { 0x0003: 'agent withdrawal', 0x0004: 'return from the core vault', 0x0011: 'agent vault top-up' };

export function decodeCrossChain(tx: any, delivered: Amt | null, success: boolean, ctx: ChainCtx = XRPL_CTX, meta?: any): CrossChain | null {
  if (!success) return null;
  if (ctx.chain === 'xahau') return decodeXahau(tx, delivered, ctx, meta);
  const src: string = tx.Account;

  // XAH Teleport: XAH tokens to the Teleport account here become native XAH for the same address on Xahau.
  if (tx.TransactionType === 'Payment' && (tx.Destination === TELEPORT || src === TELEPORT) && delivered?.currency === 'XAH' && !delivered.isXrp) {
    const user = src === TELEPORT ? tx.Destination : src;
    const direction = src === TELEPORT ? 'in' : 'out';
    return { bridge: 'teleport', direction, chain: 'xahau', address: user, node: extId('xahau', user), local: user, amount: delivered, detail: direction === 'out' ? 'paid out to the same address on Xahau' : 'from the same address on Xahau' };
  }

  // Xahau Burn 2 Mint: the fee is burned here and can be minted for the same account on Xahau.
  const network = XAHAU_NETWORKS[Number(tx.OperationLimit)];
  if (network && B2M_TYPES.has(tx.TransactionType)) {
    return {
      bridge: 'b2m',
      direction: 'out',
      chain: network,
      address: src,
      node: extId(network, src),
      local: src,
      amount: parseAmount(tx.Fee),
      detail: 'burned as a fee, to be minted as XAH',
    };
  }

  if (tx.TransactionType !== 'Payment' || !tx.Memos) return null;
  const dst: string = tx.Destination;
  const memos = readMemos(tx);
  const kv: Record<string, string> = {};
  for (const m of memos) if (m.type) kv[m.type.toLowerCase()] = m.data;

  // Axelar interchain transfer (to the XRPL EVM Sidechain, Ethereum, ...).
  if (kv.destination_chain && kv.destination_address && (!kv.type || kv.type === 'interchain_transfer')) {
    const chain = kv.destination_chain.toLowerCase();
    let address = kv.destination_address;
    if (/^(0x)?[0-9a-f]{40}$/i.test(address)) address = `0x${address.replace(/^0x/i, '').toLowerCase()}`;
    let amount = delivered;
    const notes: string[] = [];
    const gas = Number(kv.gas_fee_amount);
    if (amount && Number.isFinite(gas) && gas > 0) {
      const g = amount.isXrp ? gas / 1e6 : gas;
      if (g < amount.value) {
        amount = { ...amount, value: amount.value - g };
        notes.push(`plus ${fmtNum(g)} ${amount.currency} gas fee`);
      }
    }
    if (kv.payload) notes.push('with instructions for the receiving contract');
    const detail = notes.length ? notes.join(', ') : undefined;
    return { bridge: 'axelar', direction: 'out', chain, address, node: extId(chain, address), local: src, amount, detail, doorMismatch: doorOf(dst)?.id !== 'axelar' };
  }
  // Funds released by Axelar may name where they came from.
  if (kv.source_chain && doorOf(src)?.id === 'axelar') {
    const chain = kv.source_chain.toLowerCase();
    return { bridge: 'axelar', direction: 'in', chain, node: extId(chain), local: dst, amount: delivered };
  }

  // Coreum bridge: JSON memo with the Coreum recipient.
  for (const m of memos) {
    if (!m.data.startsWith('{')) continue;
    try {
      const j = JSON.parse(m.data);
      if (typeof j.type === 'string' && j.type.startsWith('coreumbridge-xrpl') && typeof j.coreum_recipient === 'string') {
        const address = j.coreum_recipient;
        return { bridge: 'coreum', direction: 'out', chain: 'coreum', address, node: extId('coreum', address), local: src, amount: delivered, doorMismatch: doorOf(dst)?.id !== 'coreum' };
      }
    } catch {
      /* not JSON */
    }
  }

  // Wanchain: CrossChainInfo memo.
  const wan = memos.find((m) => m.type === 'CrossChainInfo');
  if (wan) {
    const h = wan.data.replace(/^0x/i, '');
    const kind = parseInt(h.slice(0, 2), 16);
    if (kind === 1 && /^[0-9a-f]{46}/i.test(h)) {
      const pair = parseInt(h.slice(2, 6), 16);
      const address = `0x${h.slice(6, 46).toLowerCase()}`;
      return { bridge: 'wanchain', direction: 'out', chain: 'evm', address, node: extId('evm', address), local: src, amount: delivered, detail: `Wanchain token pair #${pair}`, doorMismatch: doorOf(dst)?.id !== 'wanchain' };
    }
    if (kind === 2) return { bridge: 'wanchain', direction: 'in', chain: 'via-wanchain', node: extId('via-wanchain'), local: dst, amount: delivered, detail: 'release of funds sent from another chain' };
    if (kind === 3 || kind === 4) return { bridge: 'wanchain', direction: 'in', chain: 'via-wanchain', node: extId('via-wanchain'), local: dst, amount: delivered, detail: 'returned by the bridge' };
    if (kind === 5) return { bridge: 'wanchain', direction: 'internal', chain: 'via-wanchain', local: src, amount: delivered, detail: 'moving funds between its own operator groups' };
  }

  // Flare FAssets payment reference.
  const fa = memos.find((m) => m.raw.startsWith(FASSETS_PREFIX));
  if (fa) {
    const code = parseInt(fa.raw.slice(12, 16), 16);
    const idHex = fa.raw.slice(16, 64).replace(/^0+/, '');
    const ref = idHex && idHex.length <= 16 ? ` #${BigInt(`0x${idHex}`)}` : '';
    if (FASSETS_MINT[code]) {
      registerDoor(dst, 'flare');
      return { bridge: 'flare', direction: 'out', chain: 'flare', node: extId('flare'), local: src, amount: delivered, detail: `FXRP ${FASSETS_MINT[code]}${code === 0x0001 ? ref : ''}` };
    }
    if (FASSETS_REDEEM[code]) {
      registerDoor(src, 'flare');
      return { bridge: 'flare', direction: 'in', chain: 'flare', node: extId('flare'), local: dst, amount: delivered, detail: `FXRP ${FASSETS_REDEEM[code]}${ref}` };
    }
    if (FASSETS_INTERNAL[code]) {
      // Withdrawals leave an agent vault; top-ups and core-vault returns arrive at one.
      registerDoor(code === 0x0003 ? src : dst, 'flare');
      return { bridge: 'flare', direction: 'internal', chain: 'flare', local: src, amount: delivered, detail: FASSETS_INTERNAL[code] };
    }
  }
  return null;
}

/** Xahau side: Imports (Burn 2 Mint arrivals) and XAH Teleport. */
function decodeXahau(tx: any, delivered: Amt | null, ctx: ChainCtx, meta: any): CrossChain | null {
  const src: string = tx.Account;
  if (tx.TransactionType === 'Import') {
    // The Import embeds the XRP Ledger burn; the same address receives the XAH here.
    let minted: Amt | null = null;
    for (const w of meta?.AffectedNodes ?? []) {
      const n = w.ModifiedNode ?? w.CreatedNode;
      const f = n?.FinalFields ?? n?.NewFields;
      if (n?.LedgerEntryType === 'AccountRoot' && f?.Account === src) {
        const before = Number(n.PreviousFields?.Balance ?? (w.CreatedNode ? 0 : f.Balance));
        minted = { value: (Number(f.Balance) - before) / 1e6, currency: ctx.native, isXrp: true };
      }
    }
    return { bridge: 'b2m', direction: 'in', chain: 'xrpl', address: src, node: src, local: ctx.id(src), amount: minted, detail: 'imported from the XRP Ledger' };
  }
  if (tx.TransactionType === 'Payment' && (tx.Destination === TELEPORT || src === TELEPORT) && delivered?.isXrp) {
    const user = src === TELEPORT ? tx.Destination : src;
    const direction = src === TELEPORT ? 'in' : 'out';
    return { bridge: 'teleport', direction, chain: 'xrpl', address: user, node: user, local: ctx.id(user), amount: delivered, detail: direction === 'out' ? 'paid out to the same address on the XRP Ledger' : 'from the same address on the XRP Ledger' };
  }
  return null;
}
