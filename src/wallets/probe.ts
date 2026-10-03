/** Is the local wallet API here? It only exists on the dev/preview server, never on the static site. */
export async function hasWalletApi(): Promise<boolean> {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return false;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return false;
    return ((await res.json()) as { app?: string }).app === 'graphxrp';
  } catch {
    return false;
  }
}
