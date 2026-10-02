/** Account flags translated into plain-English traits a newcomer can understand. */

export const F = {
  RequireDestTag: 0x00020000,
  RequireAuth: 0x00040000,
  DisallowXRP: 0x00080000,
  DisableMaster: 0x00100000,
  NoFreeze: 0x00200000,
  GlobalFreeze: 0x00400000,
  DefaultRipple: 0x00800000,
  DepositAuth: 0x01000000,
  DisallowIncomingTrustline: 0x20000000,
  AllowTrustLineClawback: 0x80000000,
} as const;

/** Addresses that provably nobody holds the key for. */
export const BLACKHOLES = new Set([
  'rrrrrrrrrrrrrrrrrrrrrhoLvTp', // ACCOUNT_ZERO
  'rrrrrrrrrrrrrrrrrrrrBZbvji', // ACCOUNT_ONE
  'rrrrrrrrrrrrrrrrrrrn5RM1rHd', // NaN address
]);

export const has = (flags: number, f: number) => (flags & f) >>> 0 === f >>> 0 && f !== 0;

export type Tone = 'good' | 'warn' | 'bad' | 'info';

export interface Trait {
  icon: string;
  title: string;
  text: string;
  tone: Tone;
}

export interface TraitInput {
  flags: number;
  regularKey?: string;
  signers?: { quorum: number; entries: { account: string; weight: number }[] };
  transferRate?: number; // percent
  isAmm: boolean;
  issues: boolean;
  exists: boolean;
}

export function isBlackholed(t: Pick<TraitInput, 'flags' | 'regularKey' | 'signers'>): boolean {
  if (!has(t.flags, F.DisableMaster)) return false;
  if (t.signers && t.signers.entries.length) return false;
  return !t.regularKey || BLACKHOLES.has(t.regularKey);
}

export function traits(t: TraitInput): Trait[] {
  const out: Trait[] = [];
  if (!t.exists) {
    out.push({
      icon: 'trash',
      title: 'Not active on the ledger',
      text: 'This address has no account right now. It was either deleted by its owner, or never received the XRP needed to activate it. Its past history is still public.',
      tone: 'info',
    });
    return out;
  }
  if (t.isAmm) {
    out.push({
      icon: 'droplet',
      title: 'Automated market maker (AMM) pool',
      text: 'A robot account that nobody owns or controls. It holds two assets and trades them automatically at a price set by a formula. Anyone can add liquidity and earn fees.',
      tone: 'info',
    });
  }
  if (isBlackholed(t)) {
    out.push({
      icon: 'lock',
      title: 'Blackholed: nobody controls it',
      text: t.issues
        ? 'Its keys were permanently disabled. No one can move its funds or change its settings ever again, so the supply of the tokens it issued can never be increased.'
        : 'Its keys were permanently disabled. No one can move its funds or change its settings ever again.',
      tone: 'good',
    });
  } else if (t.signers && t.signers.entries.length) {
    out.push({
      icon: 'key',
      title: `Multi-signature (${t.signers.quorum} approvals needed)`,
      text: `Transactions need sign-off from several keys (${t.signers.entries.length} signers, combined weight ${t.signers.quorum} required). Organizations use this so no single person can move funds.${has(t.flags, F.DisableMaster) ? ' The original key is disabled.' : ''}`,
      tone: 'info',
    });
  } else if (t.regularKey) {
    out.push({
      icon: 'key',
      title: 'Controlled by a separate key',
      text: `A "regular key" can sign for this account${has(t.flags, F.DisableMaster) ? ', and the original master key is disabled' : ''}. That key belongs to another address, shown as a dashed link in the graph.`,
      tone: 'info',
    });
  }
  if (has(t.flags, F.RequireDestTag)) {
    out.push({
      icon: 'building',
      title: 'Requires a destination tag',
      text: 'Payments must include a number (a "tag") saying who they are for. Exchanges and custodians do this because one address holds funds for many customers.',
      tone: 'info',
    });
  }
  if (has(t.flags, F.GlobalFreeze)) {
    out.push({
      icon: 'alert',
      title: 'All of its tokens are frozen',
      text: 'The issuer has frozen every token it issued. Holders cannot send them to anyone except back to the issuer.',
      tone: 'bad',
    });
  }
  if (has(t.flags, F.AllowTrustLineClawback)) {
    out.push({
      icon: 'alert',
      title: 'Can claw back its tokens',
      text: 'This issuer reserved the right to take back tokens it issued from holders. Common for regulated stablecoins; worth knowing before you hold them.',
      tone: 'warn',
    });
  }
  if (has(t.flags, F.NoFreeze)) {
    out.push({
      icon: 'shield',
      title: 'Gave up the power to freeze',
      text: 'The issuer permanently promised it can never freeze anyone’s balance of its tokens.',
      tone: 'good',
    });
  }
  if (has(t.flags, F.RequireAuth)) {
    out.push({
      icon: 'shield',
      title: 'Holders need approval',
      text: 'You can only hold this issuer’s tokens after it approves your account. Typical of regulated or private tokens.',
      tone: 'info',
    });
  }
  if (t.transferRate && t.transferRate > 0) {
    out.push({
      icon: 'coins',
      title: `${+t.transferRate.toFixed(4)}% transfer fee`,
      text: 'Every time someone sends this issuer’s tokens to someone else, this percentage is charged on top.',
      tone: 'warn',
    });
  }
  if (has(t.flags, F.DefaultRipple) && !t.isAmm) {
    out.push({
      icon: 'coins',
      title: 'Set up as a token issuer',
      text: 'Configured so its tokens can move freely between holders ("rippling" on).',
      tone: 'info',
    });
  }
  if (has(t.flags, F.DepositAuth)) {
    out.push({
      icon: 'shield',
      title: 'Only accepts approved senders',
      text: 'Incoming payments are blocked unless the sender has been pre-approved.',
      tone: 'info',
    });
  }
  if (has(t.flags, F.DisallowXRP)) {
    out.push({
      icon: 'info',
      title: 'Prefers not to receive XRP',
      text: 'The owner asked wallets not to send XRP here (a request, not a hard block).',
      tone: 'info',
    });
  }
  return out;
}
