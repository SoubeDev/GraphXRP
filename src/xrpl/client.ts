/**
 * Minimal XRPL WebSocket client: one socket, automatic failover across public
 * full-history servers, a bounded request queue, and a live ledger stream.
 */

export const DEFAULT_SERVERS = [
  'wss://xrplcluster.com',
  'wss://s2.ripple.com',
  'wss://s1.ripple.com',
  'wss://xrpl.ws',
];

export type ConnState = 'connecting' | 'connected' | 'offline';

export class XrplError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Job {
  req: Record<string, unknown>;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  attempts: number;
  done: boolean;
}

const RETRYABLE = new Set(['slowDown', 'tooBusy', 'noNetwork', 'notReady', 'noCurrent', 'noClosed', 'amendmentBlocked', 'failedToForward']);

export class XrplClient {
  state: ConnState = 'offline';
  server = '';
  ledgerIndex = 0;
  ledgerTime = 0;
  reserveBase = 1;
  reserveInc = 0.2;

  private servers: string[];
  private serverIdx = 0;
  private ws: WebSocket | null = null;
  private connecting = false;
  private nextId = 1;
  private queue: Job[] = [];
  private lowQueue: Job[] = [];
  private inflight = new Map<number, Job>();
  private maxInflight = 6;
  private backoff = 500;
  private listeners = new Set<() => void>();
  private watchdog = 0;
  /** Servers that told us to back off, and until when. */
  private throttled = new Map<string, number>();

  constructor(servers: string[] = DEFAULT_SERVERS) {
    this.servers = servers;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  setServers(servers: string[]) {
    this.servers = servers.length ? servers : DEFAULT_SERVERS;
    this.serverIdx = 0;
    this.ws?.close();
  }

  /** Start the connection eagerly (requests also connect lazily). */
  start() {
    this.connect();
  }

  /** `low` requests only use spare capacity, so background work never delays what the user asked for. */
  request<T = any>(command: string, params: Record<string, unknown> = {}, timeoutMs = 25000, low = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = { req: { command, ...params }, resolve, reject, attempts: 0, done: false };
      const timer = setTimeout(() => {
        if (job.done) return;
        job.done = true;
        this.queue = this.queue.filter((j) => j !== job);
        this.lowQueue = this.lowQueue.filter((j) => j !== job);
        reject(new XrplError('timeout', `The ledger server took too long to answer (${command}).`));
      }, low ? timeoutMs * 3 : timeoutMs);
      job.resolve = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      job.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      (low ? this.lowQueue : this.queue).push(job);
      this.connect();
      this.pump();
    });
  }

  /** Pick the next server that isn't cooling down; returns a wait time if all are. */
  private pickServer(): { url: string; wait: number } {
    const now = Date.now();
    let soonest = Infinity;
    for (let i = 0; i < this.servers.length; i++) {
      const url = this.servers[(this.serverIdx + i) % this.servers.length];
      const until = this.throttled.get(url) ?? 0;
      if (until <= now) {
        this.serverIdx = (this.serverIdx + i) % this.servers.length;
        return { url, wait: 0 };
      }
      soonest = Math.min(soonest, until);
    }
    return { url: this.servers[this.serverIdx % this.servers.length], wait: soonest - now };
  }

  private connect() {
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
    const { url, wait } = this.pickServer();
    if (wait > 0) {
      this.connecting = true;
      setTimeout(() => {
        this.connecting = false;
        this.connect();
      }, wait);
      return;
    }
    this.connecting = true;
    this.server = url;
    this.state = 'connecting';
    this.emit();

    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.connecting = false;
      this.failover(false);
      return;
    }
    const openTimer = setTimeout(() => !opened && ws.close(), 8000);

    ws.onopen = () => {
      opened = true;
      clearTimeout(openTimer);
      this.ws = ws;
      this.connecting = false;
      this.backoff = 500;
      this.state = 'connected';
      this.emit();
      this.sendRaw({ id: 'sub', command: 'subscribe', streams: ['ledger'] });
      this.armWatchdog();
      this.pump();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (this.ws === ws) this.ws = null;
      this.connecting = false;
      // Put in-flight requests back at the front of the queue.
      const stranded = [...this.inflight.values()].filter((j) => !j.done);
      this.inflight.clear();
      this.queue.unshift(...stranded);
      this.failover(opened);
    };
  }

  private failover(wasOpen: boolean) {
    this.serverIdx++;
    this.state = 'connecting';
    this.emit();
    const delay = wasOpen ? 200 : this.backoff;
    if (!wasOpen) this.backoff = Math.min(this.backoff * 2, 8000);
    setTimeout(() => this.connect(), delay);
  }

  private armWatchdog() {
    clearTimeout(this.watchdog);
    // Ledgers close every ~4s; if we hear nothing for 30s the socket is stale.
    this.watchdog = window.setTimeout(() => this.ws?.close(), 30000);
  }

  private sendRaw(obj: unknown) {
    this.ws?.send(JSON.stringify(obj));
  }

  private pump() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.inflight.size < this.maxInflight) {
      let job = this.queue.shift();
      if (!job && this.inflight.size < this.maxInflight - 2) job = this.lowQueue.shift();
      if (!job) break;
      if (job.done) continue;
      const id = this.nextId++;
      this.inflight.set(id, job);
      this.sendRaw({ ...job.req, id });
    }
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'ledgerClosed') {
      this.ledgerIndex = msg.ledger_index;
      this.ledgerTime = msg.ledger_time;
      if (msg.reserve_base) this.reserveBase = Number(msg.reserve_base) / 1e6;
      if (msg.reserve_inc) this.reserveInc = Number(msg.reserve_inc) / 1e6;
      this.armWatchdog();
      this.emit();
      return;
    }
    if (msg.id === 'sub') {
      const r = msg.result;
      if (r?.ledger_index) {
        this.ledgerIndex = r.ledger_index;
        this.ledgerTime = r.ledger_time;
        if (r.reserve_base) this.reserveBase = Number(r.reserve_base) / 1e6;
        if (r.reserve_inc) this.reserveInc = Number(r.reserve_inc) / 1e6;
        this.emit();
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const job = this.inflight.get(msg.id);
    if (!job) return;
    this.inflight.delete(msg.id);

    if (msg.status === 'success' || (msg.result && !msg.result.error && msg.status !== 'error')) {
      if (!job.done) {
        job.done = true;
        job.resolve(msg.result);
      }
    } else {
      const code = msg.error || msg.result?.error || 'unknown';
      const text = String(msg.error_message || msg.result?.error_message || '');
      if (/rate limit|quota/i.test(text) && job.attempts < 6) {
        // This server wants us to slow down: park it and move to another one.
        job.attempts++;
        const ms = Number(/retry in ~?(\d+)\s*ms/i.exec(text)?.[1] ?? 30000);
        this.throttled.set(this.server, Date.now() + Math.min(Math.max(ms, 5000), 120000));
        this.queue.unshift(job);
        this.ws?.close();
        return;
      }
      if (RETRYABLE.has(code) && job.attempts < 3) {
        job.attempts++;
        setTimeout(() => {
          if (!job.done) {
            this.queue.unshift(job);
            this.pump();
          }
        }, 600 * job.attempts);
      } else if (!job.done) {
        job.done = true;
        job.reject(new XrplError(code, msg.error_message || msg.result?.error_message || code));
      }
    }
    this.pump();
  }
}
