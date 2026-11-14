// Server-side: detect individual trees from Lantmäteriet "Laserdata Skog" point clouds (COPC).
// Points -> 1 m ground + canopy-top grids -> canopy height model -> local maxima = tree tops.
import { Copc, type Getter, type Hierarchy } from 'copc';
import proj4 from 'proj4';
import { LM_DOWNLOAD, LM_STAC, fetchBytesRetry, lmAuthHeader } from './lantmateriet';

const SWEREF99TM = '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const toTM = proj4('EPSG:4326', SWEREF99TM);

/** [lon, lat, height m, crown radius m] */
export type Tree = [number, number, number, number];
type Box = { x0: number; y0: number; x1: number; y1: number };

const CLASS_GROUND = 2;
const CANOPY_CLASSES = new Set([0, 1, 3, 4, 5]); // unclassified + vegetation (Lantmäteriet puts vegetation in class 1)
const RES = 1; // grid meters

function authGetter(url: string, auth: string): Getter {
  return (begin, end) => fetchBytesRetry(url, { headers: { Authorization: auth, Range: `bytes=${begin}-${end - 1}` } });
}

/** Bounds of an octree node key "D-X-Y-Z" inside the COPC cube. */
function nodeBox(key: string, cube: number[]): Box {
  const [d, x, y] = key.split('-').map(Number);
  const size = (cube[3] - cube[0]) / 2 ** d;
  return { x0: cube[0] + x * size, y0: cube[1] + y * size, x1: cube[0] + (x + 1) * size, y1: cube[1] + (y + 1) * size };
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

async function nodesInArea(getter: Getter, copc: Copc, area: Box) {
  const out: Hierarchy.Node[] = [];
  const visit = async (page: Hierarchy.Page) => {
    const sub = await Copc.loadHierarchyPage(getter, page);
    for (const [k, n] of Object.entries(sub.nodes)) if (n && n.pointCount && overlaps(nodeBox(k, copc.info.cube), area)) out.push(n);
    await Promise.all(Object.entries(sub.pages).filter(([k, p]) => p && overlaps(nodeBox(k, copc.info.cube), area)).map(([, p]) => visit(p!)));
  };
  await visit(copc.info.rootHierarchyPage);
  return out;
}

/** Run fn over items with at most n in flight; a new one starts as soon as any finishes. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Latest laser tile for each 2.5 km square covering the bbox. */
async function laserTiles(bbox: [number, number, number, number]) {
  const r = await fetch(`${LM_STAC}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox, collections: ['dsm-skoglig-copc'], limit: 50 }),
  });
  const j = await r.json();
  const latest = new Map<string, { href: string; date: string }>();
  for (const f of j.features ?? []) {
    const square = String(f.id).split('-').slice(1).join('-');
    const date = f.properties?.datetime ?? '';
    if (!latest.has(square) || latest.get(square)!.date < date) latest.set(square, { href: f.assets.data.href, date });
  }
  return [...latest.values()];
}

/** Height above ground (nDSM) in centimetres on a 1 m SWEREF 99 TM grid, row 0 = north. 0 = ground / no hit. */
export type Surface = { minE: number; maxN: number; res: number; W: number; H: number; data: Uint16Array };

export async function detectTrees(bbox: [number, number, number, number]): Promise<{ trees: Tree[]; points: number; year: string; surface: Surface }> {
  const auth = lmAuthHeader();
  if (!auth) throw new Error('No Lantmäteriet login');
  const [w, s, e, n] = bbox;
  const corners = [[w, s], [w, n], [e, s], [e, n]].map(c => toTM.forward(c as [number, number]));
  const area: Box = {
    x0: Math.min(...corners.map(c => c[0])), x1: Math.max(...corners.map(c => c[0])),
    y0: Math.min(...corners.map(c => c[1])), y1: Math.max(...corners.map(c => c[1])),
  };
  const W = Math.ceil((area.x1 - area.x0) / RES), H = Math.ceil((area.y1 - area.y0) / RES);
  const ground = new Float32Array(W * H).fill(Infinity);
  const top = new Float32Array(W * H).fill(-Infinity);

  const T0 = performance.now();
  const tiles = await laserTiles(bbox);
  if (!tiles.length) throw new Error('No laser data for this area');
  let points = 0;
  // open all tiles and list their nodes in parallel, then stream every node through one download pool
  const jobs = (await Promise.all(tiles.filter(t => t.href.startsWith(LM_DOWNLOAD)).map(async t => {
    const getter = authGetter(t.href, auth);
    const copc = await Copc.create(getter);
    const nodes = await nodesInArea(getter, copc, area);
    return nodes.map(node => ({ getter, copc, node }));
  }))).flat();
  {
    await pool(jobs, 16, async ({ getter, copc, node }) => {
      const view = await Copc.loadPointDataView(getter, copc, node, { include: ['X', 'Y', 'Z', 'Classification'] });
      const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z'), gc = view.getter('Classification');
      for (let i = 0; i < view.pointCount; i++) {
        const x = gx(i), y = gy(i);
        if (x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1) continue;
        const k = Math.floor((area.y1 - y) / RES) * W + Math.floor((x - area.x0) / RES);
        const z = gz(i), c = gc(i);
        if (c === CLASS_GROUND) { if (z < ground[k]) ground[k] = z; }
        else if (CANOPY_CLASSES.has(c)) { if (z > top[k]) top[k] = z; }
        points++;
      }
    });
  }

  // fill ground gaps (under dense canopy / buildings) from neighbours, coarse to fine
  fillGround(ground, W, H);

  // canopy height model, lightly smoothed so one crown gives one peak
  const chm = new Float32Array(W * H);
  for (let k = 0; k < chm.length; k++) chm[k] = top[k] > -Infinity && ground[k] < Infinity ? Math.max(0, top[k] - ground[k]) : 0;
  const sm = blur3(chm, W, H);

  // local maxima with a height-dependent search window = tree tops
  const trees: Tree[] = [];
  for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) {
    const k = y * W + x, h = sm[k];
    if (h < 3 || h > 45) continue;
    const r = h < 8 ? 2 : h < 16 ? 3 : 4;
    let peak = true;
    for (let dy = -r; dy <= r && peak; dy++) for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy || dx * dx + dy * dy > r * r) continue;
      const v = sm[k + dy * W + dx];
      if (v > h || (v === h && dy * W + dx < 0)) { peak = false; break; }
    }
    if (!peak) continue;
    const [lon, lat] = toTM.inverse([area.x0 + (x + 0.5) * RES, area.y1 - (y + 0.5) * RES]);
    const height = chm[k] || h;
    const crown = Math.min(5.5, Math.max(1.2, 0.8 + 0.11 * height));
    trees.push([+lon.toFixed(6), +lat.toFixed(6), +height.toFixed(1), +crown.toFixed(1)]);
  }
  console.log(`[trees] ${points} points -> ${trees.length} trees in ${Math.round(performance.now() - T0)} ms`);
  // keep the raw (unsmoothed) height-above-ground grid too: roofs are measured from it
  const cm = new Uint16Array(W * H);
  for (let k = 0; k < cm.length; k++) cm[k] = Math.min(65535, Math.round(chm[k] * 100));
  const surface: Surface = { minE: area.x0, maxN: area.y1, res: RES, W, H, data: cm };
  return { trees, points, year: tiles.map(t => t.date.slice(0, 4)).sort().pop() ?? '', surface };
}

function blur3(a: Float32Array, W: number, H: number) {
  const out = new Float32Array(a.length);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const k = y * W + x;
    out[k] = (4 * a[k] + 2 * (a[k - 1] + a[k + 1] + a[k - W] + a[k + W]) + a[k - W - 1] + a[k - W + 1] + a[k + W - 1] + a[k + W + 1]) / 16;
  }
  return out;
}

function fillGround(g: Float32Array, W: number, H: number) {
  for (let pass = 0; pass < 2; pass++) {
    const [outer, inner, idx] = pass === 0
      ? [H, W, (o: number, i: number) => o * W + i]
      : [W, H, (o: number, i: number) => i * W + o];
    for (let o = 0; o < outer; o++) {
      let last = Infinity;
      for (let i = 0; i < inner; i++) { const k = idx(o, i); if (g[k] === Infinity) { if (last < Infinity) g[k] = last; } else last = g[k]; }
      last = Infinity;
      for (let i = inner - 1; i >= 0; i--) { const k = idx(o, i); if (g[k] === Infinity) { if (last < Infinity) g[k] = last; } else last = g[k]; }
    }
  }
}
