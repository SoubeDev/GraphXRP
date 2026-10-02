/**
 * "Who is who": combines public name directories, the account's own domain
 * claim (verified against the domain's xrp-ledger.toml), and your own labels.
 * Every claim keeps its source so the UI can show where a name came from.
 */
import { shortAddr } from '../xrpl/amount';
import { extLabel, isChainHub, isExternal } from '../bridges/registry';

export interface KnownEntry {
  name: string;
  desc?: string;
  account: string;
  domain?: string;
  twitter?: string;
  verified?: boolean;
}

export interface Claim {
  source: string;
  text: string;
  verified?: boolean;
  href?: string;
}

export type DomainCheck = 'checking' | 'confirmed' | 'unconfirmed' | 'unreachable';

export interface Identity {
  address: string;
  name?: string;
  tag?: string;
  claims: Claim[];
  domain?: string;
  domainCheck?: DomainCheck;
  twitter?: string;
  avatar?: string;
  advisory?: string;
  xamanBlocked?: boolean;
  kyc?: boolean;
  userLabel?: string;
  userNote?: string;
  light: 'none' | 'loading' | 'done';
  deep: 'none' | 'loading' | 'done';
  // raw source data
  known?: KnownEntry;
  scanName?: { name: string; desc?: string; domain?: string; twitter?: string; verified?: boolean };
  xamanAlias?: { text: string; href?: string };
  thirdParty: { alias: string; source: string }[];
  /** Name derived from ledger facts (e.g. an AMM pool's two assets). */
  derived?: { name: string; claim: string };
}

export interface SearchHit {
  address: string;
  name: string;
  tag?: string;
  domain?: string;
  verified?: boolean;
  source: 'directory' | 'label' | 'seen';
}

export const ADVISORY_TEXT: Record<string, string> = {
  SCAM: 'reported as a scam',
  HACK: 'linked to a hack or theft',
  SPAM: 'known for sending spam transactions',
  LEA: 'the subject of a law-enforcement advisory',
};

/** Special addresses nobody holds a key for; issuers "blackhole" themselves by pointing at these. */
const BLACKHOLE_NAMES: Record<string, string> = {
  rrrrrrrrrrrrrrrrrrrrrhoLvTp: 'Black hole (zero)',
  rrrrrrrrrrrrrrrrrrrrBZbvji: 'Black hole (one)',
  rrrrrrrrrrrrrrrrrrrn5RM1rHd: 'Black hole (NaN)',
};

const CACHE_KEY = 'gx.directory.v1';
const LABELS_KEY = 'gx.labels.v1';
const DAY = 86400000;

/** Directory aliases are user-supplied: drop URLs, metadata blobs and other junk. */
function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 48) return undefined;
  if (/^(https?:\/\/|www\.)/i.test(s) || /[{}[\]<>]/.test(s)) return undefined;
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return undefined;
  return s;
}

/** Concurrency limiter with a minimum gap between starts, to stay under API rate limits. */
class Pool {
  private active = 0;
  private q: (() => void)[] = [];
  private lastStart = 0;
  constructor(
    private size: number,
    private gap = 0,
  ) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        const wait = this.lastStart + this.gap - Date.now();
        if (wait > 0) {
          setTimeout(go, wait);
          return;
        }
        this.lastStart = Date.now();
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.q.shift()?.();
          });
      };
      if (this.active < this.size) go();
      else this.q.push(go);
    });
  }
}

async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url: string, ms = 8000): Promise<any> {
  const r = await fetchWithTimeout(url, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function readStore<T>(key: string): T | undefined {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: fine, it's only a cache */
  }
}

const SOURCE_LABELS: Record<string, string> = {
  'xumm.app': 'Xaman',
  'xaman.app': 'Xaman',
  'xrplexplorer.com': 'Bithomp (XRPL Explorer)',
  'bithomp.com': 'Bithomp',
  'xrpscan.com': 'XRPScan',
};

export class Directory {
  readonly known = new Map<string, KnownEntry>();
  readonly advisories = new Map<string, string>();
  directoryState: 'loading' | 'ready' | 'stale' | 'failed' = 'loading';

  private ids = new Map<string, Identity>();
  private labels: Record<string, { label?: string; note?: string }> = readStore(LABELS_KEY) ?? {};
  private listeners = new Set<(addr: string) => void>();
  private lightPool = new Pool(2, 250);
  private deepPool = new Pool(2, 400);
  private lightRetry = new Set<string>();
  private domainCache = new Map<string, Promise<Set<string> | 'missing' | 'unreachable'>>();
  private lightDisabledUntil = 0;

  onChange(fn: (addr: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(addr: string) {
    for (const fn of this.listeners) fn(addr);
  }

  async init(): Promise<void> {
    const cached = readStore<{ t: number; known: KnownEntry[]; adv: { account: string; type: string }[] }>(CACHE_KEY);
    if (cached) this.ingest(cached.known, cached.adv);
    if (cached && Date.now() - cached.t < DAY) {
      this.directoryState = 'ready';
      return;
    }
    try {
      const [known, adv] = await Promise.all([
        getJson('https://api.xrpscan.com/api/v1/names/well-known', 15000),
        getJson('https://api.xrpscan.com/api/v1/advisories', 15000).catch(() => cached?.adv ?? []),
      ]);
      if (Array.isArray(known)) {
        this.ingest(known, adv);
        writeStore(CACHE_KEY, { t: Date.now(), known, adv });
      }
      this.directoryState = 'ready';
    } catch {
      this.directoryState = cached ? 'stale' : 'failed';
    }
    for (const addr of this.ids.keys()) this.refresh(addr);
  }

  private nameCounts = new Map<string, number>();

  private ingest(known: KnownEntry[], adv: { account: string; type: string }[]) {
    for (const k of known) if (k?.account) this.known.set(k.account, k);
    this.nameCounts.clear();
    for (const k of this.known.values()) this.nameCounts.set(k.name, (this.nameCounts.get(k.name) ?? 0) + 1);
    for (const a of adv ?? []) if (a?.account) this.advisories.set(a.account, a.type);
  }

  /** Synchronous identity (directory + labels); network enrichment updates it later. */
  get(addr: string): Identity {
    let id = this.ids.get(addr);
    if (!id) {
      id = { address: addr, claims: [], light: 'none', deep: 'none', thirdParty: [] };
      this.ids.set(addr, id);
      this.recompute(id);
    }
    return id;
  }

  /** Short label for the graph. */
  label(addr: string): string {
    if (isExternal(addr)) return extLabel(addr);
    const id = this.get(addr);
    if (!id.name) return shortAddr(addr);
    const full = id.tag ? `${id.name} ${id.tag}` : id.name;
    return full.length > 28 ? `${full.slice(0, 27).trimEnd()}\u2026` : full;
  }

  private refresh(addr: string) {
    const id = this.ids.get(addr);
    if (!id) return;
    this.recompute(id);
    this.emit(addr);
  }

  private recompute(id: Identity) {
    const addr = id.address;
    if (isExternal(addr)) {
      // Addresses on other chains: no directories to ask yet (only the chain name, for chain hubs).
      id.name = isChainHub(addr) ? extLabel(addr) : undefined;
      id.claims = [];
      return;
    }
    id.known = this.known.get(addr);
    id.advisory = this.advisories.get(addr);
    const lab = this.labels[addr];
    id.userLabel = lab?.label || undefined;
    id.userNote = lab?.note || undefined;

    const k = id.known;
    const desc = k?.desc?.trim();
    id.tag = undefined;
    if (id.userLabel) id.name = id.userLabel;
    else if (BLACKHOLE_NAMES[addr]) id.name = BLACKHOLE_NAMES[addr];
    else if (k) {
      id.name = k.name;
      if (desc) id.tag = /^\d+$/.test(desc) ? `#${desc}` : desc.length <= 18 ? desc : undefined;
    } else if (id.scanName?.name) {
      id.name = id.scanName.name;
      const d = id.scanName.desc?.trim();
      if (d) id.tag = /^\d+$/.test(d) ? `#${d}` : d.length <= 18 ? d : undefined;
    } else if (id.derived) id.name = id.derived.name;
    else if (id.xamanAlias) id.name = id.xamanAlias.text;
    else if (id.thirdParty.length) id.name = id.thirdParty[0].alias;
    else id.name = undefined;

    id.twitter = k?.twitter ?? id.scanName?.twitter;

    const claims: Claim[] = [];
    if (id.userLabel) claims.push({ source: 'Your label', text: id.userLabel });
    if (k) {
      claims.push({
        source: 'XRPScan directory',
        text: desc ? `${k.name} (${/^\d+$/.test(desc) ? `wallet ${desc}` : desc})` : k.name,
        verified: !!k.verified,
        href: `https://xrpscan.com/account/${addr}`,
      });
    } else if (id.scanName?.name) {
      claims.push({ source: 'XRPScan', text: id.scanName.name, verified: !!id.scanName.verified, href: `https://xrpscan.com/account/${addr}` });
    }
    if (id.derived) claims.push({ source: 'XRP Ledger', text: id.derived.claim, verified: true });
    if (id.xamanAlias) claims.push({ source: 'Xaman profile', text: id.xamanAlias.text, href: id.xamanAlias.href });
    const seen = new Set(claims.map((c) => `${c.source}|${c.text}`));
    for (const t of id.thirdParty) {
      const source = SOURCE_LABELS[t.source] ?? t.source;
      const key = `${source}|${t.alias}`;
      if (!seen.has(key)) {
        seen.add(key);
        claims.push({ source, text: t.alias });
      }
    }
    if (id.kyc) claims.push({ source: 'Xaman', text: 'Owner passed identity verification (KYC) with Xaman', verified: true });
    id.claims = claims;
  }

  /** Cheap lookup (Xaman account meta, which also relays Bithomp names). */
  enrichLight(addr: string): void {
    if (isExternal(addr)) return;
    const id = this.get(addr);
    if (id.light !== 'none') return;
    if (Date.now() < this.lightDisabledUntil) {
      this.lightRetry.add(addr);
      return;
    }
    id.light = 'loading';
    this.lightPool
      .run(async () => {
        if (Date.now() < this.lightDisabledUntil) throw new Error('cooldown');
        return getJson(`https://xumm.app/api/v1/platform/account-meta/${addr}`, 8000);
      })
      .then((m) => {
        const p = m?.xummProfile;
        const alias = cleanName(p?.accountAlias) ?? cleanName(p?.ownerAlias);
        if (alias) id.xamanAlias = { text: alias, href: p.profileUrl || undefined };
        id.thirdParty = (m?.thirdPartyProfiles ?? [])
          .map((t: any) => ({ alias: cleanName(t?.accountAlias), source: String(t?.source ?? '') }))
          // "xrpl" just echoes the on-ledger Domain field, which we show (and verify) separately.
          .filter((t: { alias?: string; source: string }) => !!t.alias && t.source !== 'xrpl');
        id.kyc = !!m?.kycApproved;
        id.xamanBlocked = !!m?.blocked;
        if (m?.avatar && m?.avatar_type === 'custom') id.avatar = m.avatar;
        id.light = 'done';
      })
      .catch((e) => {
        const msg = String(e);
        if (msg.includes('429') || msg.includes('cooldown')) {
          // Rate limited: back off, then quietly retry everything that was skipped.
          id.light = 'none';
          this.lightRetry.add(addr);
          if (Date.now() >= this.lightDisabledUntil) {
            this.lightDisabledUntil = Date.now() + 30000;
            setTimeout(() => {
              const list = [...this.lightRetry];
              this.lightRetry.clear();
              for (const a of list) this.enrichLight(a);
            }, 30500);
          }
        } else id.light = 'done';
      })
      .finally(() => this.refresh(addr));
  }

  /** Detailed lookup (XRPScan account record), used for the account you are inspecting. */
  enrichDeep(addr: string): Promise<{ parent?: string; inception?: number }> {
    if (isExternal(addr)) return Promise.resolve({});
    const id = this.get(addr);
    this.enrichLight(addr);
    if (id.deep !== 'none') return Promise.resolve({});
    id.deep = 'loading';
    return this.deepPool
      .run(() => getJson(`https://api.xrpscan.com/api/v1/account/${addr}`, 10000))
      .then((r) => {
        if (cleanName(r?.accountName?.name)) id.scanName = { ...r.accountName, name: cleanName(r.accountName.name)! };
        if (r?.advisory && typeof r.advisory === 'object' && r.advisory.type) this.advisories.set(addr, r.advisory.type);
        if (r?.parentName?.name && r.parent && !this.known.has(r.parent)) {
          const pid = this.get(r.parent);
          pid.scanName ??= r.parentName;
          this.refresh(r.parent);
        }
        return { parent: r?.parent, inception: r?.inception ? Date.parse(r.inception) : undefined };
      })
      .catch(() => ({}))
      .finally(() => {
        id.deep = 'done';
        this.refresh(addr);
      });
  }

  /**
   * Two-way domain verification: the account claims a domain on-ledger, and the
   * domain lists the account in https://<domain>/.well-known/xrp-ledger.toml.
   */
  checkDomain(addr: string, domain: string | undefined) {
    const id = this.get(addr);
    id.domain = domain;
    if (!domain) {
      id.domainCheck = undefined;
      return;
    }
    if (id.domainCheck && id.domainCheck !== 'checking') return;
    id.domainCheck = 'checking';
    let p = this.domainCache.get(domain);
    if (!p) {
      p = fetchWithTimeout(`https://${domain}/.well-known/xrp-ledger.toml`, 7000)
        .then(async (r) => {
          if (!r.ok) return 'missing' as const;
          const text = await r.text();
          if (/^\s*</.test(text)) return 'missing' as const; // an HTML page, not a TOML file
          const found = new Set<string>();
          for (const m of text.matchAll(/address\s*=\s*["'](r[1-9A-HJ-NP-Za-km-z]{24,34})["']/g)) found.add(m[1]);
          return found;
        })
        .catch(() => 'unreachable' as const);
      this.domainCache.set(domain, p);
    }
    p.then((res) => {
      id.domainCheck = res === 'unreachable' ? 'unreachable' : res !== 'missing' && res.has(addr) ? 'confirmed' : 'unconfirmed';
      this.refresh(addr);
    });
  }

  setDerived(addr: string, name: string, claim: string) {
    const id = this.get(addr);
    if (id.derived?.name === name) return;
    id.derived = { name, claim };
    this.refresh(addr);
  }

  setLabel(addr: string, label: string, note?: string) {
    const l = label.trim();
    const n = note?.trim();
    if (!l && !n) delete this.labels[addr];
    else this.labels[addr] = { label: l || undefined, note: n || undefined };
    writeStore(LABELS_KEY, this.labels);
    this.refresh(addr);
  }

  search(q: string, limit = 8): SearchHit[] {
    const query = q.trim().toLowerCase();
    if (query.length < 2) return [];
    const hits: { hit: SearchHit; score: number }[] = [];
    const scoreText = (text: string | undefined, w: number) => {
      if (!text) return 0;
      const t = text.toLowerCase();
      if (t === query) return 4 * w;
      if (t.startsWith(query)) return 3 * w;
      if (t.split(/[\s._-]+/).some((p) => p.startsWith(query))) return 2 * w;
      return t.includes(query) ? 1 * w : 0;
    };
    for (const [addr, l] of Object.entries(this.labels)) {
      const s = Math.max(scoreText(l.label, 1.5), scoreText(l.note, 0.8));
      if (s) hits.push({ hit: { address: addr, name: l.label || shortAddr(addr), source: 'label' }, score: s + 2 });
    }
    for (const k of this.known.values()) {
      const s = Math.max(scoreText(k.name, 1), scoreText(`${k.name} ${k.desc ?? ''}`, 1), scoreText(k.domain, 0.9), scoreText(k.twitter, 0.6));
      if (s) {
        const descNum = /^\d+$/.test(k.desc ?? '') ? Number(k.desc) : 0;
        const tag = k.desc ? (/^\d+$/.test(k.desc) ? `#${k.desc}` : k.desc) : undefined;
        hits.push({
          hit: { address: k.account, name: k.name, tag, domain: k.domain, verified: k.verified, source: 'directory' },
          // Organizations with many known wallets are usually what people mean.
          score: s + (k.verified ? 0.5 : 0) + Math.min(0.6, Math.log10(this.nameCounts.get(k.name) ?? 1) * 0.5) - Math.min(descNum, 50) / 100,
        });
      }
    }
    for (const id of this.ids.values()) {
      if (id.known || id.userLabel || !id.name || isExternal(id.address)) continue;
      const s = scoreText(id.name, 0.9);
      if (s) hits.push({ hit: { address: id.address, name: id.name, tag: id.tag, source: 'seen' }, score: s });
    }
    hits.sort((a, b) => b.score - a.score);
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      if (seen.has(h.hit.address)) continue;
      seen.add(h.hit.address);
      out.push(h.hit);
      if (out.length >= limit) break;
    }
    return out;
  }
}
