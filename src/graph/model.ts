/** The graph: accounts as nodes, aggregated relationships as edges. */
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { EdgeType } from '../xrpl/parse';
import type { Amt } from '../xrpl/amount';

export type NodeKind = 'issuer' | 'exchange' | 'amm' | 'bridge' | 'wallet' | 'external' | 'flagged' | 'inactive';

export interface GNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
  named: boolean;
  state: 'stub' | 'loading' | 'loaded' | 'error';
  expanded: boolean;
  pinned: boolean;
  hidden: boolean;
  degree: number;
  r: number;
  label: string;
  balance?: number;
  born: number;
  alpha: number;
}

/** One direction of an edge. */
export interface Leg {
  count: number;
  totals: Map<string, Amt>;
  last: number;
}

export interface GEdge extends SimulationLinkDatum<GNode> {
  id: string;
  type: EdgeType;
  /** Endpoints in sorted order; `ab` is the a→b direction. */
  a: string;
  b: string;
  ab: Leg;
  ba: Leg;
  seen: Set<string>;
  role?: string;
  curve: number;
  born: number;
  alpha: number;
  source: GNode;
  target: GNode;
}

const newLeg = (): Leg => ({ count: 0, totals: new Map(), last: 0 });
const amtKey = (a: Amt) => (a.isXrp ? 'XRP' : `${a.currency}|${a.issuer ?? ''}`);

export class GraphModel {
  readonly nodes = new Map<string, GNode>();
  readonly edges = new Map<string, GEdge>();
  private adj = new Map<string, Set<GEdge>>();
  /** Bumped whenever nodes or edges are added/removed. */
  version = 0;

  ensure(id: string, near?: GNode): GNode {
    let n = this.nodes.get(id);
    if (n) return n;
    const angle = Math.random() * Math.PI * 2;
    const dist = near ? 30 + Math.random() * 50 : Math.random() * 40;
    n = {
      id,
      kind: 'wallet',
      named: false,
      state: 'stub',
      expanded: false,
      pinned: false,
      hidden: false,
      degree: 0,
      r: 5,
      label: id,
      born: performance.now(),
      alpha: 1,
      x: (near?.x ?? 0) + Math.cos(angle) * dist,
      y: (near?.y ?? 0) + Math.sin(angle) * dist,
      vx: 0,
      vy: 0,
    };
    this.nodes.set(id, n);
    this.adj.set(id, new Set());
    this.version++;
    return n;
  }

  private edge(x: string, y: string, type: EdgeType): GEdge {
    const [a, b] = x < y ? [x, y] : [y, x];
    const id = `${type}:${a}:${b}`;
    let e = this.edges.get(id);
    if (e) return e;
    const na = this.ensure(a);
    const nb = this.ensure(b);
    e = { id, type, a, b, ab: newLeg(), ba: newLeg(), seen: new Set(), curve: 0, born: performance.now(), alpha: 1, source: na, target: nb };
    this.edges.set(id, e);
    this.adj.get(a)!.add(e);
    this.adj.get(b)!.add(e);
    this.version++;
    return e;
  }

  /** Record one transfer/interaction. `key` de-duplicates the same tx seen from both sides. */
  addFlow(from: string, to: string, type: EdgeType, amount: Amt | null | undefined, date: number, key: string): GEdge {
    const e = this.edge(from, to, type);
    if (e.seen.has(key)) return e;
    e.seen.add(key);
    const leg = from === e.a ? e.ab : e.ba;
    leg.count++;
    leg.last = Math.max(leg.last, date);
    if (amount && Number.isFinite(amount.value)) {
      const k = amtKey(amount);
      const cur = leg.totals.get(k);
      if (cur) cur.value += amount.value;
      else leg.totals.set(k, { ...amount });
    }
    return e;
  }

  /** Current trust-line state (holder → issuer). Replaces, doesn't accumulate. */
  setTrust(holder: string, issuer: string, currency: string, balance: number): GEdge {
    const e = this.edge(holder, issuer, 'trust');
    const leg = holder === e.a ? e.ab : e.ba;
    const amount: Amt = { value: balance, currency, issuer, isXrp: false };
    leg.totals.set(amtKey(amount), amount);
    leg.count = leg.totals.size;
    return e;
  }

  setControl(controller: string, account: string, role: string): GEdge {
    const e = this.edge(controller, account, 'control');
    const leg = controller === e.a ? e.ab : e.ba;
    leg.count = 1;
    e.role = role;
    return e;
  }

  edgesOf(id: string): Iterable<GEdge> {
    return this.adj.get(id) ?? [];
  }

  neighbors(id: string): string[] {
    const out = new Set<string>();
    for (const e of this.edgesOf(id)) out.add(e.a === id ? e.b : e.a);
    return [...out];
  }

  remove(id: string) {
    for (const e of [...this.edgesOf(id)]) {
      this.edges.delete(e.id);
      this.adj.get(e.a)?.delete(e);
      this.adj.get(e.b)?.delete(e);
    }
    this.adj.delete(id);
    this.nodes.delete(id);
    this.version++;
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.adj.clear();
    this.version++;
  }
}

/** Direction-aware helpers for UI text. */
export function legFrom(e: GEdge, from: string): Leg {
  return from === e.a ? e.ab : e.ba;
}
