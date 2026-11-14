// Server-side: one laser processing run per area, cached on disk as two products —
// detected trees (JSON) and the height-above-ground grid (raw Uint16, cm) used to measure roofs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectTrees, type Tree } from './trees';
import { lmAuthHeader } from './lantmateriet';

const DIR = path.join(process.cwd(), '.cache', 'laser');
export type GridInfo = { minE: number; maxN: number; res: number; W: number; H: number };
export type LaserResult = { trees: { trees: Tree[]; points: number; year: string; ms: number }; info: GridInfo; surface: Uint8Array };

const inflight = new Map<string, Promise<LaserResult>>();

export function laserKey(bbox: number[]) { return bbox.map(v => v.toFixed(4)).join('_'); }

async function readCached(key: string): Promise<LaserResult | null> {
  try {
    const [trees, info, surface] = await Promise.all([
      readFile(path.join(DIR, key + '.trees.json'), 'utf8'),
      readFile(path.join(DIR, key + '.surface.json'), 'utf8'),
      readFile(path.join(DIR, key + '.surface.u16')),
    ]);
    return { trees: JSON.parse(trees), info: JSON.parse(info), surface: new Uint8Array(surface) };
  } catch { return null; }
}

/** Trees + surface for a bbox, from cache or by processing the laser data once (concurrent callers share the run). */
export async function getLaser(bbox: [number, number, number, number]): Promise<LaserResult> {
  const key = laserKey(bbox);
  const cached = await readCached(key);
  if (cached) return cached;
  if (!inflight.has(key)) inflight.set(key, (async () => {
    try {
      const t0 = Date.now();
      const r = await detectTrees(bbox);
      const trees = { trees: r.trees, points: r.points, year: r.year, ms: Date.now() - t0 };
      const { data, ...info } = r.surface;
      const surface = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      await mkdir(DIR, { recursive: true });
      await Promise.all([
        writeFile(path.join(DIR, key + '.trees.json'), JSON.stringify(trees)),
        writeFile(path.join(DIR, key + '.surface.json'), JSON.stringify(info)),
        writeFile(path.join(DIR, key + '.surface.u16'), surface),
      ]);
      return { trees, info, surface };
    } finally { inflight.delete(key); }
  })());
  return inflight.get(key)!;
}

/** Validate a POST body `{ bbox: [w, s, e, n] }` (small areas only, login required). */
export async function parseBbox(request: Request): Promise<[number, number, number, number] | Response> {
  const body = await request.json().catch(() => null);
  const bbox = body?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) {
    return Response.json({ error: 'bbox [w,s,e,n] required' }, { status: 400 });
  }
  const [w, s, e, n] = bbox as number[];
  if (e - w > 0.08 || n - s > 0.05) return Response.json({ error: 'Area too large' }, { status: 400 });
  if (!lmAuthHeader()) return Response.json({ error: 'Add LM_USER and LM_PASS to .env.local' }, { status: 401 });
  return [w, s, e, n];
}
