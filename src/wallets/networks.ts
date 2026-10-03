/** Networks a managed wallet can live on. Pure data: the local server imports it too. */

export type NetworkId = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkInfo {
  id: NetworkId;
  name: string;
  /** WebSocket servers, tried in order. Mainnet reuses the explorer's own connection. */
  servers: string[];
  faucet?: string;
  explorer: string;
  /** Real money: keys are encrypted and every send asks for confirmation. */
  real: boolean;
}

export const NETWORKS: Record<NetworkId, NetworkInfo> = {
  mainnet: {
    id: 'mainnet',
    name: 'Mainnet',
    servers: ['wss://xrplcluster.com', 'wss://s2.ripple.com', 'wss://s1.ripple.com', 'wss://xrpl.ws'],
    explorer: 'https://livenet.xrpl.org',
    real: true,
  },
  testnet: {
    id: 'testnet',
    name: 'Testnet',
    servers: ['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com'],
    faucet: 'https://faucet.altnet.rippletest.net/accounts',
    explorer: 'https://testnet.xrpl.org',
    real: false,
  },
  devnet: {
    id: 'devnet',
    name: 'Devnet',
    servers: ['wss://s.devnet.rippletest.net:51233'],
    faucet: 'https://faucet.devnet.rippletest.net/accounts',
    explorer: 'https://devnet.xrpl.org',
    real: false,
  },
};

export const NETWORK_IDS: NetworkId[] = ['mainnet', 'testnet', 'devnet'];

export const isNetworkId = (s: unknown): s is NetworkId => typeof s === 'string' && s in NETWORKS;

export function explorerUrl(net: NetworkId, kind: 'account' | 'tx', id: string): string {
  return `${NETWORKS[net].explorer}/${kind === 'tx' ? 'transactions' : 'accounts'}/${id}`;
}
