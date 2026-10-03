/** Key generation and derivation: family seeds, BIP39 mnemonics and Xaman secret numbers. */
import { ECDSA, Wallet, isValidClassicAddress, isValidXAddress, xAddressToClassicAddress } from 'xrpl';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Account } from '@xrplf/secret-numbers';
import type { KeyAlgorithm, SecretKind, Secrets } from './types';

export const DEFAULT_DERIVATION_PATH = "m/44'/144'/0'/0/0";

export interface DerivedKeys extends Secrets {
  address: string;
  publicKey: string;
  algorithm: KeyAlgorithm;
  secretKind: SecretKind;
}

export type GenerateFormat = 'seed' | 'mnemonic' | 'secretNumbers';

const algorithmOf = (publicKey: string): KeyAlgorithm => (publicKey.toUpperCase().startsWith('ED') ? 'ed25519' : 'secp256k1');

function fromWallet(w: Wallet, extra: Partial<DerivedKeys> & { secretKind: SecretKind }): DerivedKeys {
  return { address: w.classicAddress, publicKey: w.publicKey, privateKey: w.privateKey, algorithm: algorithmOf(w.publicKey), seed: w.seed, ...extra };
}

export function generateKeys(format: GenerateFormat, algorithm: KeyAlgorithm): DerivedKeys {
  if (format === 'mnemonic') {
    const mnemonic = generateMnemonic(wordlist, 128);
    return fromWallet(Wallet.fromMnemonic(mnemonic), { secretKind: 'mnemonic', mnemonic, derivationPath: DEFAULT_DERIVATION_PATH });
  }
  if (format === 'secretNumbers') return fromSecretNumbers(new Account(undefined, 'ecdsa-secp256k1').getSecretString());
  return fromWallet(Wallet.generate(algorithm === 'ed25519' ? ECDSA.ed25519 : ECDSA.secp256k1), { secretKind: 'seed' });
}

function fromSecretNumbers(numbers: string): DerivedKeys {
  // secp256k1 matches how Xaman derives accounts from secret numbers.
  const account = new Account(numbers, 'ecdsa-secp256k1');
  return fromWallet(Wallet.fromSeed(account.getFamilySeed()), { secretKind: 'secretNumbers', secretNumbers: account.getSecretString() });
}

export type DetectedKind = 'seed' | 'mnemonic' | 'secretNumbers' | 'address' | 'empty' | 'unknown';

export function detectSecret(input: string): DetectedKind {
  const value = input.trim();
  if (!value) return 'empty';
  if (isValidClassicAddress(value) || isValidXAddress(value)) return 'address';
  if (/^s[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return 'seed';
  const digits = value.replace(/[\s,-]+/g, '');
  if (/^\d{48}$/.test(digits)) return 'secretNumbers';
  const words = value.toLowerCase().split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]+$/.test(w))) return 'mnemonic';
  return 'unknown';
}

export const DETECTED_LABEL: Record<DetectedKind, string> = {
  seed: 'Family seed',
  mnemonic: 'Recovery phrase (BIP39)',
  secretNumbers: 'Secret numbers (Xaman)',
  address: 'Address: use “Watch” to add it without keys',
  empty: '',
  unknown: 'Not a seed, recovery phrase or secret numbers',
};

/** Derive keys from a seed, mnemonic or secret numbers. Throws a readable message on bad input. */
export function deriveFromSecret(input: string, opts: { derivationPath?: string; algorithm?: KeyAlgorithm } = {}): DerivedKeys {
  const value = input.trim();
  switch (detectSecret(value)) {
    case 'seed': {
      const algorithm = opts.algorithm ? (opts.algorithm === 'ed25519' ? ECDSA.ed25519 : ECDSA.secp256k1) : undefined;
      try {
        return fromWallet(Wallet.fromSeed(value, { algorithm }), { secretKind: 'seed' });
      } catch {
        throw new Error('That seed isn’t valid (checksum mismatch).');
      }
    }
    case 'mnemonic': {
      const mnemonic = value.toLowerCase().split(/\s+/).join(' ');
      if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Not a valid recovery phrase (check spelling and word order).');
      const derivationPath = opts.derivationPath?.trim() || DEFAULT_DERIVATION_PATH;
      return fromWallet(Wallet.fromMnemonic(mnemonic, { derivationPath }), { secretKind: 'mnemonic', mnemonic, derivationPath });
    }
    case 'secretNumbers': {
      const groups = value.replace(/[\s,-]+/g, '').match(/.{6}/g) ?? [];
      try {
        return fromSecretNumbers(groups.join(' '));
      } catch (err) {
        throw new Error(`Invalid secret numbers: ${(err as Error).message}`);
      }
    }
    case 'address':
      throw new Error('That’s an address. Use “Watch” to add it without keys.');
    default:
      throw new Error('Enter a family seed (s…), a 12–24 word recovery phrase, or 8 groups of secret numbers.');
  }
}

export function normalizeAddress(input: string): string | null {
  const v = input.trim();
  if (isValidClassicAddress(v)) return v;
  if (isValidXAddress(v)) return xAddressToClassicAddress(v).classicAddress;
  return null;
}

/** A signing wallet from stored (or unsealed) secrets. */
export function signerFrom(publicKey: string | undefined, s: Secrets): Wallet {
  if (publicKey && s.privateKey) return new Wallet(publicKey, s.privateKey, s.seed ? { seed: s.seed } : {});
  if (s.seed) return Wallet.fromSeed(s.seed);
  if (s.mnemonic) return Wallet.fromMnemonic(s.mnemonic, { derivationPath: s.derivationPath || DEFAULT_DERIVATION_PATH });
  throw new Error('No private key stored for this wallet.');
}

export function secretNumberGroups(numbers: string | undefined): string[] {
  return (numbers ?? '').replace(/[\s,-]+/g, '').match(/.{6}/g) ?? [];
}

export const secretsOf = (k: Secrets): Secrets => {
  const out: Secrets = {};
  if (k.seed) out.seed = k.seed;
  if (k.mnemonic) out.mnemonic = k.mnemonic;
  if (k.derivationPath) out.derivationPath = k.derivationPath;
  if (k.secretNumbers) out.secretNumbers = k.secretNumbers;
  if (k.privateKey) out.privateKey = k.privateKey;
  return out;
};
