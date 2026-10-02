/** Amount parsing, currency-code decoding and human-friendly number formatting. */

export interface Amt {
  value: number;
  currency: string; // human-readable code
  issuer?: string;
  isXrp: boolean;
}

const RIPPLE_EPOCH = 946684800;

export const rippleTimeToMs = (t: number) => (t + RIPPLE_EPOCH) * 1000;

export function parseAmount(a: unknown): Amt | null {
  if (a == null) return null;
  if (typeof a === 'string' || typeof a === 'number') {
    const drops = Number(a);
    if (!Number.isFinite(drops)) return null;
    return { value: drops / 1e6, currency: 'XRP', isXrp: true };
  }
  if (typeof a === 'object') {
    const o = a as Record<string, string>;
    if (o.mpt_issuance_id) return { value: Number(o.value), currency: 'MPT', isXrp: false };
    if (o.currency) {
      if (o.currency === 'XRP') return { value: Number(o.value ?? 0), currency: 'XRP', isXrp: true };
      return { value: Number(o.value), currency: decodeCurrency(o.currency), issuer: o.issuer, isXrp: false };
    }
  }
  return null;
}

const hexDecoder = new TextDecoder('utf-8', { fatal: true });

export function decodeCurrency(code: string): string {
  if (!code) return '?';
  if (code.length <= 3) return code;
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    if (code.startsWith('03')) return 'LP token';
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) bytes[i] = parseInt(code.slice(i * 2, i * 2 + 2), 16);
    if (bytes[0] === 0) {
      // Standard currency code stored in hex form (bytes 12..14).
      const s = String.fromCharCode(bytes[12], bytes[13], bytes[14]);
      if (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(s)) return s;
    }
    try {
      const s = hexDecoder.decode(bytes).replace(/\0+$/g, '').replace(/^\0+/g, '');
      if (s && !/[\u0000-\u001f�]/.test(s)) return s;
    } catch {
      /* not utf-8 */
    }
    return code.slice(0, 6) + '…';
  }
  return code;
}

export function hexToAscii(hex: string): string {
  try {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const sig = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e6) return compact.format(v);
  if (abs >= 1000) return whole.format(v);
  if (abs >= 1) return two.format(v);
  return sig.format(v);
}

export const fmtAmt = (a: Amt) => `${fmtNum(a.value)} ${a.currency}`;

export function fmtXrp(v: number | undefined): string {
  return v == null ? '—' : `${fmtNum(v)} XRP`;
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

export function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  const y = s / (86400 * 365);
  return `${y < 10 ? y.toFixed(1).replace(/\.0$/, '') : Math.floor(y)}y ago`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtAge(ms: number): string {
  const days = (Date.now() - ms) / 86400000;
  if (days < 1) return 'less than a day';
  if (days < 60) return `${Math.floor(days)} days`;
  if (days < 730) return `${Math.floor(days / 30)} months`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')} years`;
}

const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export const isAddress = (s: string) => ADDR_RE.test(s);
export const isTxHash = (s: string) => /^[0-9A-Fa-f]{64}$/.test(s);
