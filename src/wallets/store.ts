/** The wallet list, persisted to disk through the local dev-server API (see server/walletApi.ts). */
import { NETWORK_IDS, isNetworkId, type NetworkId } from './networks';
import type { StoreData, StoredWallet, VaultMeta } from './types';

interface StoreResponse {
  rev: number;
  store: StoreData | null;
  path: string;
}

function normalize(s: StoreData | null): StoreData {
  const wallets = (s?.wallets ?? []).filter((w) => w && isNetworkId(w.networkId) && typeof w.address === 'string');
  return { version: 2, wallets, vault: s?.vault };
}

async function getStore(): Promise<StoreResponse> {
  const res = await fetch('/api/store', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn’t read wallets (HTTP ${res.status})`);
  return (await res.json()) as StoreResponse;
}

export class WalletStore {
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    public data: StoreData,
    private rev: number,
    readonly path: string,
  ) {
    // Another tab (or a hand edit of the file) may have changed things.
    window.addEventListener('focus', () => void this.reload().catch(() => {}));
  }

  static async open(): Promise<WalletStore> {
    const r = await getStore();
    return new WalletStore(normalize(r.store), r.rev, r.path);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get wallets(): StoredWallet[] {
    return this.data.wallets;
  }

  get vault(): VaultMeta | undefined {
    return this.data.vault;
  }

  get(id: string | null | undefined): StoredWallet | undefined {
    return id ? this.data.wallets.find((w) => w.id === id) : undefined;
  }

  find(address: string, net: NetworkId): StoredWallet | undefined {
    return this.data.wallets.find((w) => w.address === address && w.networkId === net);
  }

  onNetwork(net: NetworkId): StoredWallet[] {
    return this.data.wallets.filter((w) => w.networkId === net);
  }

  groups(): string[] {
    return [...new Set(this.data.wallets.map((w) => w.group?.trim()).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b));
  }

  /** Accounts per network, for live subscriptions. */
  addressesByNetwork(): Map<NetworkId, string[]> {
    const m = new Map<NetworkId, string[]>(NETWORK_IDS.map((n) => [n, []]));
    for (const w of this.data.wallets) m.get(w.networkId)!.push(w.address);
    return m;
  }

  /**
   * Apply a change and save it. Changes run one at a time; if another tab saved
   * first, the store reloads and the change is applied again on top.
   */
  mutate(fn: (draft: StoreData) => void | Promise<void>): Promise<void> {
    const run = this.queue.catch(() => {}).then(() => this.apply(fn));
    this.queue = run;
    return run;
  }

  private async apply(fn: (draft: StoreData) => void | Promise<void>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const draft = structuredClone(this.data);
      await fn(draft);
      const res = await fetch('/api/store', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev: this.rev, store: draft }),
      });
      const body = (await res.json().catch(() => ({}))) as { rev?: number; error?: string };
      if (res.status === 409) {
        await this.reload();
        continue;
      }
      if (!res.ok) throw new Error(body.error ?? `Couldn’t save wallets (HTTP ${res.status})`);
      this.data = draft;
      this.rev = body.rev ?? this.rev + 1;
      this.emit();
      return;
    }
    throw new Error('Couldn’t save: the wallets keep changing in another tab.');
  }

  /** Pick up changes saved elsewhere. */
  async reload(): Promise<void> {
    const r = await getStore();
    if (r.rev === this.rev) return;
    this.data = normalize(r.store);
    this.rev = r.rev;
    this.emit();
  }
}

/* ------------------------------ helpers ------------------------------ */

export const newId = () => crypto.randomUUID();

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Victor', 'Walter'];

/** Friendly default names (Alice, Bob, …) not yet used on that network. */
export function nextNames(store: WalletStore, net: NetworkId, count: number): string[] {
  const used = new Set(store.onNetwork(net).map((w) => w.label.toLowerCase()));
  const out: string[] = [];
  for (const n of NAMES) {
    if (out.length >= count) break;
    if (!used.has(n.toLowerCase())) out.push(n);
  }
  for (let i = store.wallets.length + 1; out.length < count; i++) if (!used.has(`wallet ${i}`)) out.push(`Wallet ${i}`);
  return out;
}
