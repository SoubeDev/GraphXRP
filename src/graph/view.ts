/**
 * Canvas renderer + force simulation + pointer interaction, in the spirit of
 * Obsidian's graph view: hover to light up a neighborhood, drag nodes around,
 * scroll to zoom, labels fade in as you get closer.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type ForceLink, type ForceManyBody, type Simulation } from 'd3-force';
import type { GEdge, GNode, GraphModel, NodeKind } from './model';
import type { EdgeType } from '../xrpl/parse';
import type { Settings } from '../settings';

export interface Palette {
  bg: string;
  text: string;
  textMuted: string;
  accent: string;
  ring: string;
  edgeAlpha: number;
  kind: Record<NodeKind, string>;
  edge: Record<EdgeType, string>;
}

export interface ViewHooks {
  select(id: string | null): void;
  expand(id: string): void;
  context(id: string | null, clientX: number, clientY: number): void;
  hover(target: { node?: GNode; edge?: GEdge } | null, clientX: number, clientY: number): void;
}

export const EDGE_DASH: Record<EdgeType, number[]> = {
  payment: [],
  activation: [],
  trust: [1.5, 3],
  dex: [5, 4],
  control: [7, 3, 2, 3],
  crosschain: [9, 4],
};

const FLOW_TYPES = new Set<EdgeType>(['payment', 'activation', 'crosschain']);

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function edgeCurrencies(e: GEdge): Set<string> {
  const out = new Set<string>();
  for (const leg of [e.ab, e.ba]) for (const a of leg.totals.values()) out.add(a.currency);
  return out;
}

export class GraphView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  cam = { x: 0, y: 0, k: 1 };
  /** Pixels on the right covered by the inspector; camera centers in the remaining space. */
  insetRight = 0;
  /** Pixels at the bottom covered by the inspector's bottom sheet on phones. */
  insetBottom = 0;

  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private vadj = new Map<string, GEdge[]>();
  selected: string | null = null;
  trail: { nodes: Set<string>; edges: Set<string> } | null = null;
  matches: Set<string> | null = null;

  private hoverNode: GNode | null = null;
  private hoverEdge: GEdge | null = null;
  private focus: Set<string> | null = null;
  private sim: Simulation<GNode, GEdge>;
  private link: ForceLink<GNode, GEdge>;
  private charge: ForceManyBody<GNode>;
  private camAnim: { from: { cx: number; cy: number; k: number }; to: { cx: number; cy: number; k: number }; t0: number; dur: number } | null = null;
  private dirty = true;
  private animating = false;
  private lastVersion = -1;
  private drag: { node: GNode | null; sx: number; sy: number; camX: number; camY: number; moved: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; k: number; cx: number; cy: number } | null = null;

  constructor(
    private container: HTMLElement,
    private model: GraphModel,
    private settings: Settings,
    public palette: Palette,
    private hooks: ViewHooks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph-canvas';
    this.canvas.setAttribute('aria-label', 'Interactive graph of XRP Ledger accounts');
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.link = forceLink<GNode, GEdge>().id((n) => n.id);
    this.charge = forceManyBody<GNode>().theta(0.9).distanceMax(900);
    this.sim = forceSimulation<GNode, GEdge>([])
      .force('link', this.link)
      .force('charge', this.charge)
      .force('x', forceX<GNode>(0))
      .force('y', forceY<GNode>(0))
      .force('collide', forceCollide<GNode>((n) => n.r + 3).strength(0.7))
      .alphaDecay(0.022)
      .velocityDecay(0.38)
      .stop();
    this.applyForces();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindPointer();
    requestAnimationFrame(this.frame);
  }

  /* ------------------------------ layout ------------------------------ */

  private resize() {
    const r = this.container.getBoundingClientRect();
    const first = this.w === 0;
    this.w = r.width;
    this.h = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    if (first) {
      this.cam.x = r.width / 2;
      this.cam.y = r.height / 2;
    }
    this.dirty = true;
  }

  applyForces() {
    const s = this.settings;
    this.link
      .distance((e) => s.linkDistance * (e.type === 'trust' ? 1.2 : 1) + e.source.r + e.target.r)
      .strength((e) => s.linkForce / Math.max(1, Math.min(e.source.degree, e.target.degree)));
    this.charge.strength((n) => -s.repelForce * 22 * (0.7 + n.r / 14));
    (this.sim.force('x') as ReturnType<typeof forceX<GNode>>).strength(s.centerForce * 0.08);
    (this.sim.force('y') as ReturnType<typeof forceY<GNode>>).strength(s.centerForce * 0.08);
  }

  reheat(alpha = 0.6) {
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
    this.dirty = true;
  }

  /** Recompute which nodes/edges are visible from settings and model. */
  refresh(reheat = false) {
    const s = this.settings;
    const sel = this.selected;
    const inTrail = (id: string) => !!this.trail?.nodes.has(id);
    const candidates = new Map<string, GNode>();
    for (const n of this.model.nodes.values()) {
      const forced = n.id === sel || inTrail(n.id);
      if (n.hidden && !forced) continue;
      if (!s.kinds[n.kind] && !forced) continue;
      if (!s.showStubs && n.state === 'stub' && !forced) continue;
      candidates.set(n.id, n);
    }
    const deg = new Map<string, number>();
    const edges: GEdge[] = [];
    const cur = s.currency;
    for (const e of this.model.edges.values()) {
      const forced = !!this.trail?.edges.has(e.id);
      if (!forced && !s.edgeTypes[e.type]) continue;
      if (!candidates.has(e.a) || !candidates.has(e.b)) continue;
      if (cur && !forced && !edgeCurrencies(e).has(cur)) continue;
      edges.push(e);
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    const nodes: GNode[] = [];
    for (const n of candidates.values()) {
      const d = deg.get(n.id) ?? 0;
      if (d === 0 && !s.showOrphans && !n.expanded && !n.pinned && n.id !== sel && !inTrail(n.id)) continue;
      n.degree = d;
      const bal = n.balance ? Math.max(0, Math.log10(n.balance + 1) - 2) * 0.55 : 0;
      n.r = Math.min(3.5 + Math.sqrt(d) * 1.15 + bal, 20) * s.nodeSize;
      nodes.push(n);
    }

    // Curve parallel edges between the same pair so they don't overlap.
    const pairs = new Map<string, GEdge[]>();
    this.vadj.clear();
    for (const e of edges) {
      const k = `${e.a}|${e.b}`;
      (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(e);
      (this.vadj.get(e.a) ?? this.vadj.set(e.a, []).get(e.a)!).push(e);
      (this.vadj.get(e.b) ?? this.vadj.set(e.b, []).get(e.b)!).push(e);
    }
    for (const list of pairs.values()) list.forEach((e, i) => (e.curve = (i - (list.length - 1) / 2) * 26));

    this.nodes = nodes;
    this.edges = edges;
    this.sim.nodes(nodes);
    this.link.links(edges);
    this.applyForces();
    if (reheat) this.reheat(0.5);
    if (this.hoverNode && !candidates.has(this.hoverNode.id)) this.setHover(null, null);
    this.updateFocus();
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  isVisible(id: string) {
    return this.nodes.some((n) => n.id === id);
  }

  /* ------------------------------ camera ------------------------------ */

  private center() {
    return { cx: (this.w - this.insetRight) / 2, cy: (this.h - this.insetBottom) / 2 };
  }

  flyTo(wx: number, wy: number, k = this.cam.k, dur = 650) {
    const { cx, cy } = this.center();
    const from = { cx: (cx - this.cam.x) / this.cam.k, cy: (cy - this.cam.y) / this.cam.k, k: this.cam.k };
    this.camAnim = { from, to: { cx: wx, cy: wy, k: Math.max(0.05, Math.min(6, k)) }, t0: performance.now(), dur };
    this.dirty = true;
  }

  focusNode(id: string, k?: number) {
    const n = this.model.nodes.get(id);
    if (n) this.flyTo(n.x ?? 0, n.y ?? 0, k ?? Math.max(this.cam.k, 1.1));
  }

  fit(ids?: Iterable<string>, pad = 90) {
    const list = ids ? [...ids].map((id) => this.model.nodes.get(id)).filter((n): n is GNode => !!n) : this.nodes;
    if (!list.length) return;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const n of list) {
      x0 = Math.min(x0, n.x! - n.r);
      y0 = Math.min(y0, n.y! - n.r);
      x1 = Math.max(x1, n.x! + n.r);
      y1 = Math.max(y1, n.y! + n.r);
    }
    const vw = Math.max(100, this.w - this.insetRight - pad * 2);
    const vh = Math.max(100, this.h - this.insetBottom - pad * 2);
    const k = Math.min(vw / Math.max(1, x1 - x0), vh / Math.max(1, y1 - y0), 2.2);
    this.flyTo((x0 + x1) / 2, (y0 + y1) / 2, k);
  }

  zoomBy(f: number) {
    const { cx, cy } = this.center();
    const wx = (cx - this.cam.x) / this.cam.k;
    const wy = (cy - this.cam.y) / this.cam.k;
    this.flyTo(wx, wy, this.cam.k * f, 300);
  }

  private zoomAt(f: number, sx: number, sy: number) {
    const k = Math.max(0.05, Math.min(6, this.cam.k * f));
    const wx = (sx - this.cam.x) / this.cam.k;
    const wy = (sy - this.cam.y) / this.cam.k;
    this.cam.k = k;
    this.cam.x = sx - wx * k;
    this.cam.y = sy - wy * k;
    this.camAnim = null;
    this.dirty = true;
  }

  toScreen(n: GNode) {
    return { x: n.x! * this.cam.k + this.cam.x, y: n.y! * this.cam.k + this.cam.y };
  }

  /* ---------------------------- interaction --------------------------- */

  private nodeAt(sx: number, sy: number): GNode | null {
    const wx = (sx - this.cam.x) / this.cam.k;
    const wy = (sy - this.cam.y) / this.cam.k;
    const tol = 4 / this.cam.k;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.x! - wx;
      const dy = n.y! - wy;
      const rr = n.r + tol;
      if (dx * dx + dy * dy <= rr * rr) return n;
    }
    return null;
  }

  private edgeAt(sx: number, sy: number): GEdge | null {
    const wx = (sx - this.cam.x) / this.cam.k;
    const wy = (sy - this.cam.y) / this.cam.k;
    const tol = 5 / this.cam.k;
    let best: GEdge | null = null;
    let bestD = tol;
    for (const e of this.edges) {
      const ax = e.source.x!,
        ay = e.source.y!,
        bx = e.target.x!,
        by = e.target.y!;
      const pad = Math.abs(e.curve) + tol;
      if (wx < Math.min(ax, bx) - pad || wx > Math.max(ax, bx) + pad || wy < Math.min(ay, by) - pad || wy > Math.max(ay, by) + pad) continue;
      const c = this.ctrl(e);
      let px = ax,
        py = ay;
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        const qx = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * c.x + t * t * bx;
        const qy = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * c.y + t * t * by;
        const d = segDist(wx, wy, px, py, qx, qy);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
        px = qx;
        py = qy;
      }
    }
    return best;
  }

  private setHover(node: GNode | null, edge: GEdge | null) {
    if (node === this.hoverNode && edge === this.hoverEdge) return;
    this.hoverNode = node;
    this.hoverEdge = edge;
    this.canvas.style.cursor = node ? 'pointer' : edge ? 'help' : 'default';
    this.updateFocus();
    this.dirty = true;
  }

  private updateFocus() {
    const n = this.hoverNode;
    if (!n) {
      this.focus = null;
      return;
    }
    const f = new Set<string>([n.id]);
    for (const e of this.vadj.get(n.id) ?? []) f.add(e.a === n.id ? e.b : e.a);
    this.focus = f;
  }

  private bindPointer() {
    const c = this.canvas;
    const pos = (ev: PointerEvent | MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };

    c.addEventListener('pointerdown', (ev) => {
      const p = pos(ev);
      this.pointers.set(ev.pointerId, p);
      c.setPointerCapture(ev.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.cam.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        if (this.drag?.node && !this.drag.node.pinned) this.drag.node.fx = this.drag.node.fy = null;
        this.drag = null;
        return;
      }
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const n = this.nodeAt(p.x, p.y);
      this.drag = { node: n, sx: p.x, sy: p.y, camX: this.cam.x, camY: this.cam.y, moved: false };
      this.camAnim = null;
    });

    c.addEventListener('pointermove', (ev) => {
      const p = pos(ev);
      if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        this.zoomAt((this.pinch.k * (d / this.pinch.d)) / this.cam.k, cx, cy);
        this.cam.x += cx - this.pinch.cx;
        this.cam.y += cy - this.pinch.cy;
        this.pinch.cx = cx;
        this.pinch.cy = cy;
        return;
      }
      const d = this.drag;
      if (d) {
        const dx = p.x - d.sx;
        const dy = p.y - d.sy;
        if (!d.moved && Math.hypot(dx, dy) > 4) {
          d.moved = true;
          if (d.node) {
            this.sim.alphaTarget(0.25);
            this.reheat(0.3);
            this.hooks.hover(null, 0, 0);
          }
        }
        if (d.moved) {
          if (d.node) {
            d.node.fx = (p.x - this.cam.x) / this.cam.k;
            d.node.fy = (p.y - this.cam.y) / this.cam.k;
          } else {
            this.cam.x = d.camX + dx;
            this.cam.y = d.camY + dy;
          }
          this.dirty = true;
        }
        return;
      }
      const n = this.nodeAt(p.x, p.y);
      const e = n ? null : this.edgeAt(p.x, p.y);
      this.setHover(n, e);
      this.hooks.hover(n ? { node: n } : e ? { edge: e } : null, ev.clientX, ev.clientY);
    });

    const end = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.node) {
        if (d.moved) {
          this.sim.alphaTarget(0);
          if (!d.node.pinned) d.node.fx = d.node.fy = null;
        } else {
          this.hooks.select(d.node.id);
        }
      } else if (!d.moved && ev.type === 'pointerup') {
        this.hooks.select(null);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.setHover(null, null);
        this.hooks.hover(null, 0, 0);
      }
    });

    c.addEventListener('dblclick', (ev) => {
      const p = pos(ev);
      const n = this.nodeAt(p.x, p.y);
      if (n) this.hooks.expand(n.id);
      else {
        const wx = (p.x - this.cam.x) / this.cam.k;
        const wy = (p.y - this.cam.y) / this.cam.k;
        this.flyTo(wx, wy, this.cam.k * 1.8, 350);
      }
    });

    c.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.hooks.hover(null, 0, 0);
      const p = pos(ev);
      const n = this.nodeAt(p.x, p.y);
      this.hooks.context(n?.id ?? null, ev.clientX, ev.clientY);
    });

    c.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const p = pos(ev);
        const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
        const f = Math.exp(-ev.deltaY * unit * (ev.ctrlKey ? 0.012 : 0.0016));
        this.zoomAt(f, p.x, p.y);
      },
      { passive: false },
    );
  }

  /** Light up a node's neighborhood from outside the canvas (e.g. hovering a name in the inspector). */
  peek(id: string | null) {
    const n = id ? this.nodes.find((x) => x.id === id) ?? null : null;
    this.setHover(n, null);
  }

  togglePin(id: string) {
    const n = this.model.nodes.get(id);
    if (!n) return;
    n.pinned = !n.pinned;
    n.fx = n.pinned ? n.x : null;
    n.fy = n.pinned ? n.y : null;
    this.dirty = true;
  }

  /* ------------------------------- render ------------------------------ */

  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    if (this.model.version !== this.lastVersion) {
      this.lastVersion = this.model.version;
      this.refresh(true);
    }
    let active = false;
    if (this.camAnim) {
      const a = this.camAnim;
      const t = Math.min(1, (now - a.t0) / a.dur);
      const e = easeInOut(t);
      const k = Math.exp(Math.log(a.from.k) + (Math.log(a.to.k) - Math.log(a.from.k)) * e);
      const wx = a.from.cx + (a.to.cx - a.from.cx) * e;
      const wy = a.from.cy + (a.to.cy - a.from.cy) * e;
      const { cx, cy } = this.center();
      this.cam.k = k;
      this.cam.x = cx - wx * k;
      this.cam.y = cy - wy * k;
      if (t >= 1) this.camAnim = null;
      active = true;
    }
    if (this.sim.alpha() > this.sim.alphaMin()) {
      this.sim.tick();
      active = true;
    }
    const particles = this.settings.particles && this.edges.some((e) => FLOW_TYPES.has(e.type)) && this.cam.k > 0.25;
    if (active || this.dirty || this.animating || particles || this.trail) {
      this.animating = this.draw(now);
      this.dirty = false;
    }
  };

  private ctrl(e: GEdge) {
    const ax = e.source.x!,
      ay = e.source.y!,
      bx = e.target.x!,
      by = e.target.y!;
    if (!e.curve) return { x: (ax + bx) / 2, y: (ay + by) / 2 };
    const dx = bx - ax,
      dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (ax + bx) / 2 - (dy / len) * e.curve, y: (ay + by) / 2 + (dx / len) * e.curve };
  }

  private nodeTarget(n: GNode): number {
    if (this.focus) return this.focus.has(n.id) ? 1 : 0.1;
    if (this.trail) return this.trail.nodes.has(n.id) ? 1 : 0.3;
    if (this.matches) return this.matches.has(n.id) ? 1 : 0.15;
    return 1;
  }

  private draw(now: number): boolean {
    const { ctx, dpr, cam, palette: P, settings: s } = this;
    const k = cam.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * cam.x, dpr * cam.y);

    let animating = false;
    for (const n of this.nodes) {
      const target = this.nodeTarget(n);
      n.alpha += (target - n.alpha) * 0.2;
      if (Math.abs(target - n.alpha) > 0.005) animating = true;
      else n.alpha = target;
    }

    // Viewport bounds in world space for culling.
    const vx0 = -cam.x / k - 50,
      vy0 = -cam.y / k - 50,
      vx1 = (this.w - cam.x) / k + 50,
      vy1 = (this.h - cam.y) / k + 50;
    const onScreen = (n: GNode) => n.x! + n.r > vx0 && n.x! - n.r < vx1 && n.y! + n.r > vy0 && n.y! - n.r < vy1;

    const hoverId = this.hoverNode?.id;
    const sel = this.selected;
    const t = now / 1000;

    /* edges */
    ctx.lineCap = 'round';
    const particleEdges: { e: GEdge; a: number; lw: number; trail: boolean }[] = [];
    for (const e of this.edges) {
      const sN = e.source,
        tN = e.target;
      if (!onScreen(sN) && !onScreen(tN)) {
        const minx = Math.min(sN.x!, tN.x!),
          maxx = Math.max(sN.x!, tN.x!),
          miny = Math.min(sN.y!, tN.y!),
          maxy = Math.max(sN.y!, tN.y!);
        if (maxx < vx0 || minx > vx1 || maxy < vy0 || miny > vy1) continue;
      }
      const touchesHover = hoverId && (e.a === hoverId || e.b === hoverId);
      const touchesSel = sel && (e.a === sel || e.b === sel);
      const inTrail = this.trail?.edges.has(e.id);
      let a: number;
      if (this.focus) a = touchesHover ? 0.95 : 0.035;
      else if (this.trail) a = inTrail ? 1 : P.edgeAlpha * 0.35;
      else if (this.matches) a = this.matches.has(e.a) && this.matches.has(e.b) ? P.edgeAlpha * 1.5 : P.edgeAlpha * 0.25;
      else a = touchesSel ? Math.min(1, P.edgeAlpha * 2.2) : P.edgeAlpha;
      a *= Math.min(1, (now - e.born) / 500);
      if (a < 0.01) continue;
      const count = e.ab.count + e.ba.count;
      const baseLw = Math.max((0.7 + Math.log10(1 + count) * 0.9) * s.linkWidth, 0.6 / k);
      const lw = inTrail ? baseLw + 1.5 / k : baseLw;

      const c = this.ctrl(e);
      ctx.globalAlpha = a;
      ctx.strokeStyle = inTrail ? P.accent : P.edge[e.type];
      ctx.lineWidth = lw;
      const dash = EDGE_DASH[e.type];
      if (inTrail) {
        ctx.setLineDash([6 / k, 4 / k]);
        ctx.lineDashOffset = -t * 28 / k;
      } else ctx.setLineDash(dash.length ? dash.map((d) => (d * Math.max(lw, 1)) / Math.min(1, k * 1.5)) : []);
      ctx.beginPath();
      ctx.moveTo(sN.x!, sN.y!);
      if (e.curve) ctx.quadraticCurveTo(c.x, c.y, tN.x!, tN.y!);
      else ctx.lineTo(tN.x!, tN.y!);
      ctx.stroke();

      // arrowheads: show which way value/trust/control points
      if (s.arrows && k > 0.3 && e.type !== 'dex') {
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        const size = Math.max(3.2, baseLw * 2.6);
        if (e.ab.count) this.arrow(c, tN, size);
        if (e.ba.count) this.arrow(c, sN, size);
      }
      if (s.particles && FLOW_TYPES.has(e.type) && k > 0.25 && a > 0.12) particleEdges.push({ e, a, lw: baseLw, trail: !!inTrail });
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    /* flow particles: little dots travelling the direction money moved */
    if (particleEdges.length) {
      const budget = particleEdges.length > 900 && !this.focus;
      for (const { e, a, lw, trail } of particleEdges) {
        if (budget && !(sel && (e.a === sel || e.b === sel))) continue;
        const c = this.ctrl(e);
        const len = Math.hypot(e.target.x! - e.source.x!, e.target.y! - e.source.y!);
        const period = Math.max(1.4, Math.min(6, len / 55));
        ctx.fillStyle = trail ? P.accent : P.edge[e.type];
        ctx.globalAlpha = Math.min(1, a * 1.8);
        const rad = Math.max(lw * 1.25, 1.3 / k);
        for (const [leg, forward] of [
          [e.ab, true],
          [e.ba, false],
        ] as const) {
          if (!leg.count) continue;
          const n = Math.min(4, 1 + Math.floor(Math.log2(leg.count)));
          for (let i = 0; i < n; i++) {
            let u = (t / period + i / n + (forward ? 0 : 0.5 / n)) % 1;
            if (!forward) u = 1 - u;
            const x = (1 - u) * (1 - u) * e.source.x! + 2 * (1 - u) * u * c.x + u * u * e.target.x!;
            const y = (1 - u) * (1 - u) * e.source.y! + 2 * (1 - u) * u * c.y + u * u * e.target.y!;
            ctx.beginPath();
            ctx.arc(x, y, rad, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    /* nodes */
    const order = this.nodes.slice();
    order.sort((x, y) => rank(x) - rank(y));
    function rank(n: GNode) {
      return (n.id === sel ? 3 : 0) + (n.id === hoverId ? 4 : 0) + (n.alpha > 0.5 ? 1 : 0);
    }
    for (const n of order) {
      if (!onScreen(n)) continue;
      const grow = Math.min(1, (now - n.born) / 350);
      if (grow < 1) animating = true;
      const r = n.r * (0.4 + 0.6 * easeInOut(grow));
      const x = n.x!,
        y = n.y!;
      const color = P.kind[n.kind];
      ctx.globalAlpha = n.alpha;

      // backing disc keeps lines from showing through translucent nodes
      const hollow = n.kind === 'inactive' || n.kind === 'external';
      if (n.state === 'stub' || hollow) {
        ctx.fillStyle = P.bg;
        this.shape(n.kind, x, y, r);
        ctx.fill();
      }
      this.shape(n.kind, x, y, r);
      if (hollow) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(n.kind === 'external' ? 1.6 : 1.2, 1.4 / k);
        if (n.kind === 'inactive') ctx.setLineDash([2.5, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = n.alpha * (n.state === 'stub' ? 0.55 : 1);
        ctx.fill();
        ctx.globalAlpha = n.alpha;
      }

      // named accounts get a ring: "someone publicly identified this"
      if (n.named && n.kind !== 'external') {
        ctx.strokeStyle = P.ring;
        ctx.lineWidth = Math.max(1.1, 1.2 / k);
        this.shape(n.kind, x, y, r + Math.max(2.4, 2.4 / k));
        ctx.stroke();
      }
      if (n.kind === 'flagged' && r * k > 5) {
        ctx.fillStyle = P.bg;
        ctx.font = `700 ${r * 1.3}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', x, y + r * 0.05);
      }
      if (n.id === sel || this.trail?.nodes.has(n.id)) {
        ctx.strokeStyle = P.accent;
        ctx.lineWidth = Math.max(2, 2 / k);
        ctx.beginPath();
        ctx.arc(x, y, r * 1.25 + Math.max(5, 5 / k), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n.state === 'loading') {
        animating = true;
        ctx.strokeStyle = P.accent;
        ctx.lineWidth = Math.max(1.5, 1.6 / k);
        const a0 = t * 5;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.25 + Math.max(8, 8 / k), a0, a0 + Math.PI * 0.7);
        ctx.stroke();
      }
      if (n.pinned) {
        ctx.fillStyle = P.text;
        ctx.beginPath();
        ctx.arc(x + r * 0.85, y - r * 0.85, Math.max(1.6, 2 / k), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* labels, drawn in screen space at a constant size */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const kT = 2.3 - s.labels * 2.1;
    const items: { n: GNode; a: number; pri: number; sx: number; sy: number }[] = [];
    for (const n of this.nodes) {
      if (!onScreen(n)) continue;
      const forced = n.id === hoverId || n.id === sel || (this.focus?.has(n.id) ?? false) || this.trail?.nodes.has(n.id) || n.kind === 'flagged' || (this.matches?.has(n.id) ?? false);
      let a: number;
      if (forced) a = 1;
      else {
        const imp = (n.named ? 0.5 : 1) * Math.min(1, 9 / Math.max(9, n.r * 1.4));
        a = smooth(kT * imp * 0.75, kT * imp, k);
      }
      a *= Math.max(n.alpha, forced ? 1 : 0);
      if (a < 0.03) continue;
      const pri = (n.id === hoverId ? 1000 : 0) + (n.id === sel ? 900 : 0) + (forced ? 500 : 0) + (n.named ? 100 : 0) + n.r;
      const ringed = n.id === sel || !!this.trail?.nodes.has(n.id);
      items.push({ n, a, pri, sx: n.x! * k + cam.x, sy: n.y! * k + cam.y + n.r * k * (ringed ? 1.3 : 1.3) + (ringed ? 13 : 5) });
    }
    items.sort((x, y) => y.pri - x.pri);
    const placed: number[][] = [];
    let drawn = 0;
    for (const it of items) {
      if (drawn > 350) break;
      const n = it.n;
      const label = n.kind === 'flagged' ? `⚠ ${n.label}` : n.label;
      ctx.font = n.named ? '500 12px system-ui, -apple-system, "Segoe UI", sans-serif' : '11px ui-monospace, "SF Mono", Menlo, monospace';
      const wpx = ctx.measureText(label).width;
      const box = [it.sx - wpx / 2 - 2, it.sy - 1, it.sx + wpx / 2 + 2, it.sy + 14];
      const isForced = it.pri >= 500;
      if (!isForced && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      drawn++;
      ctx.globalAlpha = it.a;
      ctx.strokeStyle = P.bg;
      ctx.lineWidth = 3.5;
      ctx.strokeText(label, it.sx, it.sy);
      ctx.fillStyle = n.named || n.id === hoverId || n.id === sel ? P.text : P.textMuted;
      ctx.fillText(label, it.sx, it.sy);
    }
    ctx.globalAlpha = 1;
    return animating;
  }

  private arrow(c: { x: number; y: number }, target: GNode, size: number) {
    const { ctx } = this;
    let dx = target.x! - c.x;
    let dy = target.y! - c.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const tipX = target.x! - dx * (target.r * 1.15 + 2);
    const tipY = target.y! - dy * (target.r * 1.15 + 2);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - dx * size * 1.6 - dy * size * 0.8, tipY - dy * size * 1.6 + dx * size * 0.8);
    ctx.lineTo(tipX - dx * size * 1.6 + dy * size * 0.8, tipY - dy * size * 1.6 - dx * size * 0.8);
    ctx.closePath();
    ctx.fill();
  }

  /** Shape is a second channel for account type, so color is never the only cue. */
  private shape(kind: NodeKind, x: number, y: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (kind === 'bridge' || kind === 'external') {
      // A triangle: a way out of the XRP Ledger (solid = door account here, hollow = the other side).
      const d = r * 1.4;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d * 0.866, y + d * 0.5);
      ctx.lineTo(x - d * 0.866, y + d * 0.5);
      ctx.closePath();
    } else if (kind === 'issuer') {
      const d = r * 1.3;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
    } else if (kind === 'exchange') {
      const s = r * 0.9;
      ctx.roundRect(x - s, y - s, s * 2, s * 2, s * 0.35);
    } else if (kind === 'amm') {
      const d = r * 1.12;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
