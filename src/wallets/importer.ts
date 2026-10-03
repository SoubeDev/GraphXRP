/**
 * Bringing wallets in from elsewhere: GraphXRP backups, XRPL Wallet Manager
 * (its store file, its backups, or the app itself while it runs on :7357), and
 * plain lists like `[{ "label": "x", "seed": "s…" }, { "address": "r…" }]`.
 */
import type { Ctx } from './index';
import { NETWORKS, isNetworkId, type NetworkId } from './networks';
import { deriveFromSecret, normalizeAddress, secretsOf } from './keys';
import { newId } from './store';
import { keyFor, seal, unseal } from './vault';
import { SECRET_FIELDS, type StoredWallet, type VaultMeta } from './types';
import { ensureUnlocked } from './ui/vaultui';

/** XRPL Wallet Manager's default local address. */
const LEGACY_URL = 'http://127.0.0.1:7357/api/store';

export interface Incoming {
  wallets: StoredWallet[];
  /** The vault that sealed any mainnet keys in this backup. */
  vault?: VaultMeta;
  /** Entries that couldn't be read (unknown network, bad secret…). */
  unreadable: number;
}

/** How many wallets the running XRPL Wallet Manager has (null if it isn't running). */
export async function findLegacy(): Promise<number | null> {
  try {
    const res = await fetch(LEGACY_URL, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { store?: { wallets?: unknown[] } | null };
    return body.store?.wallets?.length || null;
  } catch {
    return null;
  }
}

export async function importLegacy(ctx: Ctx): Promise<{ added: number; skipped: number; unreadable: number }> {
  const res = await fetch(LEGACY_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`XRPL Wallet Manager answered ${res.status}`);
  return importIncoming(ctx, readBackup(await res.json(), 'testnet'));
}

/** Understand a backup file's contents. Throws if it isn't a wallet backup at all. */
export function readBackup(raw: unknown, fallback: NetworkId): Incoming {
  let data: any = raw;
  if (data && typeof data === 'object' && !Array.isArray(data) && data.store && typeof data.store === 'object') data = data.store; // a /api/store response
  const list: any[] | null = Array.isArray(data) ? data : Array.isArray(data?.wallets) ? data.wallets : null;
  if (!list) throw new Error('That file doesn’t contain any wallets.');
  // XRPL Wallet Manager (v1) keeps network ids; custom networks there have no meaning here.
  const custom = new Set<string>((data?.networks ?? []).filter((n: any) => n && !n.builtin).map((n: any) => n.id));
  const out: StoredWallet[] = [];
  let unreadable = 0;
  const now = new Date().toISOString();
  for (const item of list) {
    try {
      const w = toWallet(item, fallback, custom, now);
      if (w) out.push(w);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { wallets: out, vault: data?.version === 2 ? data.vault : undefined, unreadable };
}

function toWallet(item: any, fallback: NetworkId, custom: Set<string>, now: string): StoredWallet | null {
  if (!item || typeof item !== 'object') return null;
  const netRaw = item.networkId ?? item.network?.id ?? item.network;
  if (netRaw && (custom.has(netRaw) || !isNetworkId(netRaw))) return null;
  const net: NetworkId = isNetworkId(netRaw) ? netRaw : fallback;
  const base = {
    id: typeof item.id === 'string' ? item.id : newId(),
    label: String(item.label ?? item.name ?? '').trim(),
    networkId: net,
    group: item.group || undefined,
    notes: item.notes || undefined,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
  };
  if (item.sealed) {
    if (typeof item.address !== 'string') return null;
    return { ...base, address: item.address, secretKind: item.secretKind, algorithm: item.algorithm, publicKey: item.publicKey, sealed: item.sealed, label: base.label || item.address };
  }
  // Prefer the form the secret was written down in (secret numbers also carry a seed).
  const secret = item.mnemonic ?? item.secretNumbers ?? item.seed ?? item.secret;
  if (!item.watchOnly && typeof secret === 'string' && secret.trim()) {
    const k = deriveFromSecret(secret, { derivationPath: item.derivationPath, algorithm: item.mnemonic || item.secretNumbers ? undefined : item.algorithm });
    if (item.address && item.address !== k.address) return null;
    return { ...base, ...secretsOf(k), address: k.address, publicKey: k.publicKey, algorithm: k.algorithm, secretKind: k.secretKind, label: base.label || k.address };
  }
  if (!item.watchOnly && item.privateKey && item.publicKey && typeof item.address === 'string') {
    return { ...base, address: item.address, publicKey: item.publicKey, privateKey: item.privateKey, algorithm: item.algorithm, secretKind: 'none', label: base.label || item.address };
  }
  const address = typeof item.address === 'string' ? normalizeAddress(item.address) : null;
  if (!address) return null;
  return { ...base, address, watchOnly: true, label: base.label || address };
}

/**
 * Add what's new (same address on the same network = already here). Mainnet keys
 * are sealed with this vault; keys sealed by another vault are re-encrypted,
 * which needs that backup's password.
 */
export async function importIncoming(ctx: Ctx, inc: Incoming, askBackupPassword?: () => Promise<string | null>): Promise<{ added: number; skipped: number; unreadable: number }> {
  const { store } = ctx;
  const have = new Set(store.wallets.map((w) => `${w.networkId}:${w.address}`));
  const ids = new Set(store.wallets.map((w) => w.id));
  const fresh: StoredWallet[] = [];
  for (const w of inc.wallets) {
    const k = `${w.networkId}:${w.address}`;
    if (have.has(k)) continue;
    have.add(k);
    fresh.push(ids.has(w.id) ? { ...w, id: newId() } : w);
  }
  const skipped = inc.wallets.length - fresh.length;
  let unreadable = inc.unreadable;

  const mainnet = fresh.filter((w) => NETWORKS[w.networkId].real && !w.watchOnly);
  if (mainnet.length) {
    const sameVault = !!inc.vault && store.vault?.salt === inc.vault.salt;
    const adoptVault = !store.vault && !!inc.vault;
    const needsKey = mainnet.some((w) => !w.sealed || (!sameVault && !adoptVault));
    if (adoptVault) {
      await store.mutate((d) => {
        d.vault ??= inc.vault;
      });
    }
    if (needsKey && !(await ensureUnlocked(store, 'Enter your vault password to encrypt the imported mainnet keys.'))) throw new Error('Import cancelled: mainnet keys need the vault unlocked.');
    let foreign: CryptoKey | null = null;
    for (let i = 0; i < fresh.length; i++) {
      const w = fresh[i];
      if (!NETWORKS[w.networkId].real || w.watchOnly) continue;
      if (!w.sealed) {
        const plain = secretsOf(w);
        const rest = { ...w };
        for (const f of SECRET_FIELDS) delete rest[f];
        fresh[i] = { ...rest, sealed: await seal(plain) };
      } else if (!sameVault && !adoptVault) {
        if (!inc.vault) {
          fresh[i] = null as never;
          unreadable++;
          continue;
        }
        if (!foreign) {
          const pw = await askBackupPassword?.();
          foreign = pw ? await keyFor(inc.vault, pw) : null;
          if (!foreign) throw new Error('That backup’s mainnet keys use a different vault password, and it didn’t match.');
        }
        fresh[i] = { ...w, sealed: await seal(await unseal(w.sealed, foreign)) };
      }
    }
  }
  // Test-network wallets never carry sealed blobs.
  const final = fresh.filter(Boolean).map((w) => (NETWORKS[w.networkId].real ? w : { ...w, sealed: undefined }));
  if (final.length) {
    await store.mutate((d) => {
      d.wallets.push(...final);
    });
  }
  return { added: final.length, skipped, unreadable };
}
