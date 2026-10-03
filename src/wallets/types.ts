/**
 * Shapes of the local wallet store (shared with the dev-server API, which loads
 * this file directly, so it imports nothing).
 */

/** Same as `NetworkId` in networks.ts. */
type NetworkId = 'mainnet' | 'testnet' | 'devnet';

export type KeyAlgorithm = 'ed25519' | 'secp256k1';

/** How the secret was originally written down; decides what the Keys tab shows. */
export type SecretKind = 'seed' | 'mnemonic' | 'secretNumbers' | 'none';

export interface Secrets {
  seed?: string;
  mnemonic?: string;
  derivationPath?: string;
  secretNumbers?: string;
  privateKey?: string;
}

/** AES-GCM ciphertext, base64. */
export interface Sealed {
  iv: string;
  ct: string;
}

export const SECRET_FIELDS = ['seed', 'mnemonic', 'derivationPath', 'secretNumbers', 'privateKey'] as const;

export interface StoredWallet extends Secrets {
  id: string;
  label: string;
  address: string;
  networkId: NetworkId;
  group?: string;
  notes?: string;
  /** An address without keys. */
  watchOnly?: boolean;
  /** Named automatically (public name or short address); follows the public name until you rename it. */
  autoLabel?: boolean;
  secretKind?: SecretKind;
  algorithm?: KeyAlgorithm;
  publicKey?: string;
  /** Mainnet only: the secrets, encrypted with the vault password. Plain secret fields are never set. */
  sealed?: Sealed;
  createdAt: string;
}

export interface VaultMeta {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  /** A known value encrypted with the vault key, to check a password. */
  check: Sealed;
}

export interface StoreData {
  version: 2;
  wallets: StoredWallet[];
  vault?: VaultMeta;
}
