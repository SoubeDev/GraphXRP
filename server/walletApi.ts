/**
 * Local wallet store for GraphXRP, mounted into the Vite dev and preview servers.
 * The static build has none of this, so the public site never offers wallets.
 *
 *   GET /api/health          is the wallet store available here?
 *   GET /api/store           the whole store (used by the UI)
 *   PUT /api/store           replace it: { rev, store }; 409 if another tab saved first
 *   GET /api/wallets         wallets for scripts and tests (?network=testnet&group=foo&q=alice)
 *   GET /api/wallets/:key    one wallet by label (case-insensitive), address or id
 *
 * Test-network secrets are kept in clear text so scripts can use them. Mainnet
 * secrets arrive already encrypted with the vault password (the browser does
 * that); this server refuses a mainnet wallet carrying a readable secret, and the
 * scripts API never returns mainnet secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { NETWORKS, isNetworkId } from '../src/wallets/networks.ts';
import { SECRET_FIELDS, type StoreData, type StoredWallet } from '../src/wallets/types.ts';

const STORE_PATH = path.resolve(process.env.GRAPHXRP_WALLETS ?? path.join(process.cwd(), 'data', 'wallets.json'));
const MAX_BODY = 20 * 1024 * 1024;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

interface FileShape extends StoreData {
  rev: number;
}

function readFile(): FileShape | null {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as FileShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function writeFile(data: FileShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

/** Why a store can't be saved, or null if it's fine. */
function invalid(v: unknown): string | null {
  const s = v as StoreData;
  if (!s || typeof s !== 'object' || s.version !== 2 || !Array.isArray(s.wallets)) return 'Not a GraphXRP wallet store';
  for (const w of s.wallets) {
    if (!w || typeof w.id !== 'string' || typeof w.address !== 'string' || typeof w.label !== 'string') return 'A wallet is missing its id, label or address';
    if (!isNetworkId(w.networkId)) return `Unknown network "${String(w.networkId)}"`;
    if (w.networkId === 'mainnet' && SECRET_FIELDS.some((f) => w[f])) return `Refusing to save a readable mainnet secret (${w.label}). Mainnet keys must be encrypted.`;
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
}

/** Shape returned to scripts: flat, network inlined (compatible with XRPL Wallet Manager). */
function publicWallet(w: StoredWallet) {
  const net = NETWORKS[w.networkId];
  const sealed = w.networkId === 'mainnet';
  return {
    id: w.id,
    label: w.label,
    address: w.address,
    group: w.group ?? null,
    watchOnly: !!w.watchOnly,
    algorithm: w.algorithm ?? null,
    publicKey: w.publicKey ?? null,
    encrypted: sealed && !!w.sealed,
    seed: sealed ? null : (w.seed ?? null),
    mnemonic: sealed ? null : (w.mnemonic ?? null),
    secretNumbers: sealed ? null : (w.secretNumbers ?? null),
    privateKey: sealed ? null : (w.privateKey ?? null),
    network: { id: net.id, name: net.name, url: net.servers[0] },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return next();

  // This machine only: loopback connections, a local Host (no DNS rebinding) and, for browsers, a local page.
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return send(res, 403, { error: 'Wallet API is only available on this machine' });
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, { error: 'Host not allowed' });
  const origin = req.headers.origin;
  if (origin) {
    if (!LOCAL_ORIGIN.test(origin)) return send(res, 403, { error: 'Origin not allowed' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, app: 'graphxrp', storePath: STORE_PATH });

    if (url.pathname === '/api/store') {
      if (req.method === 'GET') {
        const file = readFile();
        return send(res, 200, { rev: file?.rev ?? 0, store: file ? { version: file.version, wallets: file.wallets, vault: file.vault } : null, path: STORE_PATH });
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { rev?: number; store?: unknown };
        const why = invalid(body.store);
        if (why) return send(res, 400, { error: why });
        const current = readFile()?.rev ?? 0;
        if (body.rev !== current) return send(res, 409, { error: 'The wallet store changed in another tab', rev: current });
        const { version, wallets, vault } = body.store as StoreData;
        writeFile({ version, rev: current + 1, wallets, vault });
        return send(res, 200, { rev: current + 1 });
      }
      return send(res, 405, { error: 'Method not allowed' });
    }

    if (url.pathname === '/api/wallets' || url.pathname.startsWith('/api/wallets/')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      let wallets = readFile()?.wallets ?? [];
      const network = url.searchParams.get('network');
      const group = url.searchParams.get('group');
      const q = url.searchParams.get('q')?.toLowerCase();
      if (network) wallets = wallets.filter((w) => w.networkId === network);
      if (group) wallets = wallets.filter((w) => (w.group ?? '').toLowerCase() === group.toLowerCase());
      if (q) wallets = wallets.filter((w) => w.label.toLowerCase().includes(q) || w.address.toLowerCase().includes(q));

      const key = decodeURIComponent(url.pathname.slice('/api/wallets/'.length));
      if (key) {
        const k = key.toLowerCase();
        const match = wallets.find((w) => w.id === key || w.address === key) ?? wallets.find((w) => w.label.toLowerCase() === k);
        return match ? send(res, 200, publicWallet(match)) : send(res, 404, { error: `No wallet matching "${key}"` });
      }
      return send(res, 200, wallets.map(publicWallet));
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 500, { error: (err as Error).message });
  }
}

export function walletApi(): Plugin {
  return {
    name: 'graphxrp-wallet-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
    },
  };
}
