// Street furniture and small structures, mostly from OpenStreetMap: lamps, bus stops (+ shelters), benches,
// post boxes, recycling stations, fences / hedges / stone walls, power lines with poles or pylons and sagging
// wires, wind turbines, masts, football goals, parked cars and jetties. All instanced and set on the terrain.
// Street lamps are rarely mapped in Swedish villages, so residential streets near houses also get lamps at a
// typical spacing (marked "typical" below) — everything else is only drawn where it is actually mapped.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { polygons, rand, toXY, type LocalProjection, type OsmData, type OsmElement, type Poly, type XY } from './geo';
import { obb, type OBB } from './roofs';
import { PAINT, carGeometry, carMaterials, type Variant } from './traffic';

type Height = (x: number, y: number) => number;
export type PropsInput = {
  P: LocalProjection; data: OsmData; H: Height; R: number;
  buildings: Poly[];
  roads: { pts: XY[]; w: number; highway: string }[];
};

const UP = new THREE.Vector3(0, 1, 0);
const q = (yaw: number) => new THREE.Quaternion().setFromAxisAngle(UP, yaw);
/** Yaw that turns local +x toward a direction given in map coords (east, north). */
const yawTo = (dx: number, dy: number) => Math.atan2(dy, dx);
const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra });

/** Collects transforms per (geometry, material) and turns them into InstancedMeshes. */
class Batch {
  private sets = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; list: THREE.Matrix4[]; shadow: boolean }>();
  add(key: string, geo: () => THREE.BufferGeometry, material: () => THREE.Material | THREE.Material[], m: THREE.Matrix4, shadow = true) {
    let s = this.sets.get(key);
    if (!s) this.sets.set(key, s = { geo: geo(), mat: material(), list: [], shadow });
    s.list.push(m);
  }
  build(group: THREE.Group) {
    for (const s of this.sets.values()) {
      const im = new THREE.InstancedMesh(s.geo, s.mat, s.list.length);
      s.list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = s.shadow; im.receiveShadow = true;
      group.add(im);
    }
  }
}

// ---------- geometry helpers ----------

function merged(parts: [THREE.BufferGeometry, string][]) {
  const geos = parts.map(([g, hex]) => {
    const geo = g.index ? g.toNonIndexed() : g, c = new THREE.Color(hex), a = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    geo.deleteAttribute('uv');
    return geo;
  });
  return mergeGeometries(geos);
}
const vc = (extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, ...extra });

const lampGeo = () => merged([
  [new THREE.CylinderGeometry(0.06, 0.09, 6.4, 8).translate(0, 3.2, 0), '#50555b'],
  [new THREE.BoxGeometry(1.3, 0.07, 0.07).translate(0.62, 6.3, 0), '#50555b'],
  [new THREE.BoxGeometry(0.55, 0.12, 0.26).translate(1.25, 6.22, 0), '#e9ecef'],
]);
const busStopGeo = () => merged([
  [new THREE.CylinderGeometry(0.04, 0.04, 2.6, 8).translate(0, 1.3, 0), '#7d8287'],
  [new THREE.BoxGeometry(0.04, 0.5, 0.5).translate(0, 2.45, 0), '#f2c400'],
  [new THREE.BoxGeometry(0.045, 0.36, 0.36).translate(0, 2.45, 0), '#1f3d7a'],
]);
const shelterGeo = () => merged([
  [new THREE.BoxGeometry(3.2, 0.08, 1.6).translate(0, 2.35, 0), '#5c6166'],
  [new THREE.BoxGeometry(3.0, 2.2, 0.04).translate(0, 1.15, -0.75), '#a9c7d6'],
  [new THREE.BoxGeometry(0.04, 2.2, 1.5).translate(-1.5, 1.15, 0), '#a9c7d6'],
  [new THREE.BoxGeometry(0.04, 2.2, 1.5).translate(1.5, 1.15, 0), '#a9c7d6'],
  [new THREE.BoxGeometry(2.4, 0.06, 0.4).translate(0, 0.45, -0.5), '#7a5a3c'],
]);
const benchGeo = () => merged([
  [new THREE.BoxGeometry(1.7, 0.06, 0.42).translate(0, 0.45, 0), '#7a5a3c'],
  [new THREE.BoxGeometry(1.7, 0.4, 0.05).translate(0, 0.75, -0.2), '#7a5a3c'],
  [new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(-0.75, 0.22, 0), '#3c3f42'],
  [new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(0.75, 0.22, 0), '#3c3f42'],
]);
const postBoxGeo = () => merged([
  [new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6).translate(0, 0.5, 0), '#6b7075'],
  [new THREE.BoxGeometry(0.36, 0.48, 0.3).translate(0, 1.2, 0), '#f2c200'],
]);
const recyclingGeo = () => merged(['#2e7d4f', '#1f5f8b', '#c9a227', '#8a8f94'].map((c, i) => [new THREE.BoxGeometry(1.6, 1.7, 1.6).translate(i * 1.8 - 2.7, 0.85, 0), c] as [THREE.BufferGeometry, string]));
/** Goal frame: posts, crossbar, and the sloping back frame that holds the net (net itself left open). */
const goalGeo = (w: number, h: number) => {
  const bar = (len: number) => new THREE.CylinderGeometry(0.05, 0.05, len, 8);
  const d = Math.min(1.6, h * 0.7), slope = Math.hypot(d, h), tilt = Math.atan2(d, h);
  return merged([
    [bar(h).translate(0, h / 2, -w / 2), '#ffffff'],
    [bar(h).translate(0, h / 2, w / 2), '#ffffff'],
    [bar(w).rotateX(Math.PI / 2).translate(0, h, 0), '#ffffff'],
    [bar(w).rotateX(Math.PI / 2).translate(-d, 0.05, 0), '#d9dde0'],
    [bar(slope).rotateZ(-tilt).translate(-d / 2, h / 2, -w / 2), '#d9dde0'],
    [bar(slope).rotateZ(-tilt).translate(-d / 2, h / 2, w / 2), '#d9dde0'],
  ]);
};
const postGeo = () => new THREE.BoxGeometry(0.1, 1.2, 0.1).translate(0, 0.6, 0);
const woodPoleGeo = () => merged([
  [new THREE.CylinderGeometry(0.11, 0.14, 9, 7).translate(0, 4.5, 0), '#6a5640'],
  [new THREE.BoxGeometry(0.12, 0.12, 2.0).translate(0, 8.6, 0), '#6a5640'],
]);
const pylonGeo = () => merged([
  [new THREE.CylinderGeometry(0.35, 1.6, 24, 4, 1, true).rotateY(Math.PI / 4).translate(0, 12, 0), '#9aa0a6'],
  [new THREE.BoxGeometry(0.4, 0.5, 13).translate(0, 22, 0), '#9aa0a6'],
]);
const mastGeo = (h: number) => merged([
  [new THREE.CylinderGeometry(0.3, 1.2, h, 4).rotateY(Math.PI / 4).translate(0, h / 2, 0), '#b8bcc0'],
  [new THREE.BoxGeometry(1.4, 2, 1.4).translate(0, h * 0.8, 0), '#c0392b'],
]);

/** Box swept along a polyline, following the terrain (fences rails, hedges, walls, jetty decks). */
function sweep(pts: XY[], hAt: (x: number, y: number) => number, halfW: number, bottom: number, top: number) {
  const dense: XY[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
    for (let k = 1; k <= n; k++) dense.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  const pos: number[] = [];
  const ring = (i: number) => {
    const p = dense[i], a = dense[Math.max(0, i - 1)], b = dense[Math.min(dense.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const h = hAt(p[0], p[1]);
    const at = (o: number, z: number) => new THREE.Vector3(p[0] + dy * o, h + z, -(p[1] - dx * o));
    return [at(-halfW, top), at(halfW, top), at(halfW, bottom), at(-halfW, bottom)];
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  let prev = ring(0);
  for (let i = 1; i < dense.length; i++) {
    const cur = ring(i);
    quad(prev[0], prev[1], cur[1], cur[0]); quad(prev[1], prev[2], cur[2], cur[1]); quad(prev[3], prev[0], cur[0], cur[3]);
    prev = cur;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return { geo: g, dense };
}

function speckleTexture(base: string, dots: string[], n: number, size = 3) {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = dots[i % dots.length];
    const r = size * (0.5 + Math.random());
    ctx.beginPath(); ctx.ellipse(Math.random() * S, Math.random() * S, r, r * 0.8, Math.random() * 3, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** World-space UVs for swept strips (u along x+z, v up), so textures tile at a sensible scale. */
function worldUV(g: THREE.BufferGeometry, scale: number) {
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) + p.getZ(i)) / scale; uv[i * 2 + 1] = p.getY(i) / scale; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// ---------- wind turbines (animated) ----------

class Turbine {
  readonly rotor = new THREE.Group();
  constructor(group: THREE.Group, x: number, y: number, ground: number, hub: number, radius: number, facing: number) {
    const white = mat('#eef0f1', { roughness: 0.5 });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.6, hub, 16).translate(0, hub / 2, 0), white);
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(9, 3.4, 3.4).translate(-1.5, 0, 0), white);
    nacelle.position.set(0, hub, 0);
    const head = new THREE.Group();
    head.position.set(x, ground, -y);
    head.rotation.y = facing;
    head.add(tower, nacelle);
    this.rotor.position.set(3.4, hub, 0);
    const blade = new THREE.BoxGeometry(0.25, radius, 1.6).translate(0, radius / 2, 0);
    for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(blade, white); b.rotation.x = (i * Math.PI * 2) / 3; this.rotor.add(b); }
    this.rotor.add(new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), white));
    head.add(this.rotor);
    head.traverse(o => { (o as THREE.Mesh).castShadow = true; });
    group.add(head);
  }
}

// ---------- the props ----------

export class Props {
  readonly group = new THREE.Group();
  private turbines: Turbine[] = [];
  counts: Record<string, number> = {};

  constructor({ P, data, H, R, buildings, roads }: PropsInput) {
    const batch = new Batch();
    const inside = ([x, y]: XY) => Math.abs(x) < R - 2 && Math.abs(y) < R - 2;
    const count = (k: string, n = 1) => { this.counts[k] = (this.counts[k] ?? 0) + n; };
    const at = (x: number, y: number, yaw = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, H(x, y), -y), q(yaw), new THREE.Vector3(s, s, s));

    // nearest road direction (for orienting signs, benches) via a coarse grid of road segments
    const cell = 40, roadGrid = new Map<string, [XY, XY][]>();
    for (const r of roads) for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i], k = `${Math.floor((a[0] + b[0]) / 2 / cell)},${Math.floor((a[1] + b[1]) / 2 / cell)}`;
      (roadGrid.get(k) ?? roadGrid.set(k, []).get(k)!).push([a, b]);
    }
    const nearestRoad = (x: number, y: number) => {
      let best: { d: number; dir: XY; foot: XY } | null = null;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b] of roadGrid.get(`${cx + i},${cy + j}`) ?? []) {
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        const fx = a[0] + dx * t, fy = a[1] + dy * t, d = Math.hypot(x - fx, y - fy);
        if (!best || d < best.d) best = { d, dir: [dx / Math.sqrt(L2), dy / Math.sqrt(L2)], foot: [fx, fy] };
      }
      return best;
    };
    // building proximity (for "typical" lamps: only where people live)
    const bcell = 30, bGrid = new Set<string>();
    for (const b of buildings) for (const [x, y] of b.outer) bGrid.add(`${Math.floor(x / bcell)},${Math.floor(y / bcell)}`);
    const nearHouses = (x: number, y: number) => {
      const cx = Math.floor(x / bcell), cy = Math.floor(y / bcell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (bGrid.has(`${cx + i},${cy + j}`)) return true;
      return false;
    };

    const lamps: XY[] = [];
    const addLamp = (x: number, y: number, yaw: number) => { lamps.push([x, y]); batch.add('lamp', lampGeo, () => vc({ emissive: '#000000' }), at(x, y, yaw)); count('lamps'); };
    let shelters: XY[] = [];

    for (const el of data.elements) {
      const t = el.tags || {};
      if (el.type === 'node' && el.lat !== undefined) {
        const [x, y] = P.proj(el.lat, el.lon!);
        if (!inside([x, y])) continue;
        const road = nearestRoad(x, y);
        const along = road ? yawTo(road.dir[0], road.dir[1]) : rand(0, Math.PI * 2);
        if (t.highway === 'street_lamp') {
          const yaw = road ? yawTo(road.foot[0] - x, road.foot[1] - y) : rand(0, 6);
          addLamp(x, y, yaw);
        } else if (t.highway === 'bus_stop' || t.public_transport === 'platform') {
          // sign plate faces along the road, so it's readable from approaching buses
          batch.add('busstop', busStopGeo, () => vc(), at(x, y, along)); count('bus stops');
          if (t.shelter === 'yes') shelters.push([x, y]);
        } else if (t.amenity === 'shelter') {
          shelters.push([x, y]);
        } else if (t.amenity === 'bench') {
          batch.add('bench', benchGeo, () => vc(), at(x, y, road ? yawTo(-road.dir[1], road.dir[0]) + Math.PI / 2 : rand(0, 6))); count('benches');
        } else if (t.amenity === 'post_box') {
          batch.add('postbox', postBoxGeo, () => vc(), at(x, y, along)); count('post boxes');
        } else if (t.amenity === 'recycling') {
          batch.add('recycling', recyclingGeo, () => vc(), at(x, y, along)); count('recycling');
        } else if (t.power === 'generator' && /wind/.test(t['generator:source'] ?? '')) {
          const hub = parseFloat(t.height) > 0 ? parseFloat(t.height) * 0.7 : 95, radius = parseFloat(t['rotor:diameter']) / 2 || 55;
          this.turbines.push(new Turbine(this.group, x, y, H(x, y), hub, radius, rand(0, Math.PI * 2))); count('wind turbines');
        } else if (t.man_made === 'mast' || (t.man_made === 'tower' && /communication/.test(t['tower:type'] ?? ''))) {
          const h = parseFloat(t.height) > 0 ? parseFloat(t.height) : 45;
          batch.add('mast' + Math.round(h), () => mastGeo(h), () => vc({ roughness: 0.5 }), at(x, y)); count('masts');
        }
        continue;
      }
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const pts = toXY(P, el.geometry);
      if (!pts.some(inside)) continue;
      if (t.barrier && /^(fence|hedge|wall|retaining_wall|city_wall|yes|guard_rail)$/.test(t.barrier)) this.barrier(pts, t, H, batch, count);
      else if (t.power === 'line' || t.power === 'minor_line') this.powerLine(pts, t.power === 'line', H, batch, count);
      else if (t.leisure === 'pitch') this.goals(el, P, H, batch, count);
      else if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') this.parked(el, P, H, count);
      else if (t.amenity === 'shelter') { const [x, y] = pts[0]; shelters.push([x, y]); }
      else if (t.man_made === 'pier') this.pier(pts, H, count);
    }

    // shelters next to their stop, back toward the road side away from traffic
    shelters = shelters.filter(inside);
    for (const [x, y] of shelters) {
      const road = nearestRoad(x, y);
      const yaw = road ? yawTo(road.dir[0], road.dir[1]) : 0;
      batch.add('shelter', shelterGeo, () => vc({ transparent: false }), at(x, y, yaw)); count('shelters');
    }

    // typical street lamps: one side of residential streets near houses, ~40 m apart, unless lamps are mapped nearby
    const lampRoads = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary']);
    for (const r of roads) {
      if (!lampRoads.has(r.highway)) continue;
      let next = 12;
      for (let i = 1, acc = 0; i < r.pts.length; i++) {
        const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i], L = Math.hypot(bx - ax, by - ay);
        const dx = (bx - ax) / (L || 1), dy = (by - ay) / (L || 1);
        while (next <= acc + L) {
          const s = next - acc, px = ax + dx * s, py = ay + dy * s;
          const off = r.w / 2 + 1.4, lx = px + dy * off, ly = py - dx * off; // right-hand side
          if (inside([lx, ly]) && nearHouses(lx, ly) && !lamps.some(([qx, qy]) => Math.hypot(qx - lx, qy - ly) < 22)) addLamp(lx, ly, yawTo(-dy, dx));
          next += 40;
        }
        acc += L;
      }
    }
    batch.build(this.group);
    this.flushParked();
  }

  private barrier(pts: XY[], t: Record<string, string>, H: Height, batch: Batch, count: (k: string, n?: number) => void) {
    const kind = t.barrier === 'hedge' ? 'hedge' : /wall/.test(t.barrier) ? 'wall' : 'fence';
    if (kind === 'fence') {
      // posts every 2.5 m plus two rails
      const rail = (z: number) => sweep(pts, H, 0.03, z - 0.06, z).geo;
      const g = mergeGeometries([rail(1.05), rail(0.55)]);
      const m = new THREE.Mesh(g, mat('#8f7f66'));
      m.castShadow = true; this.group.add(m);
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay);
        for (let s = 0; s <= L; s += 2.5) {
          const x = ax + (bx - ax) * s / L, y = ay + (by - ay) * s / L;
          batch.add('fencepost', postGeo, () => mat('#7d6d55'), new THREE.Matrix4().makeTranslation(x, H(x, y) - 0.05, -y));
        }
      }
      count('fences');
    } else if (kind === 'hedge') {
      const g = worldUV(sweep(pts, H, 0.45, -0.2, 1.5).geo, 1.5);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: speckleTexture('#2f4a25', ['#3d5f2e', '#24391c', '#4f7339'], 500), roughness: 0.95 }));
      m.castShadow = m.receiveShadow = true; this.group.add(m); count('hedges');
    } else {
      // Skåne-style stone wall: low, lumpy grey stones — or a town wall (Visby's ringmur) at full height
      const city = t.barrier === 'city_wall', h = parseFloat(t.height) > 0 ? parseFloat(t.height) : city ? 8 : 0.85;
      const g = worldUV(sweep(pts, H, city ? 1.2 : 0.35, -0.3, h).geo, city ? 2.5 : 1.2);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: speckleTexture('#7c7b76', ['#9a9893', '#5f5e5a', '#8a867c', '#6e6f6a'], 140, 9), roughness: 0.95 }));
      m.castShadow = m.receiveShadow = true; this.group.add(m); count(city ? 'town walls' : 'stone walls');
    }
  }

  private powerLine(pts: XY[], big: boolean, H: Height, batch: Batch, count: (k: string, n?: number) => void) {
    // OSM puts a node at every pole/pylon; wires sag between them
    const top = big ? 22 : 8.6, arm = big ? 6 : 0.9, wires = big ? [-arm, 0, arm] : [-arm, arm];
    const segs: number[] = [];
    pts.forEach(([x, y], i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const yaw = yawTo(b[0] - a[0], b[1] - a[1]);
      batch.add(big ? 'pylon' : 'pole', big ? pylonGeo : woodPoleGeo, () => vc({ roughness: big ? 0.5 : 0.85, metalness: big ? 0.6 : 0 }), new THREE.Matrix4().compose(new THREE.Vector3(x, H(x, y), -y), q(yaw), new THREE.Vector3(1, 1, 1)), true);
      if (i === 0) return;
      const [px, py] = pts[i - 1], span = Math.hypot(x - px, y - py), dx = (x - px) / span, dy = (y - py) / span;
      const sag = span * (big ? 0.035 : 0.025), h0 = H(px, py) + top, h1 = H(x, y) + top;
      for (const o of wires) {
        let prev: THREE.Vector3 | null = null;
        for (let k = 0; k <= 12; k++) {
          const t = k / 12, wx = px + (x - px) * t - dy * o, wy = py + (y - py) * t + dx * o;
          const v = new THREE.Vector3(wx, h0 + (h1 - h0) * t - sag * 4 * t * (1 - t), -wy);
          if (prev) segs.push(prev.x, prev.y, prev.z, v.x, v.y, v.z);
          prev = v;
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#2b2f33' })));
    count(big ? 'power lines' : 'local power lines');
  }

  private goals(el: OsmElement, P: LocalProjection, H: Height, batch: Batch, count: (k: string, n?: number) => void) {
    const t = el.tags || {};
    if (t.sport && !/soccer|football/.test(t.sport)) return;
    const poly = polygons(P, el)[0];
    if (!poly) return;
    const box: OBB = obb(poly.outer);
    if (box.long < 18) return;
    const big = box.long > 60, w = big ? 7.32 : 3, h = big ? 2.44 : 2;
    for (const side of [-1, 1]) {
      const d = side * (box.long / 2 - 1), x = box.cx + Math.cos(box.angle) * d, y = box.cy + Math.sin(box.angle) * d;
      batch.add('goal' + w, () => goalGeo(w, h), () => vc({ roughness: 0.5 }), new THREE.Matrix4().compose(new THREE.Vector3(x, H(x, y), -y), q(box.angle + (side > 0 ? 0 : Math.PI)), new THREE.Vector3(1, 1, 1)));
    }
    count('football goals', 2);
  }

  private parkedBatch = new Map<string, THREE.Matrix4[]>();
  private parkedTotal = 0;
  private parked(el: OsmElement, P: LocalProjection, H: Height, count: (k: string, n?: number) => void) {
    const poly = polygons(P, el)[0];
    if (!poly) return;
    const box = obb(poly.outer);
    if (box.long < 6 || box.short < 5) return;
    // bays 2.6 m wide along the long side, rows 5.5 m deep; big lots are emptier, and there's a cap overall
    const c = Math.cos(box.angle), s = Math.sin(box.angle);
    const occupancy = box.long * box.short > 3000 ? 0.25 : 0.5;
    let n = 0;
    for (let v = -box.short / 2 + 2.9; v <= box.short / 2 - 2.6; v += 5.6) for (let u = -box.long / 2 + 1.5; u <= box.long / 2 - 1.3; u += 2.6) {
      if (Math.random() > occupancy || this.parkedTotal >= 900 || n >= 60) continue;
      const x = box.cx + u * c - v * s, y = box.cy + u * s + v * c;
      if (!poly.outer.length || !insidePoly(x, y, poly)) continue;
      const variant: Variant = Math.random() < 0.6 ? 'estate' : Math.random() < 0.6 ? 'sedan' : 'van';
      const key = variant + '|' + PAINT[Math.floor(Math.random() * PAINT.length)];
      const yaw = box.angle + Math.PI / 2 + (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.05, 0.05);
      (this.parkedBatch.get(key) ?? this.parkedBatch.set(key, []).get(key)!).push(new THREE.Matrix4().compose(new THREE.Vector3(x, H(x, y) + 0.03, -y), q(yaw), new THREE.Vector3(1, 1, 1)));
      n++; this.parkedTotal++;
    }
    if (n) count('parked cars', n);
  }
  private carMats: THREE.Material[] | null = null;
  /** One instanced mesh per (model, paint) for all parked cars, built once every parking lot is seen. */
  private flushParked() {
    if (!this.parkedBatch.size) return;
    this.carMats ??= carMaterials();
    for (const [key, list] of this.parkedBatch) {
      const [variant, paint] = key.split('|');
      const im = new THREE.InstancedMesh(carGeometry(variant as Variant, paint), this.carMats, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true;
      this.group.add(im);
    }
    this.parkedBatch.clear();
  }

  private pier(pts: XY[], H: Height, count: (k: string, n?: number) => void) {
    const deck = H(pts[0][0], pts[0][1]) + 0.35; // level with the shore end
    const g = sweep(pts, () => deck, 1.1, -0.12, 0).geo;
    const m = new THREE.Mesh(worldUV(g, 1), new THREE.MeshStandardMaterial({ map: speckleTexture('#8a6f4f', ['#7a5f42', '#9a7d5a'], 60, 6), roughness: 0.85 }));
    m.castShadow = m.receiveShadow = true; this.group.add(m);
    count('jetties');
  }

  update(dt: number) {
    for (const t of this.turbines) t.rotor.rotation.x += dt * 1.6;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mt of (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as THREE.MeshStandardMaterial[]) { mt.map?.dispose(); mt.dispose(); }
    });
  }
}

function insidePoly(x: number, y: number, p: Poly) {
  let c = false;
  const r = p.outer;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
