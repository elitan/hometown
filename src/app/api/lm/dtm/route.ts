import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readDtm } from '@/lib/dtm';
import { lmAuthHeader } from '@/lib/lantmateriet';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'dtm');

/**
 * 1 m terrain for a bbox as raw little-endian Float32 (row 0 = north), grid info in the X-Grid header.
 * Cached on disk per area, so a place loads instantly the second time.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const bbox = body?.bbox, res = Number(body?.res ?? 1);
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) {
    return Response.json({ error: 'bbox [w,s,e,n] required' }, { status: 400 });
  }
  const [w, s, e, n] = bbox as number[];
  if (e - w > 0.08 || n - s > 0.05 || !(res >= 1 && res <= 5)) return Response.json({ error: 'Area too large' }, { status: 400 });
  if (!lmAuthHeader()) return Response.json({ error: 'Add LM_USER and LM_PASS to .env.local' }, { status: 401 });

  const key = bbox.map((v: number) => v.toFixed(4)).join('_') + '_r' + res;
  const bin = path.join(CACHE_DIR, key + '.f32'), meta = path.join(CACHE_DIR, key + '.json');
  try {
    const [data, info] = await Promise.all([readFile(bin), readFile(meta, 'utf8')]);
    return new Response(new Uint8Array(data), { headers: { 'Content-Type': 'application/octet-stream', 'X-Grid': info, 'X-Cache': 'hit' } });
  } catch { /* not cached yet */ }

  try {
    const g = await readDtm([w, s, e, n], res);
    const info = JSON.stringify({ minE: g.minE, maxN: g.maxN, res: g.res, W: g.W, H: g.H });
    const buf = new Uint8Array(g.data.buffer, g.data.byteOffset, g.data.byteLength);
    await mkdir(CACHE_DIR, { recursive: true });
    await Promise.all([writeFile(bin, buf), writeFile(meta, info)]);
    return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'application/octet-stream', 'X-Grid': info, 'X-Cache': 'miss' } });
  } catch (err) {
    console.error('dtm failed', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
