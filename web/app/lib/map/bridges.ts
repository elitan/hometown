// Bridges: the 1 m terrain is bare earth (bridges removed), so roads/rails tagged bridge=* get a real deck
// spanning between their two ends, with railings and, for longer spans, supports down to the ground.
import * as THREE from 'three';
import type { XY } from './geo';

type Height = (x: number, y: number) => number;
/** `under`: true when the deck carries a road over an underpass (no piers: the road below runs there). */
export type Bridge = { pts: XY[]; width: number; rail: boolean; under?: boolean };

/** Deck height at both ends: the higher of the end point and a few meters beyond it (the solid bank). */
export function deckEnds(pts: XY[], H: Height): [number, number] {
  const end = (p: XY, q: XY) => {
    const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1;
    return Math.max(H(p[0], p[1]), H(p[0] + dx / l * 4, p[1] + dy / l * 4));
  };
  return [end(pts[0], pts[1]), end(pts[pts.length - 1], pts[pts.length - 2])];
}

/** Height of the deck surface at fraction t (0..1) along the bridge: straight line plus a slight camber. */
export function deckHeight(ends: [number, number], len: number, t: number) {
  return ends[0] + (ends[1] - ends[0]) * t + Math.min(0.5, len * 0.012) * Math.sin(Math.PI * t) + 0.25;
}

function cumulative(pts: XY[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

function colorize(g: THREE.BufferGeometry, hex: string) {
  const geo = g.index ? g.toNonIndexed() : g, c = new THREE.Color(hex);
  const a = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return geo;
}

/**
 * A swept box along the bridge centre line. `top` and `bottom` are vertical offsets from the deck surface,
 * `left`/`right` lateral offsets (meters, right = positive).
 */
function sweep(pts: XY[], hAt: (i: number) => number, left: number, right: number, top: number, bottom: number) {
  const pos: number[] = [];
  const ring = (i: number) => {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const rx = dy, ry = -dx, h = hAt(i);
    const at = (o: number, z: number) => new THREE.Vector3(p[0] + rx * o, h + z, -(p[1] + ry * o));
    return [at(left, top), at(right, top), at(right, bottom), at(left, bottom)]; // TL TR BR BL
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  let prev = ring(0);
  quad(prev[0], prev[3], prev[2], prev[1]); // start cap
  for (let i = 1; i < pts.length; i++) {
    const cur = ring(i);
    quad(prev[0], prev[1], cur[1], cur[0]); // top
    quad(prev[1], prev[2], cur[2], cur[1]); // right side
    quad(prev[2], prev[3], cur[3], cur[2]); // bottom
    quad(prev[3], prev[0], cur[0], cur[3]); // left side
    prev = cur;
  }
  quad(prev[0], prev[1], prev[2], prev[3]); // end cap
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Deck height at any point near the bridge (projected onto its centre line), for cars driving across. */
export function makeDeckAt(pts: XY[], H: Height) {
  const cum = cumulative(pts), len = cum[cum.length - 1], ends = deckEnds(pts, H);
  return (x: number, y: number) => {
    let best = Infinity, bestS = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < best) { best = d; bestS = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
    }
    return deckHeight(ends, len, bestS / (len || 1));
  };
}

export const isBridge = (t: Record<string, string>) => !!t.bridge && t.bridge !== 'no';
export const isTunnel = (t: Record<string, string>) => !!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';

export function bridgeGeometry({ pts, width, rail, under }: Bridge, H: Height): THREE.BufferGeometry[] {
  if (pts.length < 2) return [];
  const cum = cumulative(pts), len = cum[cum.length - 1];
  const ends = deckEnds(pts, H);
  const hAt = (i: number) => deckHeight(ends, len, cum[i] / len);
  const half = width / 2 + 0.6;
  const out: THREE.BufferGeometry[] = [];
  // deck: surface + concrete edge beams, double-sided enough to read from below
  out.push(colorize(sweep(pts, hAt, -half + 0.4, half - 0.4, 0.02, -0.12), rail ? '#6b5f55' : '#5f5f62'));
  out.push(colorize(sweep(pts, hAt, -half, half, -0.05, -0.9), '#b9b5ac'));
  // railings / parapets
  for (const side of [-1, 1]) out.push(colorize(sweep(pts, hAt, side * half - 0.12, side * half + 0.12, 1.0, -0.05), '#9aa0a5'));
  // supports for longer spans, where the ground is well below the deck
  if (len > 22 && !under) {
    const n = Math.floor(len / 18);
    for (let k = 1; k <= n; k++) {
      const s = (k / (n + 1)) * len;
      let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
      const top = deckHeight(ends, len, s / len) - 0.9, ground = H(x, y) - 0.5;
      if (top - ground < 3) continue;
      const pier = new THREE.BoxGeometry(1.2, top - ground, width * 0.7);
      const dir = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      pier.rotateY(dir).translate(x, (top + ground) / 2, -y);
      out.push(colorize(pier, '#b0aca3'));
    }
  }
  return out;
}

// ---------- underpasses ----------
// Mappers often draw a road passing under a motorway as a short tunnel (layer=-1) and leave the motorway
// itself untagged. The bare-earth terrain then dips through the underpass and the motorway would dip with it.
// So: short tunnels are drawn as ordinary roads at the bottom, and every road crossing over one gets a deck
// from rim to rim of the dip.

export type WayInfo = { id: number; pts: XY[]; width: number; tunnel: boolean; bridge: boolean; layer: number };
const UNDERPASS_MAX = 120; // meters: longer tunnels really go through hills

function pointAlong(pts: XY[], cum: number[], s: number): XY {
  s = Math.max(0, Math.min(cum[cum.length - 1], s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}
function subLine(pts: XY[], cum: number[], s0: number, s1: number): XY[] {
  const out: XY[] = [pointAlong(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  out.push(pointAlong(pts, cum, s1));
  return out;
}
/** Where segment a-b crosses c-d: fraction along a-b and the sine of the crossing angle, or null. */
function cross(a: XY, b: XY, c: XY, d: XY) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, sin: Math.abs(den) / (Math.hypot(rx, ry) * Math.hypot(sx, sy)) };
}

/**
 * Underpass ways (drawn on the surface instead of hidden) and, per crossing way, the deck spans (as bridge
 * centre lines) that carry it over them.
 */
export function findUnderpasses(ways: WayInfo[], H: Height) {
  const under = ways.filter(w => w.tunnel && w.pts.length > 1 && cumulative(w.pts)[w.pts.length - 1] < UNDERPASS_MAX);
  const underIds = new Set(under.map(w => w.id));
  const decks = new Map<number, XY[][]>();
  const crossings = new Map<WayInfo, { s: number; half: number; w: WayInfo; span: [number, number] }[]>();
  if (!under.length) return { underIds, decks, openings: [] as Opening[] };
  for (const w of ways) {
    if (w.tunnel || w.bridge || w.layer < 0 || w.pts.length < 2) continue;
    const cum = cumulative(w.pts), len = cum[cum.length - 1];
    const hAt = (s: number) => { const p = pointAlong(w.pts, cum, s); return H(p[0], p[1]); };
    const spans: [number, number][] = [];
    for (const u of under) for (let i = 1; i < w.pts.length; i++) for (let j = 1; j < u.pts.length; j++) {
      const x = cross(w.pts[i - 1], w.pts[i], u.pts[j - 1], u.pts[j]);
      if (!x) continue;
      const s = cum[i - 1] + x.t * (cum[i] - cum[i - 1]);
      // at least the road below plus a margin, then out to where the ground stops rising (the rim of the dip)
      const need = (u.width / 2 + 2.5) / Math.max(0.35, x.sin);
      const rim = (dir: number) => {
        let d = need;
        while (d < 45 && hAt(s + dir * (d + 1)) > hAt(s + dir * d) + 0.02) d++;
        return d;
      };
      const s0 = Math.max(0, s - rim(-1)), s1 = Math.min(len, s + rim(1));
      // only where there really is a dip under the road
      let low = Infinity;
      for (let q = s0; q <= s1; q += 1) low = Math.min(low, hAt(q));
      if (Math.min(hAt(s0), hAt(s1)) - low < 1) continue;
      spans.push([s0, s1]);
      // where along the road below it crosses, and how much of that road the deck covers
      const su = cumulative(u.pts)[j - 1] + (cross(u.pts[j - 1], u.pts[j], w.pts[i - 1], w.pts[i])?.t ?? 0) * Math.hypot(u.pts[j][0] - u.pts[j - 1][0], u.pts[j][1] - u.pts[j - 1][1]);
      (crossings.get(u) ?? crossings.set(u, []).get(u)!).push({ s: su, half: (w.width / 2 + 0.6) / Math.max(0.35, x.sin), w, span: [s0, s1] });
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1] + 2) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]);
    }
    decks.set(w.id, merged.map(([s0, s1]) => subLine(w.pts, cum, s0, s1)));
  }
  // deck surface height where each deck crosses each road below
  const openings: Opening[] = [];
  for (const [u, cs] of crossings) {
    const list = cs.map(c => {
      const p = pointAlong(u.pts, cumulative(u.pts), c.s);
      // the merged deck span of that road which passes over this point
      let merged: XY[] | null = null, best = Infinity;
      for (const d of decks.get(c.w.id)!) for (let i = 1; i < d.length; i++) {
        const [ax, ay] = d[i - 1], [bx, by] = d[i], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        const dist = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
        if (dist < best) { best = dist; merged = d; }
      }
      return { s: c.s, half: c.half, h: merged ? makeDeckAt(merged, H)(p[0], p[1]) : H(p[0], p[1]) };
    }).sort((a, b) => a.s - b.s);
    openings.push({ pts: u.pts, width: u.width, crossings: list });
  }
  return { underIds, decks, openings };
}

/** Height along a road with deck spans: the deck on a span, the ground elsewhere. */
export function makeSpansAt(spans: XY[][], width: number, H: Height): Height {
  const decks = spans.map(pts => ({ pts, at: makeDeckAt(pts, H) }));
  const near = (pts: XY[], x: number, y: number) => {
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
      const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
      if (t < -0.02 || t > 1.02) continue;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  };
  return (x, y) => {
    for (const d of decks) if (near(d.pts, x, y) < width / 2 + 3) return d.at(x, y);
    return H(x, y);
  };
}

/** A road passing under one or more decks: where they cross it (distance along it) and their surface height. */
export type Opening = { pts: XY[]; width: number; crossings: { s: number; half: number; h: number }[] };
const OPENING = 1.2; // meters of verge between the road below and the retaining walls

/** Point and left normal at distance s along a polyline, extended straight past its ends. */
function frameAt(pts: XY[], cum: number[], s: number) {
  const len = cum[cum.length - 1];
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, dx = (b[0] - a[0]) / l, dy = (b[1] - a[1]) / l;
  const base = s < 0 ? pts[0] : s > len ? pts[pts.length - 1] : null;
  const p: XY = base ? [base[0] + dx * (s < 0 ? s : s - len), base[1] + dy * (s < 0 ? s : s - len)] : pointAlong(pts, cum, s);
  return { p, nx: -dy, ny: dx };
}

/**
 * The embankment around an underpass: the bare-earth terrain dips through the opening, so fill it back up to the
 * road above, except over the road below, and hold the fill with concrete retaining walls either side of it.
 * Returns the fill surface (draped with the ground material: uv = map position) and the walls.
 */
export function underpassEarthworks(openings: Opening[], H: Height, R: number) {
  const fill: number[] = [], uv: number[] = [], walls: number[] = [];
  for (const o of openings) {
    const cum = cumulative(o.pts), cs = o.crossings;
    const sA = cs[0].s - cs[0].half, sB = cs[cs.length - 1].s + cs[cs.length - 1].half;
    // embankment top along the road below: the deck surfaces, interpolated between decks, dropping 1:1 off the ends
    const level = (s: number) => {
      if (s < sA) return cs[0].h - 0.15 - (sA - s);
      if (s > sB) return cs[cs.length - 1].h - 0.15 - (s - sB);
      if (s <= cs[0].s) return cs[0].h - 0.15;
      for (let k = 1; k < cs.length; k++) if (s <= cs[k].s) {
        const t = (s - cs[k - 1].s) / ((cs[k].s - cs[k - 1].s) || 1);
        return cs[k - 1].h + (cs[k].h - cs[k - 1].h) * t - 0.15;
      }
      return cs[cs.length - 1].h - 0.15;
    };
    const s0 = sA - 12, s1 = sB + 12, d0 = o.width / 2 + OPENING;
    const ns = Math.ceil(s1 - s0), nd = 34, step = 1.5;
    for (const side of [-1, 1]) {
      const vert = (si: number, di: number) => {
        const s = s0 + si, d = (d0 + di * step) * side, f = frameAt(o.pts, cum, s);
        const x = f.p[0] + f.nx * d, y = f.p[1] + f.ny * d, g = H(x, y), lv = level(s);
        return [x, lv > g ? lv : g - 0.15, -y];
      };
      for (let si = 0; si < ns; si++) for (let di = 0; di < nd; di++) {
        const a = vert(si, di), b = vert(si + 1, di), c = vert(si + 1, di + 1), d = vert(si, di + 1);
        // wind every triangle to face up (the two sides of the road below mirror each other)
        const tri = (p: number[], q: number[], r: number[]) => {
          const ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
          for (const v of ny >= 0 ? [p, q, r] : [p, r, q]) { fill.push(...v); uv.push((v[0] + R) / (2 * R), (-v[2] + R) / (2 * R)); }
        };
        tri(a, b, c); tri(a, c, d);
      }
      // retaining wall at the edge of the opening, wherever the fill stands above the road below
      for (let si = 0; si < ns; si++) {
        const top = (k: number) => { const f = frameAt(o.pts, cum, s0 + k); const x = f.p[0] + f.nx * d0 * side, y = f.p[1] + f.ny * d0 * side; return { x, y, t: level(s0 + k), g: H(x, y) }; };
        const a = top(si), b = top(si + 1);
        if (a.t < a.g + 0.2 && b.t < b.g + 0.2) continue;
        const ta = Math.max(a.t, a.g) + 0.3, tb = Math.max(b.t, b.g) + 0.3; // a low parapet on top
        walls.push(a.x, ta, -a.y, b.x, tb, -b.y, b.x, b.g - 0.4, -b.y, a.x, ta, -a.y, b.x, b.g - 0.4, -b.y, a.x, a.g - 0.4, -a.y);
      }
    }
  }
  const fillGeo = new THREE.BufferGeometry();
  fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
  fillGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  fillGeo.computeVertexNormals();
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
  return { fill: fillGeo, walls: colorize(wallGeo, '#8f8b83') };
}

/**
 * Ground under an underpass opening, for the terrain mesh only: the mesh is a few metres coarse, so its
 * triangles would slope into the opening from the (filled) banks. Inside the opening and one mesh cell either
 * side of it, use the height of the road below instead. Returns null away from openings.
 */
export function openingGround(openings: Opening[], H: Height, cell: number) {
  const prepared = openings.map(o => {
    const cum = cumulative(o.pts), cs = o.crossings;
    return { o, cum, sA: cs[0].s - cs[0].half - 2, sB: cs[cs.length - 1].s + cs[cs.length - 1].half + 2, reach: o.width / 2 + OPENING + cell * 1.2 };
  });
  return (x: number, y: number): number | null => {
    for (const { o, cum, sA, sB, reach } of prepared) {
      let best = Infinity, bestS = 0;
      for (let i = 1; i < o.pts.length; i++) {
        const [ax, ay] = o.pts[i - 1], [bx, by] = o.pts[i], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < best) { best = d; bestS = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
      }
      if (best < reach && bestS >= sA && bestS <= sB) { const p = pointAlong(o.pts, cum, bestS); return H(p[0], p[1]); }
    }
    return null;
  };
}
