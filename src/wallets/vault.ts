/**
 * The mainnet vault. Mainnet secrets are encrypted in the browser with a key
 * derived from a password (PBKDF2-SHA256, 600k rounds, then AES-GCM-256). The key
 * is non-extractable, lives only in memory, and locks itself when idle.
 */
import type { Secrets, Sealed, VaultMeta } from './types';

const ITERATIONS = 600_000;
const CHECK = 'graphxrp-vault-v1';
export const IDLE_MINUTES = 15;

let key: CryptoKey | null = null;
let timer = 0;
const listeners = new Set<() => void>();

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptWith(k: CryptoKey, text: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(text)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decryptWith(k: CryptoKey, s: Sealed): Promise<string> {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, k, unb64(s.ct)));
}

export const isUnlocked = () => !!key;

export function onVaultChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}

/** Any use of the key pushes the auto-lock back. */
function touch() {
  clearTimeout(timer);
  timer = window.setTimeout(lock, IDLE_MINUTES * 60_000);
}

function setKey(k: CryptoKey) {
  key = k;
  touch();
  emit();
}

export async function createVault(password: string): Promise<VaultMeta> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await derive(password, salt, ITERATIONS);
  const meta: VaultMeta = { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), check: await encryptWith(k, CHECK) };
  setKey(k);
  return meta;
}

/** The key for a vault, or null if the password is wrong. Doesn't unlock anything. */
export async function keyFor(meta: VaultMeta, password: string): Promise<CryptoKey | null> {
  const k = await derive(password, unb64(meta.salt), meta.iterations);
  try {
    return (await decryptWith(k, meta.check)) === CHECK ? k : null;
  } catch {
    return null;
  }
}

export async function unlock(meta: VaultMeta, password: string): Promise<boolean> {
  const k = await keyFor(meta, password);
  if (!k) return false;
  setKey(k);
  return true;
}

export function lock() {
  if (!key) return;
  key = null;
  clearTimeout(timer);
  emit();
}

export async function seal(secrets: Secrets, k: CryptoKey | null = key): Promise<Sealed> {
  if (!k) throw new Error('The vault is locked.');
  if (k === key) touch();
  return encryptWith(k, JSON.stringify(secrets));
}

export async function unseal(s: Sealed, k: CryptoKey | null = key): Promise<Secrets> {
  if (!k) throw new Error('The vault is locked.');
  if (k === key) touch();
  return JSON.parse(await decryptWith(k, s)) as Secrets;
}

/** Re-encrypt every sealed secret under a new password. Returns the new metadata and wallets. */
export async function changePassword<W extends { sealed?: Sealed }>(meta: VaultMeta, oldPassword: string, newPassword: string, wallets: W[]): Promise<{ meta: VaultMeta; wallets: W[] }> {
  const oldKey = await keyFor(meta, oldPassword);
  if (!oldKey) throw new Error('The current password is wrong.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await derive(newPassword, salt, ITERATIONS);
  const out: W[] = [];
  for (const w of wallets) out.push(w.sealed ? { ...w, sealed: await encryptWith(newKey, await decryptWith(oldKey, w.sealed)) } : w);
  const next: VaultMeta = { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), check: await encryptWith(newKey, CHECK) };
  setKey(newKey);
  return { meta: next, wallets: out };
}
