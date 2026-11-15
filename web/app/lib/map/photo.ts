// Paint out what the aerial photo already shows in 2D where the map draws it in 3D: roofs (which lean and
// sit off their footprints in the photo), tree crowns, and the dark shadows they cast. Otherwise every house
// and tree appears twice, and photo shadows pile on top of the real-time ones.
//
// Holes are filled with a pull-push fill (average of the surrounding ground at ever coarser scales), which
// turns a lone tree in a field into field and a house in a garden into lawn. In dense forest the photo's
// canopy is kept, lightly brightened, because it reads as forest floor between the 3D trees.
import type { Poly, XY } from './geo';

export type Crown = { x: number; y: number; h: number; r: number };

const N = 2048; // working resolution (about 1 m per pixel for a 2 km map)

function canvas(size: number) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  return [c, c.getContext('2d', { willReadFrequently: true })!] as const;
}

export function cleanPhoto(target: HTMLCanvasElement, R: number, footprints: Poly[], crowns: Crown[]) {
  const k = N / (2 * R);
  const px = ([x, y]: XY) => [(x + R) * k, (R - y) * k] as const;
  const trace = (ctx: CanvasRenderingContext2D, ring: XY[]) =>
    ring.forEach((p, i) => { const [a, b] = px(p); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
  const drawFootprints = (ctx: CanvasRenderingContext2D, margin: number) => {
    ctx.beginPath();
    for (const p of footprints) { trace(ctx, p.outer); ctx.closePath(); }
    ctx.fill();
    ctx.lineWidth = 2 * margin * k; ctx.lineJoin = 'round'; ctx.stroke();
  };
  const drawCrowns = (ctx: CanvasRenderingContext2D, grow: (c: Crown) => number) => {
    ctx.beginPath();
    for (const c of crowns) { const [a, b] = px([c.x, c.y]); ctx.moveTo(a + grow(c) * k, b); ctx.arc(a, b, grow(c) * k, 0, Math.PI * 2); }
    ctx.fill();
  };

  // what to replace: roofs (with a margin for lean and eaves) and crowns
  const [crownCv, crownCtx] = canvas(N);
  crownCtx.fillStyle = '#000';
  drawCrowns(crownCtx, c => c.r * 1.05 + 0.6);
  const [, hardCtx] = canvas(N);
  hardCtx.fillStyle = hardCtx.strokeStyle = '#000';
  hardCtx.drawImage(crownCv, 0, 0);
  drawFootprints(hardCtx, 1.6);
  // where their shadows can fall
  const [, nearCtx] = canvas(N);
  nearCtx.fillStyle = nearCtx.strokeStyle = '#000';
  drawCrowns(nearCtx, c => c.r + 0.6 * c.h + 2);
  drawFootprints(nearCtx, 7);

  // the photo at working resolution, and its local brightness (about 25 m around each pixel)
  const [work, wctx] = canvas(N);
  wctx.drawImage(target, 0, 0, N, N);
  const img = wctx.getImageData(0, 0, N, N), src = img.data;
  const M = N >> 3;
  const [, mctx] = canvas(M);
  mctx.filter = 'blur(3px)'; mctx.drawImage(target, 0, 0, M, M);
  const mean = mctx.getImageData(0, 0, M, M).data;
  // how much of the neighbourhood is canopy (dense forest keeps its photo)
  const [, dctx] = canvas(M);
  dctx.filter = 'blur(2px)'; dctx.drawImage(crownCv, 0, 0, M, M);
  const dense = dctx.getImageData(0, 0, M, M).data;

  const hard = hardCtx.getImageData(0, 0, N, N).data, near = nearCtx.getImageData(0, 0, N, N).data;
  const luma = (d: Uint8ClampedArray, o: number) => 0.3 * d[o] + 0.59 * d[o + 1] + 0.11 * d[o + 2];
  let mask = new Uint8Array(N * N), any = false;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, o = i * 4;
    if (hard[o + 3] > 64) { mask[i] = 1; any = true; continue; }
    if (near[o + 3] < 64) continue;
    const L = luma(src, o), m = luma(mean, ((y >> 3) * M + (x >> 3)) * 4);
    if (L < 0.7 * m && L < 95) { mask[i] = 1; any = true; } // a shadow next to a house or tree
  }
  if (!any) return;
  // grow by a pixel to take the soft edges of roofs and shadows too
  const grown = new Uint8Array(N * N);
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    grown[i] = mask[i] | mask[i - 1] | mask[i + 1] | mask[i - N] | mask[i + N];
  }
  mask = grown;

  // pull: average the kept pixels at ever coarser levels
  type Level = { n: number; c: Float32Array; a: Float32Array };
  const levels: Level[] = [];
  {
    const n = N >> 1, c = new Float32Array(n * n * 3), a = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, w = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = (2 * y + dy) * N + 2 * x + dx;
        if (mask[i]) continue;
        r += src[i * 4]; g += src[i * 4 + 1]; b += src[i * 4 + 2]; w++;
      }
      const j = y * n + x;
      if (w) { c[j * 3] = r / w; c[j * 3 + 1] = g / w; c[j * 3 + 2] = b / w; }
      a[j] = Math.min(1, w);
    }
    levels.push({ n, c, a });
  }
  while (levels[levels.length - 1].n > 1) {
    const f = levels[levels.length - 1], n = f.n >> 1, c = new Float32Array(n * n * 3), a = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, w = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = (2 * y + dy) * f.n + 2 * x + dx, ai = f.a[i];
        r += f.c[i * 3] * ai; g += f.c[i * 3 + 1] * ai; b += f.c[i * 3 + 2] * ai; w += ai;
      }
      const j = y * n + x;
      if (w > 0) { c[j * 3] = r / w; c[j * 3 + 1] = g / w; c[j * 3 + 2] = b / w; }
      a[j] = Math.min(1, w);
    }
    levels.push({ n, c, a });
  }
  // push: fill each level's gaps from the (smoothly upsampled) level above
  const up = (l: Level, x: number, y: number, n: number, out: number[]) => {
    const s = l.n / n, fx = Math.max(0, Math.min(l.n - 1, (x + 0.5) * s - 0.5)), fy = Math.max(0, Math.min(l.n - 1, (y + 0.5) * s - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(l.n - 1, x0 + 1), y1 = Math.min(l.n - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    for (let ch = 0; ch < 3; ch++) {
      const v = (xx: number, yy: number) => l.c[(yy * l.n + xx) * 3 + ch];
      out[ch] = (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
    }
  };
  const tmp = [0, 0, 0];
  for (let li = levels.length - 2; li >= 0; li--) {
    const l = levels[li], parent = levels[li + 1];
    for (let y = 0; y < l.n; y++) for (let x = 0; x < l.n; x++) {
      const j = y * l.n + x, a = l.a[j];
      if (a >= 1) continue;
      up(parent, x, y, l.n, tmp);
      for (let ch = 0; ch < 3; ch++) l.c[j * 3 + ch] = l.c[j * 3 + ch] * a + tmp[ch] * (1 - a);
    }
  }

  // write the filled pixels (only those) and lay them over the full-resolution photo
  const out = new ImageData(N, N), od = out.data;
  const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (!mask[i]) continue;
    up(levels[0], x, y, N, tmp);
    const o = i * 4, d = smooth((dense[((y >> 3) * M + (x >> 3)) * 4 + 3] / 255 - 0.55) / 0.3);
    for (let ch = 0; ch < 3; ch++) od[o + ch] = tmp[ch] * (1 - d) + Math.min(255, src[o + ch] * 1.12 + 6) * d;
    od[o + 3] = 255;
  }
  wctx.putImageData(out, 0, 0);
  const ctx = target.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(work, 0, 0, target.width, target.height);
}
