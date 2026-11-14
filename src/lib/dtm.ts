// Server-side: read Lantmäteriet's 1 m terrain model (COG) for a bbox into one Float32 grid.
// Only the needed window of each 10 km tile is downloaded (HTTP range requests).
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import { LM_DOWNLOAD, LM_STAC, lmAuthHeader } from './lantmateriet';

const SWEREF99TM = '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const toTM = proj4('EPSG:4326', SWEREF99TM);

/** Grid in SWEREF 99 TM: row 0 is the north edge (maxN), column 0 the west edge (minE). */
export type DtmGrid = { minE: number; maxN: number; res: number; W: number; H: number; data: Float32Array };

async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let err: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 400 * 2 ** i)); }
  }
  throw err;
}

export async function readDtm(bbox: [number, number, number, number], res: number): Promise<DtmGrid> {
  const auth = lmAuthHeader();
  if (!auth) throw new Error('No Lantmäteriet login');
  const [w, s, e, n] = bbox;
  const corners = [[w, s], [w, n], [e, s], [e, n]].map(c => toTM.forward(c as [number, number]));
  const minE = Math.min(...corners.map(c => c[0])), maxE = Math.max(...corners.map(c => c[0]));
  const minN = Math.min(...corners.map(c => c[1])), maxN = Math.max(...corners.map(c => c[1]));

  const search = await fetch(`${LM_STAC}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox, collections: ['dtm-cog'], limit: 20 }),
  }).then(r => r.json());
  const hrefs: string[] = (search.features ?? []).map((f: { assets: { data: { href: string } } }) => f.assets.data.href)
    .filter((h: string) => h.startsWith(LM_DOWNLOAD));
  if (!hrefs.length) throw new Error('No Lantmäteriet elevation for this area');

  const W = Math.ceil((maxE - minE) / res), H = Math.ceil((maxN - minN) / res);
  const data = new Float32Array(W * H).fill(NaN);

  await Promise.all(hrefs.map(href => retry(async () => {
    const tiff = await fromUrl(href, { headers: { Authorization: auth }, allowFullFile: false });
    const img = await tiff.getImage();
    const [bx0, by0, bx1, by1] = img.getBoundingBox();
    const pr = (bx1 - bx0) / img.getWidth();
    const ix0 = Math.max(minE, bx0), ix1 = Math.min(maxE, bx1), iy0 = Math.max(minN, by0), iy1 = Math.min(maxN, by1);
    if (ix0 >= ix1 || iy0 >= iy1) return;
    const win = [Math.floor((ix0 - bx0) / pr), Math.floor((by1 - iy1) / pr), Math.ceil((ix1 - bx0) / pr), Math.ceil((by1 - iy0) / pr)];
    const outW = Math.max(1, Math.round((ix1 - ix0) / res)), outH = Math.max(1, Math.round((iy1 - iy0) / res));
    const rasters = await img.readRasters({ window: win, width: outW, height: outH, samples: [0] });
    const band = (rasters as unknown as ArrayLike<number>[])[0];
    const noData = img.getGDALNoData();
    const gx0 = Math.round((ix0 - minE) / res), gy0 = Math.round((maxN - iy1) / res);
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
      const gx = gx0 + x, gy = gy0 + y;
      if (gx >= W || gy >= H) continue;
      const v = band[y * outW + x];
      if (v !== noData && v > -1000) data[gy * W + gx] = v;
    }
  })));

  let valid = 0;
  for (let i = 0; i < data.length; i++) if (!Number.isNaN(data[i])) valid++;
  if (valid < data.length * 0.5) throw new Error('Lantmäteriet elevation mostly missing here');
  fillGaps(data, W, H);
  return { minE, maxN, res, W, H, data };
}

/** Fill nodata/tile seams with the nearest valid value along rows, then columns. */
function fillGaps(d: Float32Array, W: number, H: number) {
  for (let pass = 0; pass < 2; pass++) {
    const [outer, inner, idx] = pass === 0
      ? [H, W, (o: number, i: number) => o * W + i]
      : [W, H, (o: number, i: number) => i * W + o];
    for (let o = 0; o < outer; o++) {
      let last = NaN;
      for (let i = 0; i < inner; i++) { const k = idx(o, i); if (Number.isNaN(d[k])) { if (!Number.isNaN(last)) d[k] = last; } else last = d[k]; }
      last = NaN;
      for (let i = inner - 1; i >= 0; i--) { const k = idx(o, i); if (Number.isNaN(d[k])) { if (!Number.isNaN(last)) d[k] = last; } else last = d[k]; }
    }
  }
}
