import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lmAuthHeader } from '@/lib/lantmateriet';
import { detectTrees } from '@/lib/trees';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'trees');

/** Real trees (position, height, crown) detected from Lantmäteriet forest laser data. Cached on disk per area. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const bbox = body?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) {
    return Response.json({ error: 'bbox [w,s,e,n] required' }, { status: 400 });
  }
  const [w, s, e, n] = bbox as number[];
  if (e - w > 0.08 || n - s > 0.05) return Response.json({ error: 'Area too large' }, { status: 400 });
  if (!lmAuthHeader()) return Response.json({ error: 'Add LM_USER and LM_PASS to .env.local' }, { status: 401 });

  const key = bbox.map((v: number) => v.toFixed(4)).join('_');
  const file = path.join(CACHE_DIR, key + '.json');
  try {
    return new Response(await readFile(file), { headers: { 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
  } catch { /* not cached yet */ }

  try {
    const t0 = Date.now();
    const result = await detectTrees([w, s, e, n]);
    const json = JSON.stringify({ ...result, ms: Date.now() - t0 });
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, json);
    return new Response(json, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
  } catch (err) {
    console.error('tree detection failed', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
