// Data sources: geocoding, OSM features, elevation (Lantmäteriet 1 m or global 30 m), aerial imagery.
import type { LatLon, OsmData, OsmElement } from './geo';
import { call } from '../../rpc';

export type BBox = { s: number; w: number; n: number; e: number };
/** Elevation sampler in meters above sea level. */
export type Elevation = { at: (lat: number, lon: number) => number; source: 'lantmateriet' | 'terrarium'; resolution: number };
export type Imagery = { cv: HTMLCanvasElement; px: (lat: number, lon: number) => [number, number] };

/**
 * Whether the Lantmäteriet backend is available. Add `?nolm` to the URL to see the app exactly as it would run
 * without a backend (e.g. on GitHub Pages): global 30 m terrain, estimated trees and roofs.
 */
let lmEnabled = typeof location === 'undefined' || !new URLSearchParams(location.search).has('nolm');
/** Turn the Lantmäteriet data on/off (the UI's "Data" switch), to compare against what open data alone gives. */
export function setLantmaterietEnabled(on: boolean) { lmEnabled = on; }
export function lantmaterietEnabled() { return lmEnabled; }

async function lmStatus(): Promise<{ lantmateriet: boolean } | null> {
  if (!lmEnabled) return { lantmateriet: false };
  return call('lm.status', null).catch(() => null);
}

export async function geocode(q: string): Promise<[number, number, string]> {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return [+m[1], +m[2], `${(+m[1]).toFixed(4)}, ${(+m[2]).toFixed(4)}`];
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
  const j = await r.json();
  if (!j.length) throw new Error(`Couldn't find “${q}”. Try adding a region or country.`);
  return [+j[0].lat, +j[0].lon, j[0].display_name];
}

// ---------- OSM ----------

type RawOsm = { elements: (OsmElement & { nodes?: number[]; members?: { type: string; ref: number; role: string }[] })[] };

/** Main OSM API: fast and reliable for small areas (max 50k nodes). Converted to Overpass "out geom" shape. */
async function fetchOSMApi({ s, w, n, e }: BBox): Promise<OsmData> {
  const r = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`);
  if (!r.ok) throw new Error('OSM API ' + r.status);
  const j: RawOsm = await r.json();
  const nodes = new Map<number, LatLon>(), ways = new Map<number, LatLon[]>(), out: OsmElement[] = [];
  for (const el of j.elements) if (el.type === 'node') nodes.set(el.id, { lat: el.lat!, lon: el.lon! });
  for (const el of j.elements) if (el.type === 'way') {
    const geometry = (el.nodes ?? []).map(id => nodes.get(id)).filter((p): p is LatLon => !!p);
    ways.set(el.id, geometry);
    out.push({ type: 'way', id: el.id, tags: el.tags, geometry });
  }
  for (const el of j.elements) {
    if (el.type === 'node' && el.tags) out.push(el);
    if (el.type === 'relation') out.push({
      type: 'relation', id: el.id, tags: el.tags,
      members: (el.members ?? []).map(m => ({ ...m, geometry: m.type === 'way' ? ways.get(m.ref) : undefined })),
    });
  }
  return { elements: out };
}

export async function fetchOSM(b: BBox): Promise<OsmData> {
  try { return await fetchOSMApi(b); } catch (err) { console.warn('OSM API failed, trying Overpass', err); }
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  const q = `[out:json][timeout:90];(
    way["building"](${bb}); relation["building"](${bb});
    way["highway"](${bb}); way["railway"="rail"](${bb});
    way["natural"="water"](${bb}); relation["natural"="water"](${bb});
    way["waterway"](${bb});
    way["landuse"](${bb}); relation["landuse"](${bb});
    way["natural"~"^(wood|grassland|scrub|heath|wetland)$"](${bb}); relation["natural"~"^(wood|wetland)$"](${bb});
    way["leisure"~"^(park|pitch|garden)$"](${bb});
    node["natural"="tree"](${bb}); node["place"](${bb});
  );out geom;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!r.ok) throw new Error('The map data servers are busy right now (' + r.status + '). Try again in a minute.');
  return r.json();
}

// ---------- slippy-map tiles ----------

function tileMath(z: number) {
  const N = 2 ** z;
  const tx = (lon: number) => (lon + 180) / 360 * N;
  const ty = (lat: number) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N; };
  return { tx, ty };
}

/** Stitch the tiles covering a bbox into one canvas. */
async function stitchTiles(b: BBox, z: number, url: (z: number, x: number, y: number) => string, raw: boolean) {
  const { tx, ty } = tileMath(z);
  const x0 = Math.floor(tx(b.w)), x1 = Math.floor(tx(b.e)), y0 = Math.floor(ty(b.n)), y1 = Math.floor(ty(b.s));
  const cv = document.createElement('canvas');
  cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: raw })!;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push((async () => {
    const r = await fetch(url(z, x, y));
    if (!r.ok) throw new Error('Tile ' + r.status);
    const opts: ImageBitmapOptions = raw ? { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } : {};
    ctx.drawImage(await createImageBitmap(await r.blob(), opts), (x - x0) * 256, (y - y0) * 256);
  })());
  const res = await Promise.allSettled(jobs);
  if (res.every(r => r.status === 'rejected')) throw new Error('No tiles available');
  if (raw && res.some(r => r.status === 'rejected')) throw new Error('Some elevation tiles failed');
  return { cv, ctx, px: (lat: number, lon: number): [number, number] => [(tx(lon) - x0) * 256, (ty(lat) - y0) * 256] };
}

// ---------- elevation ----------

/** Global Terrarium tiles (AWS open data, ~30 m source resolution in Sweden). */
export async function fetchTerrarium(b: BBox): Promise<Elevation> {
  const { cv, ctx, px } = await stitchTiles(b, 14, (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, true);
  const W = cv.width, H = cv.height;
  const d = ctx.getImageData(0, 0, W, H).data, h = new Float32Array(W * H);
  for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  const grid = { data: h, W, H };
  return {
    source: 'terrarium', resolution: 30,
    at: (lat, lon) => { const [fx, fy] = px(lat, lon); return bilinear(grid, fx - 0.5, fy - 0.5); },
  };
}

type Grid = { data: Float32Array; W: number; H: number };
function bilinear({ data, W, H }: Grid, fx: number, fy: number) {
  const at = (i: number, j: number) => data[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
}

const SWEREF99TM = '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/** Lantmäteriet Markhöjdmodell (1 m DTM, Sweden only), read and cached server-side by /api/lm/dtm. */
export async function fetchLantmaterietDTM(b: BBox, R: number): Promise<Elevation> {
  const status = await lmStatus();
  if (!status?.lantmateriet) throw new Error('Lantmäteriet login not configured');
  const res = R <= 1000 ? 1 : 1.5; // meters per sample
  const [{ default: proj4 }, r] = await Promise.all([
    import('proj4'),
    fetch('/api/lm/dtm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bbox: [b.w, b.s, b.e, b.n], res }) }),
  ]);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Elevation ' + r.status);
  const info = JSON.parse(r.headers.get('X-Grid') ?? '{}') as { minE: number; maxN: number; res: number; W: number; H: number };
  const grid = { data: new Float32Array(await r.arrayBuffer()), W: info.W, H: info.H };
  const toTM = proj4('EPSG:4326', SWEREF99TM);
  return {
    source: 'lantmateriet', resolution: info.res,
    at: (lat, lon) => {
      const [E, N] = toTM.forward([lon, lat]);
      return bilinear(grid, (E - info.minE) / info.res - 0.5, (info.maxN - N) / info.res - 0.5);
    },
  };
}

/** Best available elevation: Lantmäteriet 1 m in Sweden when logged in, otherwise global 30 m. */
export async function fetchElevation(b: BBox, R: number): Promise<Elevation> {
  try { return await fetchLantmaterietDTM(b, R); } catch (e) { console.info('Using 30 m elevation:', (e as Error).message); }
  return fetchTerrarium(b);
}

// ---------- laser-measured trees ----------

/** [lon, lat, height m, crown radius m] */
export type LaserTree = [number, number, number, number];
export type LaserTrees = { trees: LaserTree[]; year: string };

/** Real trees detected server-side from Lantmäteriet forest laser data (Sweden + login only). */
export async function fetchLaserTrees(b: BBox): Promise<LaserTrees> {
  const status = await lmStatus();
  if (!status?.lantmateriet) throw new Error('Lantmäteriet login not configured');
  const j = await call('lm.trees', { bbox: [b.w, b.s, b.e, b.n] });
  return { trees: j.trees, year: j.year };
}

/** Height above ground (m) from the laser data, for measuring roofs. Nearest 1 m cell. */
export type Surface = { at: (lat: number, lon: number) => number };

export async function fetchSurface(b: BBox): Promise<Surface> {
  if (!(await lmStatus())?.lantmateriet) throw new Error('Lantmäteriet not available');
  const [{ default: proj4 }, r] = await Promise.all([
    import('proj4'),
    fetch('/api/lm/surface', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bbox: [b.w, b.s, b.e, b.n] }) }),
  ]);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Surface ' + r.status);
  const g = JSON.parse(r.headers.get('X-Grid') ?? '{}') as { minE: number; maxN: number; res: number; W: number; H: number };
  const data = new Uint16Array(await r.arrayBuffer());
  const toTM = proj4('EPSG:4326', SWEREF99TM);
  return {
    at: (lat, lon) => {
      const [E, N] = toTM.forward([lon, lat]);
      const x = Math.floor((E - g.minE) / g.res), y = Math.floor((g.maxN - N) / g.res);
      return x < 0 || y < 0 || x >= g.W || y >= g.H ? 0 : data[y * g.W + x] / 100;
    },
  };
}

// ---------- imagery ----------

/** Esri World Imagery aerial photos. */
export async function fetchImagery(b: BBox, R: number): Promise<Imagery> {
  const z = R <= 600 ? 18 : R <= 1000 ? 17 : 16;
  const { cv, px } = await stitchTiles(b, z, (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, false);
  return { cv, px };
}
