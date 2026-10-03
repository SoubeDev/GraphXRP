/** Application controller: wires ledger data, identities and the graph together. */
import { XrplClient, DEFAULT_SERVERS } from './xrpl/client';
import { Loader, summarize, summarizeFlows, type AccountData, type AmmPool } from './xrpl/loader';
import { Directory } from './identity/directory';
import { GraphModel, type NodeKind } from './graph/model';
import { GraphView, type Palette, type ViewHooks } from './graph/view';
import { loadSettings, saveSettings, type Settings } from './settings';
import { F, has, BLACKHOLES } from './xrpl/flags';
import type { Amt } from './xrpl/amount';
import type { EdgeType, Flow, ParsedTx } from './xrpl/parse';
import { doorOf, extId, isChainHub, isExternal, setKnownLookup } from './bridges/registry';
import type { CrossChain } from './bridges/decode';
import { Verifier, type Check } from './bridges/verify';
import { XAHAU_CTX, XAHAU_SERVERS, chainOf, isLoadable, nodeId, rawAddress, type Network } from './chains/chains';
import { EvmLoader, type EvmAccount, type EvmEvent } from './chains/evm';

export interface TraceStep {
  child: string;
  parent: string;
  /** Edge type linking them (account creation, or an import from another network). */
  edge?: EdgeType;
  date?: number;
  amount?: Amt | null;
  hash?: string;
}

export interface Trace {
  kind: 'origin' | 'funding';
  start: string;
  steps: TraceStep[];
  running: boolean;
  end?: 'known' | 'genesis' | 'history' | 'none' | 'loop' | 'limit' | 'error';
}

type Events = {
  select: string | null;
  account: string;
  graph: void;
  trace: string;
  settings: void;
  toast: { text: string; tone?: 'info' | 'error' };
  /** A secondary network connected or changed state. */
  networks: void;
  /** A left-side panel opened; the others close so they never stack. */
  panel: 'settings' | 'wallets';
};

/** A cross-chain transaction seen on the map, from any network. */
export interface CrossRecord {
  hash: string;
  date: number;
  network: Network;
  cross: CrossChain;
  item: ParsedTx | EvmEvent;
  /** Flow key of the cross-chain edge, for marking it confirmed. */
  key: string;
}

export interface SearchExtra {
  title: string;
  /** XRP Ledger address it stands for, so directory results don't repeat it. */
  address?: string;
  tag?: string;
  sub: string;
  kind: string;
  run: () => void;
}

export interface MenuExtra {
  icon: string;
  label: string;
  run: () => void;
}

/** Optional features that plug into the explorer (the local wallet manager). The explorer works without them. */
export interface AppExtensions {
  search?(q: string): SearchExtra[];
  inspectorBanner?(id: string): HTMLElement | null;
  contextItems?(id: string): MenuExtra[];
}

export const KIND_LABEL: Record<NodeKind, string> = {
  issuer: 'Token issuer',
  exchange: 'Exchange or service',
  amm: 'AMM liquidity pool',
  bridge: 'Bridge door',
  contract: 'Smart contract',
  wallet: 'Wallet',
  external: 'On another chain',
  flagged: 'Flagged account',
  inactive: 'Inactive address',
};

export const KIND_HINT: Record<NodeKind, string> = {
  issuer: 'Creates tokens (like stablecoins or project tokens) that others can hold.',
  exchange: 'A business that holds funds for many customers, usually an exchange.',
  amm: 'A robot pool that trades two assets automatically. Nobody owns it.',
  bridge: 'An account run by a cross-chain bridge. Funds sent here leave its network and reappear on another blockchain.',
  contract: 'A program living on the XRPL EVM Sidechain. It holds funds or acts when someone calls it.',
  wallet: 'A regular account. Most belong to individuals.',
  external: 'An address on a different blockchain, named in an XRP Ledger transaction. It can\u2019t be opened here yet.',
  flagged: 'A public directory has flagged this account. Be careful.',
  inactive: 'No account exists here now (deleted or never funded).',
};

const EXCHANGE_RE =
  /binance|coinbase|kraken|bitstamp|uphold|upbit|bithumb|bitso|bitfinex|bittrex|huobi|\bhtx\b|okx|okex|kucoin|gate\.?io|bybit|crypto\.com|poloniex|bitbank|bitflyer|coincheck|coinone|korbit|gemini|mexc|bitget|bitmart|bitrue|btcturk|independent reserve|luno|wazirx|zebpay|coinspot|swyftx|revolut|robinhood|etoro|bitpanda|bitvavo|indodax|coins\.ph|bitpoint|ascendex|lbank|probit|hotbit|changelly|changenow|nexo|wirex|bitkub|cex\.io|exmo|coinjar|xchange|1xbet|stake\.com|gatehub/i;

export const flowKey = (hash: string, f: Flow) => `${hash}:${f.from}:${f.to}:${f.type}`;

export class App {
  readonly settings: Settings = loadSettings();
  readonly client = new XrplClient(this.settings.server ? [this.settings.server] : DEFAULT_SERVERS);
  /** XRP Ledger loader (other networks have their own; see loaderFor). */
  readonly loader = new Loader(this.client);
  readonly evm = new EvmLoader();
  private xahauClientInst?: XrplClient;
  private xahauLoaderInst?: Loader;
  readonly verifier = new Verifier({ xrpl: this.client, xahau: () => this.xahauClient, evm: this.evm });
  readonly dir = new Directory();
  readonly model = new GraphModel();
  view!: GraphView;

  selected: string | null = null;
  readonly traces = new Map<string, Trace>();
  /** Breadcrumb trail of visited accounts. */
  readonly visited: string[] = [];
  readonly ext: AppExtensions = {};
  onContext?: ViewHooks['context'];
  onHover?: ViewHooks['hover'];
  private bus = new Map<keyof Events, Set<(arg: any) => void>>();
  private refreshQueued = false;
  private fromHistory = false;

  constructor(private graphHost: HTMLElement) {}

  /* ----------------------------- networks ----------------------------- */

  /** Xahau connection, opened the first time something on Xahau is needed. */
  get xahauClient(): XrplClient {
    if (!this.xahauClientInst) {
      this.xahauClientInst = new XrplClient(XAHAU_SERVERS);
      this.xahauClientInst.start();
      this.xahauClientInst.onChange(() => this.emit('networks', undefined));
      this.emit('networks', undefined);
    }
    return this.xahauClientInst;
  }

  get xahauConnected(): XrplClient | undefined {
    return this.xahauClientInst;
  }

  get xahauLoader(): Loader {
    if (!this.xahauLoaderInst) {
      this.xahauLoaderInst = new Loader(this.xahauClient, XAHAU_CTX);
      this.xahauLoaderInst.onUpdate = (id) => {
        this.syncNode(id);
        this.emit('account', id);
      };
    }
    return this.xahauLoaderInst;
  }

  /** The XRPL-protocol loader for a node (XRP Ledger or Xahau), if it lives on one. */
  loaderFor(id: string): Loader | undefined {
    const chain = chainOf(id);
    if (chain === 'xrpl') return this.loader;
    if (chain === 'xahau' && isLoadable(id)) return this.xahauLoader;
    return undefined;
  }

  /** Loaded ledger data for an XRP Ledger or Xahau account. */
  accountData(id: string): AccountData | undefined {
    return this.loaderFor(id)?.loaded.get(id);
  }

  start() {
    this.applyTheme();
    this.view = new GraphView(this.graphHost, this.model, this.settings, this.readPalette(), {
      select: (id) => this.select(id),
      expand: (id) => void this.expand(id),
      context: (id, x, y) => this.onContext?.(id, x, y),
      hover: (t, x, y) => this.onHover?.(t, x, y),
    });
    this.client.start();
    this.loader.onUpdate = (addr) => {
      this.syncNode(addr);
      this.emit('account', addr);
    };
    this.dir.onChange((addr) => {
      this.syncNode(addr);
      if (addr === this.selected) this.emit('account', addr);
    });
    setKnownLookup((a) => this.dir.known.get(a));
    this.verifier.onChange = (hash, check) => this.onCheck(hash, check);
    this.dir.init().then(() => {
      for (const id of this.model.nodes.keys()) this.syncNode(id);
      this.emit('graph', undefined);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    window.addEventListener('popstate', () => this.routeFromHash());
  }

  /* ------------------------------ events ------------------------------ */

  on<K extends keyof Events>(evt: K, fn: (arg: Events[K]) => void) {
    (this.bus.get(evt) ?? this.bus.set(evt, new Set()).get(evt)!).add(fn);
  }

  emit<K extends keyof Events>(evt: K, arg: Events[K]) {
    for (const fn of this.bus.get(evt) ?? []) fn(arg);
  }

  toast(text: string, tone: 'info' | 'error' = 'info') {
    this.emit('toast', { text, tone });
  }

  /* ------------------------------ theme ------------------------------- */

  applyTheme() {
    const t = this.settings.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    if (this.view) {
      this.view.palette = this.readPalette();
      this.view.invalidate();
    }
  }

  isDark() {
    const t = this.settings.theme;
    return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  private readPalette(): Palette {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return {
      bg: v('--canvas'),
      text: v('--text'),
      textMuted: v('--muted'),
      accent: v('--accent'),
      ring: v('--ring'),
      edgeAlpha: Number(v('--edge-alpha')) || 0.35,
      kind: {
        issuer: v('--k-issuer'),
        exchange: v('--k-exchange'),
        amm: v('--k-amm'),
        bridge: v('--k-bridge'),
        contract: v('--k-contract'),
        wallet: v('--k-wallet'),
        external: v('--k-external'),
        flagged: v('--k-flagged'),
        inactive: v('--k-inactive'),
      },
      edge: {
        payment: v('--e-payment'),
        activation: v('--e-activation'),
        trust: v('--e-trust'),
        dex: v('--e-dex'),
        control: v('--e-control'),
        crosschain: v('--e-crosschain'),
        contract: v('--e-contract'),
      },
    };
  }

  updateSettings(patch: Partial<Settings>, opts: { refresh?: boolean; forces?: boolean } = {}) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    if (patch.theme) this.applyTheme();
    if (patch.server !== undefined) this.client.setServers(patch.server ? [patch.server] : DEFAULT_SERVERS);
    if (opts.forces) {
      this.view.applyForces();
      this.view.reheat(0.4);
    }
    if (opts.refresh) this.view.refresh(false);
    this.view.invalidate();
    this.emit('settings', undefined);
  }

  /* --------------------------- classification -------------------------- */

  classify(id: string): NodeKind {
    const chain = chainOf(id);
    if (chain === 'xrpl-evm' && isLoadable(id)) return this.classifyEvm(id);
    const L = this.loaderFor(id);
    if (!L) return 'external';
    const ident = this.dir.get(id);
    if (ident.advisory || ident.xamanBlocked) return 'flagged';
    if (doorOf(id)) return 'bridge';
    const d = L.loaded.get(id);
    const p = L.probed.get(id);
    const exists = d?.exists ?? p?.exists;
    if (exists === false || BLACKHOLES.has(rawAddress(id))) return 'inactive';
    if (d?.ammId ?? p?.ammId) return 'amm';
    if (d && (d.obligations.length || d.lines.some((l) => l.balance < 0))) return 'issuer';
    const k = ident.known;
    if (!d && /issuer/i.test(k?.desc ?? '')) return 'issuer';
    const flags = d?.flags ?? p?.flags;
    if (flags != null) {
      // Only issuers need rippling on; some (like RLUSD) also require destination tags.
      if (!d && has(flags, F.DefaultRipple)) return 'issuer';
      if (has(flags, F.RequireDestTag)) return 'exchange';
    }
    if (k && EXCHANGE_RE.test(k.name)) return 'exchange';
    return 'wallet';
  }

  private classifyEvm(id: string): NodeKind {
    if (doorOf(id)) return 'bridge';
    const info = this.evm.loaded.get(id) ?? this.evm.probed.get(id);
    if (!info) return 'wallet';
    if (!info.exists) return 'inactive';
    if (info.token) return 'issuer';
    if (info.isContract) return 'contract';
    return 'wallet';
  }

  /** Names for XRPL EVM addresses come from the explorer (contract names, tokens). */
  private nameEvm(id: string) {
    const info = this.evm.loaded.get(id) ?? this.evm.probed.get(id);
    if (!info) return;
    if (info.token) this.dir.setDerived(id, `${info.token.name} (${info.token.symbol})`, `${info.token.type} token contract "${info.token.symbol}"`, 'XRPL EVM explorer');
    else if (info.name) this.dir.setDerived(id, info.name, info.isContract ? `Contract named "${info.name}"` : `Named "${info.name}"`, 'XRPL EVM explorer');
  }

  syncNode(id: string) {
    const n = this.model.nodes.get(id);
    if (!n) return;
    const ident = this.dir.get(id);
    n.label = this.dir.label(id);
    n.named = !!ident.name || isChainHub(id);
    const L = this.loaderFor(id);
    n.balance = L ? (L.loaded.get(id)?.balance ?? L.probed.get(id)?.balance) : (this.evm.loaded.get(id) ?? this.evm.probed.get(id))?.balance;
    const kind = this.classify(id);
    if (kind !== n.kind) {
      n.kind = kind;
      this.queueRefresh();
    }
    this.view?.invalidate();
  }

  private queueRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.view.refresh(false);
      this.emit('graph', undefined);
    });
  }

  /** Background work for a node we just met: name lookup and a cheap ledger probe. */
  private prepareNode(id: string) {
    this.syncNode(id);
    this.linkTwins(id);
    if (chainOf(id) === 'xrpl-evm' && isLoadable(id)) {
      this.evm
        .probe(id)
        .then(() => {
          this.nameEvm(id);
          this.syncNode(id);
        })
        .catch(() => {});
      return;
    }
    const L = this.loaderFor(id);
    if (!L) return; // on a network GraphXRP can't read
    this.dir.enrichLight(rawAddress(id)); // same address = same keys, so names carry over to Xahau
    L.probe(id)
      .then((p) => {
        this.syncNode(id);
        if (p.ammId) L.ammInfo(id, true).then((pool) => pool && this.namePool(id, pool));
      })
      .catch(() => {});
  }

  /**
   * The same r-address on the XRP Ledger and on Xahau is controlled by the same
   * master key, so when both are on the map they're linked.
   */
  private linkTwins(id: string) {
    const chain = chainOf(id);
    const twin = chain === 'xrpl' ? extId('xahau', id) : chain === 'xahau' ? rawAddress(id) : null;
    if (!twin || !this.model.nodes.has(twin)) return;
    const [xrpl, xahau] = chain === 'xrpl' ? [id, twin] : [twin, id];
    this.model.setControl(xrpl, xahau, 'same keys on both networks');
    this.model.setControl(xahau, xrpl, 'same keys on both networks');
  }

  private namePool(id: string, pool: AmmPool) {
    const a = pool.asset1.currency;
    const b = pool.asset2.currency;
    this.dir.setDerived(id, `${a} / ${b} pool`, `AMM pool trading ${a} and ${b}`);
  }

  /* ----------------------------- navigation ---------------------------- */

  select(id: string | null) {
    if (id === this.selected) {
      if (id) this.emit('select', id);
      return;
    }
    this.selected = id;
    this.view.selected = id;
    if (id) {
      if (!this.model.nodes.has(id)) {
        this.model.ensure(id);
        this.prepareNode(id);
      }
      const i = this.visited.indexOf(id);
      if (i >= 0) this.visited.splice(i, 1);
      this.visited.push(id);
      if (this.visited.length > 12) this.visited.shift();
      if (isLoadable(id)) {
        const hash = this.hashFor(id);
        if (!this.fromHistory && location.hash.slice(1) !== hash) history.pushState(null, '', `#${hash}`);
        if (chainOf(id) === 'xrpl-evm') void this.loadEvm(id).catch(() => {});
        else void this.loadAccount(id).catch(() => {});
      }
      // Otherwise it's on a network GraphXRP can't read; the inspector shows what we know.
    } else if (!this.fromHistory && location.hash) {
      history.pushState(null, '', location.pathname + location.search);
    }
    this.view.refresh(false);
    this.emit('select', id);
  }

  /** URL fragment for a node: `r…` on the XRP Ledger, `xahau:r…`, `xrpl-evm:0x…`. */
  hashFor(id: string): string {
    const chain = chainOf(id);
    return chain === 'xrpl' ? id : `${chain}:${rawAddress(id)}`;
  }

  routeFromHash() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    this.fromHistory = true;
    try {
      const m = /^(?:(xahau|xrpl-evm):)?(r[1-9A-HJ-NP-Za-km-z]{24,34}|0x[0-9a-fA-F]{40})$/.exec(h);
      if (m && (m[2].startsWith('r') ? m[1] !== 'xrpl-evm' : m[1] === 'xrpl-evm')) {
        const id = nodeId((m[1] as Network | undefined) ?? 'xrpl', m[2]);
        if (this.model.nodes.has(id)) {
          this.select(id);
          this.view.focusNode(id);
        } else void this.explore(id);
      } else if (/^tx\/[0-9A-Fa-f]{64}$/.test(h)) {
        void this.openTx(h.slice(3));
      } else if (!h) this.select(null);
    } finally {
      this.fromHistory = false;
    }
  }

  /** Search entry point: put an account on the map, open it and show its neighborhood. */
  async explore(id: string) {
    const isNew = !this.model.nodes.has(id);
    const n = this.model.ensure(id, this.selected ? this.model.nodes.get(this.selected) : undefined);
    if (this.model.nodes.size === 1) {
      n.x = 0;
      n.y = 0;
    }
    this.prepareNode(id);
    this.select(id);
    this.view.focusNode(id, isNew ? 1.2 : undefined);
    await this.expand(id);
    if (isNew) {
      const fit = () => this.view.fit([id, ...this.model.neighbors(id)]);
      setTimeout(fit, 1100);
      // Accounts on other networks drift to their own islands; frame them once they arrive.
      setTimeout(() => this.model.neighbors(id).some((nb) => chainOf(nb) !== chainOf(id)) && fit(), 2800);
    }
  }

  /** Load an XRP Ledger or Xahau account (XRPL EVM addresses use loadEvm). */
  async loadAccount(id: string): Promise<AccountData> {
    const L = this.loaderFor(id);
    if (!L) throw new Error('This address is on a network GraphXRP can\u2019t read yet.');
    const n = this.model.nodes.get(id);
    if (n && n.state !== 'loaded') {
      n.state = 'loading';
      this.view.invalidate();
    }
    if (chainOf(id) === 'xrpl') void this.dir.enrichDeep(id);
    else this.dir.enrichLight(rawAddress(id));
    try {
      const d = await L.account(id);
      if (n) n.state = 'loaded';
      if (chainOf(id) === 'xrpl') this.dir.checkDomain(id, d.domain);
      if (d.amm) this.namePool(id, d.amm);
      this.syncNode(id);
      this.checkCrossings(d.txs.map((t) => this.recordOf(t, d.chain)));
      this.emit('account', id);
      return d;
    } catch (e) {
      if (n) n.state = 'error';
      this.view.invalidate();
      this.toast(`Couldn't load ${this.dir.label(id)}: ${(e as Error).message}`, 'error');
      this.emit('account', id);
      throw e;
    }
  }

  /** Load an address on the XRPL EVM Sidechain. */
  async loadEvm(id: string): Promise<EvmAccount> {
    const n = this.model.nodes.get(id);
    if (n && n.state !== 'loaded') {
      n.state = 'loading';
      this.view.invalidate();
    }
    try {
      const acc = await this.evm.account(id);
      if (n) n.state = 'loaded';
      this.nameEvm(id);
      this.syncNode(id);
      this.checkCrossings(acc.events.map((e) => this.recordOf(e, 'xrpl-evm')));
      this.emit('account', id);
      return acc;
    } catch (e) {
      if (n) n.state = 'error';
      this.view.invalidate();
      this.toast(`Couldn't load ${this.dir.label(id)}: ${(e as Error).message}`, 'error');
      this.emit('account', id);
      throw e;
    }
  }

  async expand(id: string, all = false): Promise<number> {
    if (!isLoadable(id)) {
      this.toast('That network isn\u2019t connected yet, so this address can\u2019t be expanded. Only the transactions that point to it are known.');
      return 0;
    }
    if (chainOf(id) === 'xrpl-evm') {
      this.model.ensure(id);
      let acc: EvmAccount;
      try {
        acc = await this.loadEvm(id);
      } catch {
        return 0;
      }
      const added = this.addEvmNeighborhood(acc, all ? Infinity : this.settings.neighborLimit);
      const n = this.model.nodes.get(id);
      if (n) n.expanded = true;
      this.view.refresh(true);
      this.emit('graph', undefined);
      this.emit('account', id);
      return added;
    }
    this.model.ensure(id);
    let d: AccountData;
    try {
      d = await this.loadAccount(id);
    } catch {
      return 0;
    }
    const added = this.addNeighborhood(d, all ? Infinity : this.settings.neighborLimit);
    const n = this.model.nodes.get(id);
    if (n) n.expanded = true;
    this.view.refresh(true);
    this.emit('graph', undefined);
    this.emit('account', id);
    return added;
  }

  /** Remove neighbors that only hang off this node (and aren't otherwise interesting). */
  collapse(id: string) {
    const n = this.model.nodes.get(id);
    if (!n) return;
    for (const nb of this.model.neighbors(id)) {
      const m = this.model.nodes.get(nb);
      if (!m || m.expanded || m.pinned || nb === this.selected) continue;
      if (this.model.neighbors(nb).length <= 1) this.model.remove(nb);
    }
    n.expanded = false;
    this.view.refresh(true);
    this.emit('graph', undefined);
  }

  addNeighborhood(d: AccountData, limit: number): number {
    const me = d.address;
    const node = this.model.nodes.get(me) ?? this.model.ensure(me);
    const before = this.model.nodes.size;
    const fresh: string[] = [];
    const touch = (other: string) => {
      if (!this.model.nodes.has(other)) {
        this.model.ensure(other, node);
        fresh.push(other);
      }
    };
    const summary = summarize(d);
    const chosen = new Set(summary.counterparties.slice(0, limit).map((c) => c.address));
    // Cross-chain destinations are always shown: they're where funds leave the ledger.
    for (const t of d.txs) this.addTxFlows(t, me, (other) => chosen.has(other) || isExternal(other) || this.model.nodes.has(other), touch);

    const held = d.lines.filter((l) => l.balance > 0 || (l.balance === 0 && l.limit > 0));
    const holders = d.lines.filter((l) => l.balance < 0 || (l.balance === 0 && l.limit === 0 && l.limitPeer > 0)).sort((a, b) => a.balance - b.balance);
    for (const l of held.slice(0, limit)) {
      touch(l.peer);
      this.model.setTrust(me, l.peer, l.currency, l.balance);
    }
    for (const l of holders.slice(0, limit)) {
      touch(l.peer);
      this.model.setTrust(l.peer, me, l.currency, -l.balance);
    }
    const a = d.activation;
    if (a?.parent && a.via === 'Import') {
      // Created on Xahau by importing from the XRP Ledger: link the two networks (proven by the Import).
      touch(a.parent);
      const key = `${a.hash}:${a.parent}:${me}:crosschain`;
      this.model.addFlow(a.parent, me, 'crosschain', a.amount, a.date ?? 0, key);
      this.model.confirm(a.parent, me, key);
    } else if (a?.parent) {
      touch(a.parent);
      this.model.addFlow(a.parent, me, 'activation', a.amount, a.date ?? 0, `${a.hash}:${a.parent}:${me}:activation`);
    }
    if (d.regularKey) {
      touch(d.regularKey);
      this.model.setControl(d.regularKey, me, 'regular key');
    }
    for (const s of d.signers?.entries ?? []) {
      touch(s.account);
      this.model.setControl(s.account, me, `signer (weight ${s.weight})`);
    }
    for (const id of fresh) this.prepareNode(id);
    return this.model.nodes.size - before;
  }

  private addTxFlows(t: ParsedTx, me: string | null, allow: (other: string) => boolean, touch: (id: string) => void) {
    this.addItemFlows(t, t.hash, [t.account, t.destination], this.recordOf(t, t.net), me, allow, touch);
  }

  private addEventFlows(e: EvmEvent, me: string | null, allow: (other: string) => boolean, touch: (id: string) => void) {
    this.addItemFlows(e, `${e.hash}#${e.part}`, [e.from, e.to], this.recordOf(e, 'xrpl-evm'), me, allow, touch);
  }

  private addItemFlows(
    item: { date: number; flows: Flow[]; cross: CrossChain | null },
    key: string,
    parties: (string | undefined)[],
    rec: CrossRecord | null,
    me: string | null,
    allow: (other: string) => boolean,
    touch: (id: string) => void,
  ) {
    for (const f of item.flows) {
      if (!me) {
        touch(f.from);
        touch(f.to);
      } else if (f.from === me || f.to === me) {
        const other = f.from === me ? f.to : f.from;
        if (!allow(other)) continue;
        touch(other);
      } else if (f.type === 'crosschain' && item.cross?.node && parties.includes(me)) {
        // `me` is the bridge door: show where its depositor's funds went (or came from).
        if (!allow(item.cross.local)) continue;
        touch(item.cross.local);
        touch(item.cross.node);
      } else continue;
      this.model.addFlow(f.from, f.to, f.type, f.amount, item.date, flowKey(key, f));
      if (f.type === 'crosschain' && rec) this.logCross(rec);
    }
  }

  /** Cross-chain transactions seen so far, by graph node (on either side). */
  readonly crossLog = new Map<string, Map<string, CrossRecord>>();
  private crossByHash = new Map<string, CrossRecord>();

  recordOf(item: ParsedTx | EvmEvent, network: Network): CrossRecord | null {
    const c = item.cross;
    if (!c || c.direction === 'internal' || !c.node) return null;
    const from = c.direction === 'out' ? c.local : c.node;
    const to = c.direction === 'out' ? c.node : c.local;
    const base = 'part' in item ? `${item.hash}#${item.part}` : item.hash;
    return { hash: item.hash, date: item.date, network, cross: c, item, key: flowKey(base, { from, to, type: 'crosschain' }) };
  }

  private logCross(rec: CrossRecord) {
    for (const k of [rec.cross.node, rec.cross.local]) {
      if (!k) continue;
      (this.crossLog.get(k) ?? this.crossLog.set(k, new Map()).get(k)!).set(rec.hash, rec);
    }
    this.crossByHash.set(rec.hash, rec);
    this.checkCrossings([rec]);
  }

  /** Ask the verifier to confirm crossings on the other network (cached, rate-limited). */
  checkCrossings(list: (CrossRecord | null)[]) {
    let n = 0;
    for (const rec of list) {
      if (!rec || !Verifier.canVerify(rec.cross)) continue;
      this.crossByHash.set(rec.hash, rec);
      const known = this.verifier.get(rec.hash);
      if (known) {
        if (known.status === 'confirmed') this.markConfirmed(rec);
        continue;
      }
      if (n++ >= 12) break; // the rest get checked when they're opened
      void this.verifier.check({ hash: rec.hash, date: rec.date, network: rec.network, cross: rec.cross, tx: 'tx' in rec.item ? rec.item.tx : undefined });
    }
  }

  private markConfirmed(rec: CrossRecord) {
    const c = rec.cross;
    const from = c.direction === 'out' ? c.local : c.node!;
    const to = c.direction === 'out' ? c.node! : c.local;
    if (this.model.confirm(from, to, rec.key)) this.view?.invalidate();
  }

  private onCheck(hash: string, check: Check) {
    const rec = this.crossByHash.get(hash);
    if (rec && check.status === 'confirmed') this.markConfirmed(rec);
    if (rec && (this.selected === rec.cross.local || this.selected === rec.cross.node || (this.selected && this.crossLog.get(this.selected)?.has(hash)))) {
      this.emit('account', this.selected!);
    }
  }

  /** Add an XRPL EVM address's neighborhood to the map. */
  addEvmNeighborhood(acc: EvmAccount, limit: number): number {
    const me = acc.id;
    const node = this.model.nodes.get(me) ?? this.model.ensure(me);
    const before = this.model.nodes.size;
    const fresh: string[] = [];
    const touch = (other: string) => {
      if (!this.model.nodes.has(other)) {
        this.model.ensure(other, node);
        fresh.push(other);
      }
    };
    const chosen = new Set(summarizeFlows(me, acc.events).counterparties.slice(0, limit).map((c) => c.address));
    for (const e of acc.events) this.addEventFlows(e, me, (o) => chosen.has(o) || chainOf(o) !== 'xrpl-evm' || this.model.nodes.has(o), touch);
    for (const id of fresh) this.prepareNode(id);
    return this.model.nodes.size - before;
  }

  /** Add one specific counterparty of an account (from the inspector list). */
  addCounterparty(me: string, other: string) {
    const d = this.accountData(me);
    const acc = this.evm.loaded.get(me);
    const node = this.model.nodes.get(me);
    if ((!d && !acc) || !node) return;
    if (!this.model.nodes.has(other)) {
      this.model.ensure(other, node);
      this.prepareNode(other);
    }
    for (const t of d?.txs ?? []) this.addTxFlows(t, me, (o) => o === other, () => {});
    for (const e of acc?.events ?? []) this.addEventFlows(e, me, (o) => o === other, () => {});
    this.view.refresh(true);
    this.emit('graph', undefined);
  }

  async loadMoreHistory(id: string) {
    const L = this.loaderFor(id);
    const d = L?.loaded.get(id);
    const acc = this.evm.loaded.get(id);
    if ((!L || !d) && !acc) return;
    try {
      const n = this.model.nodes.get(id);
      if (L && d) {
        const page = await L.moreTx(d);
        if (n?.expanded) for (const t of page) this.addTxFlows(t, id, (o) => this.model.nodes.has(o), () => {});
        this.checkCrossings(page.map((t) => this.recordOf(t, d.chain)));
      } else if (acc) {
        const page = await this.evm.more(acc);
        if (n?.expanded) for (const e of page) this.addEventFlows(e, id, (o) => this.model.nodes.has(o), () => {});
        this.checkCrossings(page.map((e) => this.recordOf(e, 'xrpl-evm')));
      }
      if (n?.expanded) this.view.refresh(true);
      this.emit('account', id);
      this.emit('graph', undefined);
    } catch (e) {
      this.toast(`Couldn't load older history: ${(e as Error).message}`, 'error');
    }
  }

  async openTx(hash: string) {
    try {
      const t = await this.loader.tx(hash);
      const anchor = this.model.nodes.get(t.account) ?? this.model.ensure(t.account);
      const fresh: string[] = [];
      this.addTxFlows(t, null, () => true, (id) => {
        if (!this.model.nodes.has(id)) {
          this.model.ensure(id, anchor);
          fresh.push(id);
        }
      });
      this.prepareNode(t.account);
      for (const id of fresh) this.prepareNode(id);
      const ids = new Set([t.account, ...t.flows.flatMap((f) => [f.from, f.to])]);
      const edges = new Set(t.flows.map((f) => `${f.type}:${[f.from, f.to].sort().join(':')}`));
      this.view.trail = { nodes: ids, edges };
      this.select(t.account);
      this.view.refresh(true);
      setTimeout(() => this.view.fit(ids), 700);
      this.emit('graph', undefined);
    } catch (e) {
      this.toast(`Couldn't find that transaction: ${(e as Error).message}`, 'error');
    }
  }

  /* ------------------------------ tracing ------------------------------ */

  private trailFor(t: Trace) {
    const nodes = new Set<string>([t.start]);
    const edges = new Set<string>();
    const type = t.kind === 'origin' ? 'activation' : 'payment';
    for (const s of t.steps) {
      nodes.add(s.parent);
      nodes.add(s.child);
      const [a, b] = [s.parent, s.child].sort();
      edges.add(`${s.edge ?? type}:${a}:${b}`);
    }
    return { nodes, edges };
  }

  showTrace(start: string) {
    const t = this.traces.get(start);
    if (!t) return;
    this.view.trail = this.trailFor(t);
    this.view.refresh(false);
    this.view.fit(this.view.trail.nodes);
  }

  clearTrail() {
    if (!this.view.trail) return;
    this.view.trail = null;
    this.view.refresh(false);
  }

  /** Follow "who created this account?" back until we reach someone known. */
  async traceOrigin(start: string, continueFrom?: string) {
    if (!this.loaderFor(start)) return;
    const existing = continueFrom ? this.traces.get(start) : undefined;
    const trace: Trace = existing ?? { kind: 'origin', start, steps: [], running: true };
    trace.running = true;
    trace.end = undefined;
    this.traces.set(start, trace);
    this.emit('trace', start);
    let cur = continueFrom ?? start;
    const seen = new Set<string>([start, ...trace.steps.map((s) => s.parent)]);
    try {
      for (let i = 0; i < 25; i++) {
        const L = this.loaderFor(cur);
        if (!L) break;
        const act = await L.activation(cur);
        if (!act.parent) {
          trace.end = act.unknown ?? 'none';
          break;
        }
        const parentNew = !this.model.nodes.has(act.parent);
        this.model.ensure(act.parent, this.model.nodes.get(cur));
        if (parentNew) this.prepareNode(act.parent);
        // Accounts imported onto Xahau trace back across networks, to the same address on the XRP Ledger.
        const edge: EdgeType = act.via === 'Import' ? 'crosschain' : 'activation';
        const key = `${act.hash}:${act.parent}:${cur}:${edge}`;
        this.model.addFlow(act.parent, cur, edge, act.amount, act.date ?? 0, key);
        if (edge === 'crosschain') this.model.confirm(act.parent, cur, key);
        trace.steps.push({ child: cur, parent: act.parent, date: act.date, amount: act.amount, hash: act.hash, edge });
        this.view.trail = this.trailFor(trace);
        this.view.refresh(true);
        this.emit('trace', start);
        if (seen.has(act.parent)) {
          trace.end = 'loop';
          break;
        }
        seen.add(act.parent);
        const ident = this.dir.get(act.parent);
        if (ident.known || ident.userLabel) {
          trace.end = 'known';
          break;
        }
        cur = act.parent;
        if (i === 24) trace.end = 'limit';
      }
    } catch {
      trace.end = 'error';
    }
    trace.running = false;
    this.emit('trace', start);
    this.emit('graph', undefined);
    setTimeout(() => this.showTrace(start), 400);
  }

  /** Repeatedly follow the biggest XRP sender in each account's recent history. */
  async traceFunding(start: string) {
    if (!this.loaderFor(start)) return;
    const trace: Trace = { kind: 'funding', start, steps: [], running: true };
    this.traces.set(`${start}:funding`, trace);
    this.emit('trace', start);
    let cur = start;
    const seen = new Set([start]);
    try {
      for (let i = 0; i < 8; i++) {
        const d = await this.loadAccount(cur);
        const sources = summarize(d).counterparties.filter((c) => c.xrpIn > 0 && !seen.has(c.address));
        const totalIn = sources.reduce((sum, c) => sum + c.xrpIn, 0);
        const top = sources.sort((a, b) => b.xrpIn - a.xrpIn)[0];
        // Dust (spam, memos) isn't a meaningful lead: require a real share of the inflow.
        if (!top || top.xrpIn < 1 || top.xrpIn < totalIn * 0.1) {
          trace.end = 'none';
          break;
        }
        const node = this.model.nodes.get(cur);
        if (!this.model.nodes.has(top.address)) {
          this.model.ensure(top.address, node);
          this.prepareNode(top.address);
        }
        for (const t of d.txs) this.addTxFlows(t, cur, (o) => o === top.address, () => {});
        trace.steps.push({ child: cur, parent: top.address, amount: { value: top.xrpIn, currency: 'XRP', isXrp: true } });
        const tr = this.trailFor(trace);
        // funding edges may be payments or activations; include both
        for (const s of trace.steps) {
          const [a, b] = [s.parent, s.child].sort();
          tr.edges.add(`activation:${a}:${b}`);
        }
        this.view.trail = tr;
        this.view.refresh(true);
        this.emit('trace', start);
        seen.add(top.address);
        const ident = this.dir.get(top.address);
        if (ident.known || ident.userLabel) {
          trace.end = 'known';
          break;
        }
        cur = top.address;
        if (i === 7) trace.end = 'limit';
      }
    } catch {
      trace.end = 'error';
    }
    trace.running = false;
    this.emit('trace', start);
    this.emit('graph', undefined);
    if (this.view.trail) setTimeout(() => this.view.fit(this.view.trail!.nodes), 400);
  }

  /* ------------------------------ graph ops ---------------------------- */

  hide(id: string) {
    const n = this.model.nodes.get(id);
    if (!n) return;
    n.hidden = true;
    if (this.selected === id) this.select(null);
    this.view.refresh(true);
    this.emit('graph', undefined);
  }

  unhideAll() {
    for (const n of this.model.nodes.values()) n.hidden = false;
    this.view.refresh(true);
    this.emit('graph', undefined);
  }

  hiddenCount() {
    let c = 0;
    for (const n of this.model.nodes.values()) if (n.hidden) c++;
    return c;
  }

  clearGraph() {
    this.model.clear();
    this.traces.clear();
    this.visited.length = 0;
    this.view.trail = null;
    this.select(null);
    this.view.refresh(false);
    this.emit('graph', undefined);
  }
}
