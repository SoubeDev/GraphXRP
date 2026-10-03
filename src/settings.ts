import type { EdgeType } from './xrpl/parse';
import type { NodeKind } from './graph/model';

export interface Settings {
  edgeTypes: Record<EdgeType, boolean>;
  kinds: Record<NodeKind, boolean>;
  /** Networks switched off in the legend (missing = shown). */
  chains: Record<string, boolean>;
  showStubs: boolean;
  showOrphans: boolean;
  currency: string;
  arrows: boolean;
  particles: boolean;
  labels: number;
  nodeSize: number;
  linkWidth: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  neighborLimit: number;
  theme: 'system' | 'dark' | 'light';
  server: string;
}

export const DEFAULTS: Settings = {
  edgeTypes: { payment: true, activation: true, trust: true, dex: true, control: true, crosschain: true, contract: true },
  kinds: { issuer: true, exchange: true, amm: true, bridge: true, contract: true, wallet: true, external: true, flagged: true, inactive: true },
  chains: {},
  showStubs: true,
  showOrphans: false,
  currency: '',
  arrows: true,
  particles: typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches,
  labels: 0.55,
  nodeSize: 1,
  linkWidth: 1,
  centerForce: 0.35,
  repelForce: 9,
  linkForce: 0.7,
  linkDistance: 55,
  neighborLimit: 40,
  theme: 'system',
  server: '',
};

const KEY = 'gx.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      ...DEFAULTS,
      ...raw,
      edgeTypes: { ...DEFAULTS.edgeTypes, ...raw.edgeTypes },
      kinds: { ...DEFAULTS.kinds, ...raw.kinds },
      chains: { ...raw.chains },
      currency: '',
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
