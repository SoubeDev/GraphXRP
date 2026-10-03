/**
 * Networks GraphXRP can read directly. The XRP Ledger keeps plain `r…` ids;
 * everything else uses `ext:<chain>:<address>` ids (see bridges/registry).
 */
import { extId, isExternal, parseExt } from '../bridges/registry';

export type Network = 'xrpl' | 'xahau' | 'xrpl-evm';

export interface NetworkInfo {
  name: string;
  short: string;
  /** Native currency code. */
  native: string;
  blurb: string;
  explorer: { name: string; account: (a: string) => string; tx: (h: string) => string };
}

export const NETWORKS: Record<Network, NetworkInfo> = {
  xrpl: {
    name: 'XRP Ledger',
    short: 'XRPL',
    native: 'XRP',
    blurb: 'The original ledger, running since 2012.',
    explorer: { name: 'XRPL Explorer', account: (a) => `https://livenet.xrpl.org/accounts/${a}`, tx: (h) => `https://livenet.xrpl.org/transactions/${h}` },
  },
  xahau: {
    name: 'Xahau',
    short: 'Xahau',
    native: 'XAH',
    blurb: 'A sister network built from the XRP Ledger’s code, with smart contracts ("hooks"). It uses the same kind of addresses, and the same address means the same keys.',
    explorer: { name: 'Xahau Explorer', account: (a) => `https://xahauexplorer.com/explorer/${a}`, tx: (h) => `https://xahauexplorer.com/explorer/${h}` },
  },
  'xrpl-evm': {
    name: 'XRPL EVM Sidechain',
    short: 'XRPL EVM',
    native: 'XRP',
    blurb: 'An Ethereum-compatible chain where XRP pays the fees, connected to the XRP Ledger through the Axelar bridge.',
    explorer: { name: 'XRPL EVM Explorer', account: (a) => `https://explorer.xrplevm.org/address/${a}`, tx: (h) => `https://explorer.xrplevm.org/tx/${h}` },
  },
};

export const XAHAU_SERVERS = ['wss://xahau.org', 'wss://xahau.network'];

export function chainOf(id: string): string {
  return isExternal(id) ? parseExt(id).chain : 'xrpl';
}

export function isNetwork(chain: string): chain is Network {
  return chain in NETWORKS;
}

/** The address as the chain itself knows it. */
export function rawAddress(id: string): string {
  return isExternal(id) ? (parseExt(id).address ?? '') : id;
}

/** Can GraphXRP open this node (load its data from its own chain)? */
export function isLoadable(id: string): boolean {
  return isNetwork(chainOf(id)) && !!rawAddress(id);
}

export function nodeId(chain: Network, address: string): string {
  if (chain === 'xrpl') return address;
  return extId(chain, chain === 'xrpl-evm' ? address.toLowerCase() : address);
}

/** How transactions on an XRPL-protocol network map onto graph ids. */
export interface ChainCtx {
  chain: 'xrpl' | 'xahau';
  native: string;
  id(address: string): string;
}

export const XRPL_CTX: ChainCtx = { chain: 'xrpl', native: 'XRP', id: (a) => a };
export const XAHAU_CTX: ChainCtx = { chain: 'xahau', native: 'XAH', id: (a) => extId('xahau', a) };

/* ------------------------------------------------------------------ */
/* Xahau Burn 2 Mint proofs                                            */
/* ------------------------------------------------------------------ */

const TX_ID_PREFIX = [0x54, 0x58, 0x4e, 0x00]; // "TXN\0"

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * An Xahau Import carries an "XPOP": the burn transaction from the XRP Ledger plus
 * the validator signatures proving it. Hashing the embedded transaction gives the
 * XRP Ledger transaction ID, so the two sides are linked cryptographically.
 */
export async function xpopBurnHash(blobHex: string): Promise<string | null> {
  try {
    const xpop = JSON.parse(new TextDecoder().decode(hexToBytes(blobHex)));
    const txBlob: string | undefined = xpop?.transaction?.blob;
    if (!txBlob || !/^[0-9a-f]+$/i.test(txBlob)) return null;
    const body = hexToBytes(txBlob);
    const buf = new Uint8Array(TX_ID_PREFIX.length + body.length);
    buf.set(TX_ID_PREFIX, 0);
    buf.set(body, TX_ID_PREFIX.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', buf));
    return [...digest.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  } catch {
    return null;
  }
}
