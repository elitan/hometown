// Server-side only (used by route handlers). Lantmäteriet (Geotorget) credentials come from .env.local
// and are never sent to the browser.
export function lmAuthHeader(): string | null {
  const user = process.env.LM_USER, pass = process.env.LM_PASS;
  if (!user || !pass) return null;
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export const LM_STAC = 'https://api.lantmateriet.se/stac-hojd/v1';
export const LM_DOWNLOAD = 'https://dl1.lantmateriet.se/';

/**
 * fetch with retries: Lantmäteriet's download server resets connections (ECONNRESET) or answers 429/5xx
 * when it gets many parallel range requests. One dropped request shouldn't sink a whole map load.
 */
export async function fetchRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status !== 429 && r.status < 500) return r;
      lastErr = new Error(`HTTP ${r.status}`);
      await r.body?.cancel();
    } catch (e) {
      lastErr = e;
    }
    await new Promise(res => setTimeout(res, 300 * 2 ** i + Math.random() * 200));
  }
  throw lastErr;
}

/** Like fetchRetry, but also retries if the connection drops while reading the body. */
export async function fetchBytesRetry(url: string, init: RequestInit, attempts = 4): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchRetry(url, init, 2);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 300 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}
