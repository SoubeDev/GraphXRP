/**
 * Known bridges between the XRP Ledger and other blockchains, plus helpers for
 * addresses that live on those other chains ("external" nodes).
 */

export type BridgeId = 'axelar' | 'wanchain' | 'coreum' | 'flare' | 'allbridge' | 'teleport' | 'orbit' | 'xpr' | 'multichain' | 'b2m';

export interface Bridge {
  id: BridgeId;
  name: string;
  url: string;
  /** What it is, in plain words. */
  blurb: string;
  /** Something a newcomer should know before trusting it. */
  caution?: string;
}

export const BRIDGES: Record<BridgeId, Bridge> = {
  axelar: {
    id: 'axelar',
    name: 'Axelar',
    url: 'https://axelar.network',
    blurb: 'A cross-chain network secured by its own validators. Its gateway account on the XRP Ledger holds deposits headed to other chains (such as the XRPL EVM Sidechain and Ethereum) and pays out funds coming back.',
  },
  wanchain: {
    id: 'wanchain',
    name: 'Wanchain',
    url: 'https://bridge.wanchain.org',
    blurb: 'A bridge whose XRP Ledger accounts are jointly controlled by groups of Wanchain node operators ("storeman groups").',
  },
  coreum: {
    id: 'coreum',
    name: 'Coreum Bridge',
    url: 'https://coreum.com',
    blurb: 'Connects the XRP Ledger with the Coreum blockchain. A group of relayers jointly controls the door account.',
  },
  flare: {
    id: 'flare',
    name: 'Flare FAssets',
    url: 'https://flare.network',
    blurb: 'Turns XRP into FXRP on the Flare network. The XRP stays on the XRP Ledger with "agents" (and a core vault), backed by collateral on Flare, while FXRP circulates on Flare.',
  },
  allbridge: {
    id: 'allbridge',
    name: 'Allbridge',
    url: 'https://allbridge.io',
    blurb: 'A cross-chain bridge. Its XRP Ledger deposits carry reference codes rather than destinations, so where the funds went isn’t readable on this ledger.',
  },
  teleport: {
    id: 'teleport',
    name: 'XAH Teleport',
    url: 'https://xahau.org',
    blurb: 'Moves value between the XRP Ledger and Xahau, a sister network that uses the same kind of addresses.',
  },
  orbit: {
    id: 'orbit',
    name: 'Orbit Bridge',
    url: 'https://bridge.orbitchain.io',
    blurb: 'A bridge operated by Orbit Chain.',
    caution: 'Orbit Bridge lost about $80 million to a hack in January 2024.',
  },
  xpr: {
    id: 'xpr',
    name: 'XPR Network Bridge',
    url: 'https://xprnetwork.org',
    blurb: 'Connects the XRP Ledger with XPR Network.',
  },
  multichain: {
    id: 'multichain',
    name: 'Multichain',
    url: 'https://multichain.org',
    blurb: 'A cross-chain router.',
    caution: 'Multichain stopped operating in July 2023 after its funds were drained.',
  },
  b2m: {
    id: 'b2m',
    name: 'Burn 2 Mint',
    url: 'https://xahau.network/docs/features/burn-2-mint/',
    blurb: 'A protocol rather than an operator: XRP burned as a transaction fee on the XRP Ledger can be minted as XAH for the same account on Xahau.',
  },
};

/** Door accounts confirmed from bridge documentation or the XRPScan directory. */
const STATIC_DOORS: Record<string, BridgeId> = {
  rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw: 'axelar',
  rxXXXeMX8Gy5YvibvGLnQJ1XKKD7UswM1: 'coreum',
  rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj: 'flare',
  rMLNvZR9dascY5jtCfCv3whAp8HdUSZAQ: 'flare',
  r4w1LrneWZqX5RrgFPx2gto66dwo2Zymqy: 'allbridge',
  rTeLeproT3BVgjWoYrDYpKbBLXPaVMkge: 'teleport',
  rLcxBUrZESqHnruY4fX7GQthRjDCDSAWia: 'orbit',
  rKoePMg1MnWu19E38fqUji4eX6qNgdoTAr: 'xpr',
  rDsvn6aJG4YMQdHnuJtP9NLrFp18JYTJUf: 'multichain',
  // The same bridges' accounts on connected networks.
  'ext:xahau:rTeLeproT3BVgjWoYrDYpKbBLXPaVMkge': 'teleport',
  'ext:xrpl-evm:0xb5fb4be02232b1bba4dc8f81dc24c26980de9e3c': 'axelar',
};

/** Directory entries (name + domain) that identify more door accounts, e.g. Wanchain's 25 wallets. */
const DIRECTORY_RULES: { domain: RegExp; name?: RegExp; bridge: BridgeId }[] = [
  { domain: /^bridge\.wanchain\.org$/, bridge: 'wanchain' },
  { domain: /(^|\.)axelar\./, name: /bridge|gateway/i, bridge: 'axelar' },
  { domain: /^coreum\.com$/, name: /bridge/i, bridge: 'coreum' },
  { domain: /^flare\.network$/, name: /vault/i, bridge: 'flare' },
  { domain: /orbitchain\.io$/, bridge: 'orbit' },
  { domain: /allbridge\.io$/, bridge: 'allbridge' },
  { domain: /multichain\.org$/, bridge: 'multichain' },
  { domain: /xprnetwork\.org$/, name: /bridge/i, bridge: 'xpr' },
];

/** Doors discovered while reading transactions (e.g. FAssets agent vaults). */
const discovered = new Map<string, BridgeId>();

type KnownLookup = (addr: string) => { name: string; desc?: string; domain?: string } | undefined;
let knownLookup: KnownLookup = () => undefined;

export function setKnownLookup(fn: KnownLookup) {
  knownLookup = fn;
}

export function registerDoor(addr: string | undefined, bridge: BridgeId) {
  if (addr && !STATIC_DOORS[addr]) discovered.set(addr, bridge);
}

export function doorOf(addr: string | undefined): Bridge | undefined {
  if (!addr) return undefined;
  const id = STATIC_DOORS[addr] ?? discovered.get(addr) ?? fromDirectory(addr);
  return id ? BRIDGES[id] : undefined;
}

function fromDirectory(addr: string): BridgeId | undefined {
  const k = knownLookup(addr);
  if (!k?.domain) return undefined;
  for (const r of DIRECTORY_RULES) {
    if (r.domain.test(k.domain) && (!r.name || r.name.test(`${k.name} ${k.desc ?? ''}`))) return r.bridge;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Other chains                                                        */
/* ------------------------------------------------------------------ */

const CHAIN_NAMES: Record<string, string> = {
  xrpl: 'XRP Ledger',
  'xrpl-evm': 'XRPL EVM Sidechain',
  ethereum: 'Ethereum',
  flare: 'Flare',
  coreum: 'Coreum',
  xahau: 'Xahau',
  'xahau-testnet': 'Xahau Testnet',
  hedera: 'Hedera',
  avalanche: 'Avalanche',
  polygon: 'Polygon',
  binance: 'BNB Chain',
  arbitrum: 'Arbitrum',
  base: 'Base',
  optimism: 'Optimism',
  linea: 'Linea',
  scroll: 'Scroll',
  mantle: 'Mantle',
  celo: 'Celo',
  fantom: 'Fantom',
  moonbeam: 'Moonbeam',
  kava: 'Kava',
  filecoin: 'Filecoin',
  blast: 'Blast',
  sui: 'Sui',
  stellar: 'Stellar',
  evm: 'EVM chain',
  'via-wanchain': 'Other chains (via Wanchain)',
};

const EXPLORERS: Record<string, (a: string) => string> = {
  'xrpl-evm': (a) => `https://explorer.xrplevm.org/address/${a}`,
  ethereum: (a) => `https://etherscan.io/address/${a}`,
  flare: (a) => `https://flare-explorer.flare.network/address/${a}`,
  coreum: (a) => `https://www.mintscan.io/coreum/address/${a}`,
  xahau: (a) => `https://xahauexplorer.com/explorer/${a}`,
};

export function chainName(key: string): string {
  return CHAIN_NAMES[key] ?? key.replace(/(^|[-_ ])(\w)/g, (_, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase());
}

export function explorerFor(chain: string, address: string): { name: string; href: string } | undefined {
  const f = EXPLORERS[chain];
  if (f) return { name: new URL(f(address)).hostname.replace(/^www\./, ''), href: f(address) };
  if (/^0x[0-9a-f]{40}$/i.test(address)) return { name: 'Blockscan (searches all EVM chains)', href: `https://blockscan.com/address/${address}` };
  return undefined;
}

export const EXT_PREFIX = 'ext:';

export const isExternal = (id: string) => id.startsWith(EXT_PREFIX);

/** An address on another chain, or (without an address) the chain itself. */
export function extId(chain: string, address?: string): string {
  return address ? `${EXT_PREFIX}${chain}:${address}` : `${EXT_PREFIX}${chain}`;
}

export function parseExt(id: string): { chain: string; address?: string } {
  const rest = id.slice(EXT_PREFIX.length);
  const i = rest.indexOf(':');
  return i < 0 ? { chain: rest } : { chain: rest.slice(0, i), address: rest.slice(i + 1) };
}

export const isChainHub = (id: string) => isExternal(id) && !parseExt(id).address;

export function shortForeign(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function extLabel(id: string): string {
  const { chain, address } = parseExt(id);
  return address ? `${shortForeign(address)} · ${chainName(chain)}` : chainName(chain);
}
