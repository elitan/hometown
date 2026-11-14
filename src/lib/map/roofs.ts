// Procedural roofs: fit an oriented rectangle to each footprint and put a gabled or hipped roof on it.
import * as THREE from 'three';
import { rand, type Poly, type XY } from './geo';

export type RoofType = 'gabled' | 'hipped' | 'flat';
export type RoofSpec = { type: RoofType; pitch: number; eave: number };
/** Oriented bounding box: center, angle of the long axis, long and short side lengths. */
export type OBB = { cx: number; cy: number; angle: number; long: number; short: number };

function ringArea(r: XY[]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}
export const polyArea = (p: Poly) => ringArea(p.outer) - p.holes.reduce((s, h) => s + ringArea(h), 0);

/** Minimum-area rectangle, trying each footprint edge direction. */
export function obb(ring: XY[]): OBB {
  let best: OBB & { area: number } = { cx: 0, cy: 0, angle: 0, long: 0, short: 0, area: Infinity };
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    if (Math.hypot(bx - ax, by - ay) < 0.5) continue;
    const th = Math.atan2(by - ay, bx - ax), c = Math.cos(th), s = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of ring) {
      const u = x * c + y * s, v = -x * s + y * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area >= best.area) continue;
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2, du = u1 - u0, dv = v1 - v0;
    const long = du >= dv;
    best = {
      area, cx: um * c - vm * s, cy: um * s + vm * c,
      angle: long ? th : th + Math.PI / 2, long: Math.max(du, dv), short: Math.min(du, dv),
    };
  }
  return best;
}

const FLAT_TYPES = /^(industrial|warehouse|retail|commercial|office|supermarket|hospital|parking|hangar|service|transformer_tower|water_tower)$/;

/** Decide roof shape, pitch and wall (eave) height from OSM tags and footprint size. */
export function roofSpec(t: Record<string, string>, box: OBB, rectangularity: number): RoofSpec {
  const b = t.building, lv = parseFloat(t['building:levels']), h = parseFloat(t.height);
  const shape = t['roof:shape'];
  let type: RoofType = Math.random() < 0.8 ? 'gabled' : 'hipped', pitch = rand(34, 42), eave = rand(3.2, 4.2);

  if (b === 'church' || b === 'chapel' || t.amenity === 'place_of_worship') { pitch = 48; eave = 8; type = 'gabled'; }
  else if (b === 'barn' || b === 'farm_auxiliary' || b === 'stable' || b === 'cowshed') { pitch = rand(28, 34); eave = 4.5; type = 'gabled'; }
  else if (b === 'garage' || b === 'garages' || b === 'shed' || b === 'carport' || b === 'greenhouse') { pitch = rand(18, 25); eave = 2.4; type = 'gabled'; }
  else if (FLAT_TYPES.test(b) || (b === 'apartments' && lv >= 3)) type = 'flat';

  if (lv > 0) eave = lv * 2.8 + 0.4;
  if (h > 0) eave = Math.max(2.4, h - (box.short / 2) * Math.tan(pitch * Math.PI / 180));

  if (shape === 'flat') type = 'flat';
  else if (shape === 'gabled' || shape === 'saltbox' || shape === 'gambrel') type = 'gabled';
  else if (shape === 'hipped' || shape === 'half-hipped' || shape === 'pyramidal') type = 'hipped';

  // only roof shapes that will look right: roughly rectangular, not huge
  const maxShort = /barn|farm_auxiliary|stable|cowshed/.test(b) ? 30 : 22;
  if (!shape && (rectangularity < 0.72 || box.short > maxShort || box.short < 2)) type = 'flat';
  return { type, pitch, eave };
}

/**
 * Roof geometry (non-indexed, world coords: x = east, y = up, z = -north).
 * `top` is the wall-top height. Slopes overhang the walls a little; gable triangles sit on the wall plane.
 */
export function roofGeometry(box: OBB, spec: RoofSpec, top: number) {
  const { cx, cy, angle, long: L, short: S } = box;
  const o = Math.min(0.5, S * 0.06); // overhang
  const tan = Math.tan(spec.pitch * Math.PI / 180);
  const rise = (S / 2) * tan, ridgeY = top + rise, eaveY = top - o * tan;
  const c = Math.cos(angle), s = Math.sin(angle);
  const P = (u: number, v: number, y: number) => new THREE.Vector3(cx + u * c - v * s, y, -(cy + u * s + v * c));
  const center = P(0, 0, top);

  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3) => {
    // orient each triangle to face away from the roof's center
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    const out = new THREE.Vector3().addVectors(a, b).add(d).divideScalar(3).sub(center);
    if (n.dot(out) < 0) [b, d] = [d, b];
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3, e: THREE.Vector3) => { tri(a, b, d); tri(a, d, e); };

  const Lu = L / 2 + o, Sv = S / 2 + o;
  if (spec.type === 'gabled') {
    const r1 = P(-Lu, 0, ridgeY), r2 = P(Lu, 0, ridgeY);
    quad(P(-Lu, Sv, eaveY), P(Lu, Sv, eaveY), r2, r1);
    quad(P(-Lu, -Sv, eaveY), P(Lu, -Sv, eaveY), r2, r1);
    for (const u of [-L / 2, L / 2]) tri(P(u, -S / 2, top), P(u, S / 2, top), P(u, 0, ridgeY)); // gable walls
  } else {
    const ru = Math.max(0, L / 2 - S / 2); // hip ridge half-length
    const r1 = P(-ru, 0, ridgeY), r2 = P(ru, 0, ridgeY);
    const a = P(-Lu, -Sv, eaveY), b = P(Lu, -Sv, eaveY), d = P(Lu, Sv, eaveY), e = P(-Lu, Sv, eaveY);
    quad(a, b, r2, r1); quad(e, d, r2, r1);
    tri(b, d, r2); tri(a, e, r1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
