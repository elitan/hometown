// Ambient traffic: low-poly cars driving the real OSM road network, on the right-hand side,
// easing into curves and junctions, keeping distance to the car ahead and following the terrain.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { beamTexture, glowingVehicleLamps } from './season';
import { pick, rand, type XY } from './geo';

export type RoadWay = { pts: XY[]; highway: string; oneway: boolean; deckAt?: (x: number, y: number) => number; tunnel?: boolean; lane?: number };
type Height = (x: number, y: number) => number;

// km/h by road type (Swedish defaults, roughly)
const SPEED: Record<string, number> = {
  motorway: 110, trunk: 90, primary: 80, secondary: 70, tertiary: 60, unclassified: 50,
  residential: 35, living_street: 15, service: 20,
};
const LANE: Record<string, number> = { motorway: 3.6, trunk: 3, primary: 2.6, secondary: 2.2, tertiary: 1.9, unclassified: 1.6, residential: 1.6 };

// ---------- road graph ----------

export type Edge = {
  id: number; pts: XY[]; cum: number[]; len: number;
  from: string; to: string; speed: number; lane: number; twin: number; // twin = reverse edge id or -1
  deckAt?: (x: number, y: number) => number; tunnel?: boolean;
};

export const nodeKey = ([x, y]: XY) => x.toFixed(1) + ',' + y.toFixed(1);

function makeEdge(id: number, pts: XY[], speed: number, lane: number): Edge {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { id, pts, cum, len: cum[cum.length - 1], from: nodeKey(pts[0]), to: nodeKey(pts[pts.length - 1]), speed, lane, twin: -1 };
}

/** Split ways at shared nodes (junctions) into directed edges. */
export function buildGraph(ways: RoadWay[]) {
  const uses = new Map<string, number>();
  for (const w of ways) w.pts.forEach((p, i) => {
    const k = nodeKey(p);
    uses.set(k, (uses.get(k) ?? 0) + (i === 0 || i === w.pts.length - 1 ? 2 : 1));
  });
  const edges: Edge[] = [], out = new Map<string, number[]>();
  const add = (pts: XY[], w: RoadWay) => {
    if (pts.length < 2) return -1;
    const e = makeEdge(edges.length, pts, (SPEED[w.highway] ?? 40) / 3.6, w.lane ?? (w.oneway ? 0 : (LANE[w.highway] ?? 1.5)));
    e.deckAt = w.deckAt; e.tunnel = w.tunnel;
    if (e.len < 0.5) return -1;
    edges.push(e);
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.id);
    return e.id;
  };
  for (const w of ways) {
    let seg: XY[] = [w.pts[0]];
    for (let i = 1; i < w.pts.length; i++) {
      seg.push(w.pts[i]);
      if (i === w.pts.length - 1 || (uses.get(nodeKey(w.pts[i])) ?? 0) > 1) {
        const a = add(seg, w);
        if (!w.oneway && a >= 0) {
          const b = add(seg.slice().reverse(), w);
          if (b >= 0) { edges[a].twin = b; edges[b].twin = a; }
        }
        seg = [w.pts[i]];
      }
    }
  }
  return { edges, out };
}

export function pointAt(e: Edge, s: number): XY {
  s = Math.max(0, Math.min(e.len, s));
  let i = 1;
  while (i < e.cum.length - 1 && e.cum[i] < s) i++;
  const t = (s - e.cum[i - 1]) / ((e.cum[i] - e.cum[i - 1]) || 1);
  const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i];
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

// ---------- car models ----------

export type Variant = 'sedan' | 'estate' | 'van';
export const PAINT = ['#f2f2f0', '#f2f2f0', '#c7cacd', '#9aa0a6', '#2b2e33', '#1c1d20', '#23476e', '#7d1f1f', '#3d5a45', '#b8b2a4'];

/** Shape in the car's side view (x forward, y up), extruded across the width. */
function slab(points: [number, number][], width: number, bevel = 0.06) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 1 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  return g;
}
function colored(g: THREE.BufferGeometry, hex: string) {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}

const modelCache = new Map<string, THREE.BufferGeometry>();
/** Material slots for car parts: glossy paint, glass, tyres, rims, lamps. */
const SLOT = { paint: 0, glass: 1, tire: 2, rim: 3, lamp: 4 } as const;

export function carGeometry(v: Variant, paint: string) {
  const key = v + paint;
  if (modelCache.has(key)) return modelCache.get(key)!;
  const parts: [THREE.BufferGeometry, number][] = [];
  const add = (g: THREE.BufferGeometry, hex: string, slot: number) => parts.push([colored(g, hex), slot]);
  const L = v === 'van' ? 4.9 : 4.6, W = 1.84, half = L / 2;
  // lower body
  add(slab([[-half, 0.32], [half, 0.32], [half + 0.02, 0.68], [half - 0.25, 0.86], [-half + 0.1, 0.9], [-half, 0.7]], W, 0.08), paint, SLOT.paint);
  // greenhouse (glass) + roof
  if (v === 'van') {
    add(slab([[half - 0.35, 0.86], [half - 1.0, 1.55], [-half + 0.05, 1.55], [-half + 0.05, 0.9]], W - 0.08, 0.04), '#1e2a33', SLOT.glass);
    add(slab([[half - 1.05, 1.52], [-half + 0.02, 1.52], [-half + 0.02, 1.95], [half - 1.2, 1.95]], W, 0.06), paint, SLOT.paint);
    add(slab([[half - 0.6, 0.88], [-half + 0.1, 0.88], [-half + 0.1, 1.5], [half - 0.95, 1.5]], W + 0.01, 0.03), paint, SLOT.paint); // panel van sides
  } else {
    const rearX = v === 'estate' ? -half + 0.12 : -half + 0.75, rearTop = v === 'estate' ? -half + 0.18 : -half + 1.15;
    add(slab([[half - 0.45, 0.86], [half - 1.35, 1.38], [rearTop, 1.4], [rearX, 0.9]], W - 0.14, 0.04), '#1e2a33', SLOT.glass);
    add(slab([[half - 1.38, 1.37], [rearTop + 0.02, 1.39], [rearTop + 0.02, 1.45], [half - 1.45, 1.43]], W - 0.18, 0.03), paint, SLOT.paint);
  }
  // wheels with rims
  const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 18).rotateX(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.26, 12).rotateX(Math.PI / 2);
  for (const x of [half - 0.85, -half + 0.85]) for (const z of [-W / 2 + 0.1, W / 2 - 0.1]) {
    add(wheel.clone().translate(x, 0.33, z), '#1b1b1d', SLOT.tire);
    add(rim.clone().translate(x, 0.33, z), '#b9bcc0', SLOT.rim);
  }
  // lights
  const lamp = new THREE.BoxGeometry(0.06, 0.12, 0.34);
  for (const z of [-0.62, 0.62]) {
    add(lamp.clone().translate(half + 0.02, 0.68, z), '#fff4cf', SLOT.lamp);
    add(lamp.clone().translate(-half - 0.02, 0.72, z), '#c4231c', SLOT.lamp);
  }
  const g = mergeGeometries(parts.map(([p]) => p.index ? p.toNonIndexed() : p), true);
  g.groups.forEach((grp, i) => { grp.materialIndex = parts[i][1]; });
  modelCache.set(key, g);
  return g;
}

function lampMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3 });
  glowingVehicleLamps(m);
  return m;
}

/**
 * Headlight beam on the road, as a child of a vehicle whose local +x is forward and y = 0 the ground.
 * `side` moves it to one lamp (local z) and `toe` turns it slightly outward (radians).
 */
export function headlightBeam(material: THREE.Material, front: number, length: number, width: number, y = 0.12, side = 0, toe = 0) {
  const g = new THREE.PlaneGeometry(length, width).rotateX(-Math.PI / 2).translate(length / 2, y, 0).rotateY(toe).translate(front, 0, side);
  const m = new THREE.Mesh(g, material);
  m.renderOrder = 2;
  m.raycast = () => {}; // not clickable: clicks go to the vehicle
  return m;
}
export function beamMaterial() {
  return new THREE.MeshBasicMaterial({ map: beamTexture(), color: '#ffe2b0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
}

/** Car paint with a clear coat, reflective glass, rubber, metal rims, slightly glowing lamps. */
export function carMaterials(lit = true): THREE.Material[] {
  return [
    new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35, clearcoat: 0.9, clearcoatRoughness: 0.08 }),
    new THREE.MeshStandardMaterial({ color: '#1a232b', roughness: 0.05, metalness: 0.3, envMapIntensity: 3 }),
    new THREE.MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: '#c3c6ca', roughness: 0.3, metalness: 0.9 }),
    lit ? lampMaterial() : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3 }),
  ];
}

// ---------- cars ----------

export type Car = { mesh: THREE.Mesh; edge: Edge; next: Edge; prev: Edge | null; s: number; v: number; vmax: number; heading: number };

export class Traffic {
  readonly group = new THREE.Group();
  private beam = beamMaterial();
  private edges: Edge[]; private out: Map<string, number[]>;
  private cars: Car[] = [];
  private material = carMaterials();

  constructor(ways: RoadWay[], private H: Height, private R: number) {
    ({ edges: this.edges, out: this.out } = buildGraph(ways));
    const inside = this.edges.filter(e => e.pts.some(([x, y]) => Math.abs(x) < R && Math.abs(y) < R));
    const total = inside.reduce((s, e) => s + e.len, 0);
    const count = Math.min(70, Math.round(total / 260)); // ~1 car per 260 m of lane
    for (let i = 0; i < count; i++) this.spawn(inside, total);
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.material) m.dispose();
    this.beam.map?.dispose(); this.beam.dispose();
  }

  private spawn(pool: Edge[], total: number, car?: Car) {
    let r = Math.random() * total, e = pool[0];
    for (const x of pool) { r -= x.len; if (r <= 0) { e = x; break; } }
    const v = pick<Variant>(['sedan', 'estate', 'estate', 'estate', 'van']); // a Swedish amount of estates
    const mesh = car?.mesh ?? new THREE.Mesh(carGeometry(v, pick(PAINT)), this.material);
    mesh.castShadow = true;
    const c: Car = car ?? { mesh, edge: e, next: e, prev: null, s: 0, v: 0, vmax: 1, heading: 0 };
    if (!car) {
      mesh.userData.vehicle = { kind: 'car', car: c, name: v === 'van' ? 'Van' : v === 'estate' ? 'Estate car' : 'Saloon car' };
      // one beam per headlight, toed out a little, overlapping further ahead
      for (const z of [-0.62, 0.62]) mesh.add(headlightBeam(this.beam, v === 'van' ? 2.45 : 2.3, 18, 5.5, 0.12, z, -Math.sign(z) * 0.08));
    }
    c.edge = e; c.prev = null; c.s = rand(0, e.len); c.next = this.chooseNext(e);
    c.vmax = rand(0.85, 1.05); c.v = Math.min(e.speed * c.vmax, 8);
    if (!car) { this.cars.push(c); this.group.add(mesh); }
    this.place(c, 1);
  }

  /** Pick the next edge at a junction: avoid U-turns, prefer going straight-ish. */
  private chooseNext(e: Edge): Edge {
    const opts = (this.out.get(e.to) ?? []).map(i => this.edges[i]).filter(n => n.id !== e.twin);
    if (!opts.length) return e.twin >= 0 ? this.edges[e.twin] : e;
    const [ax, ay] = e.pts[e.pts.length - 2], [bx, by] = e.pts[e.pts.length - 1];
    const din = Math.atan2(by - ay, bx - ax);
    const weights = opts.map(n => {
      const [cx, cy] = n.pts[1];
      const turn = Math.cos(Math.atan2(cy - n.pts[0][1], cx - n.pts[0][0]) - din);
      return 0.25 + Math.max(0, turn) * 1.5 + n.speed / 30;
    });
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < opts.length; i++) { r -= weights[i]; if (r <= 0) return opts[i]; }
    return opts[0];
  }

  /** Point at distance s along the car's path (prev → edge → next). */
  private along(c: Car, s: number): XY { return this.alongE(c, s)[0]; }
  private alongE(c: Car, s: number): [XY, Edge] {
    if (s > c.edge.len) return [pointAt(c.next, s - c.edge.len), c.next];
    if (s < 0 && c.prev) return [pointAt(c.prev, c.prev.len + s), c.prev];
    return [pointAt(c.edge, s), c.edge];
  }
  /** Ground height, or the bridge deck height when that part of the path is a bridge. */
  private heightOn(e: Edge, x: number, y: number) { return e.deckAt ? e.deckAt(x, y) : this.H(x, y); }

  /** Curve ahead: how much the road turns over the next stretch (radians). */
  private turnAhead(c: Car, from: number, to: number) {
    const a = this.along(c, c.s + from), b = this.along(c, c.s + (from + to) / 2), d = this.along(c, c.s + to);
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(d[1] - b[1], d[0] - b[0]);
    return Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
  }

  /** Night: how bright the headlight beams on the road are (0..1). */
  setLights(f: number) { this.beam.opacity = 0.4 * f; this.beam.visible = f > 0.01; }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    if (!dt) return;
    // cars per edge, for keeping distance
    const onEdge = new Map<number, Car[]>();
    for (const c of this.cars) (onEdge.get(c.edge.id) ?? onEdge.set(c.edge.id, []).get(c.edge.id)!).push(c);

    for (const c of this.cars) {
      let target = c.edge.speed * c.vmax;
      // ease into curves and junction turns (look further ahead at speed)
      const look = 8 + c.v * 1.6;
      const turn = Math.max(this.turnAhead(c, 2, look), this.turnAhead(c, look * 0.5, look * 1.5));
      target = Math.min(target, 4 + 16 * Math.max(0, 1 - turn / 1.2));
      // keep distance to the car ahead (same edge, or just onto the next one)
      let gap = Infinity;
      for (const o of onEdge.get(c.edge.id) ?? []) if (o !== c && o.s > c.s) gap = Math.min(gap, o.s - c.s);
      for (const o of onEdge.get(c.next.id) ?? []) gap = Math.min(gap, c.edge.len - c.s + o.s);
      if (gap < Infinity) target = Math.min(target, Math.max(0, (gap - 7) * 0.7));
      // smooth throttle/brake: gentle acceleration, firmer braking
      c.v = Math.max(0, c.v + THREE.MathUtils.clamp((target - c.v) * 2, -5, 2.2) * dt);
      c.s += c.v * dt;
      while (c.s > c.edge.len) {
        c.s -= c.edge.len;
        c.prev = c.edge; c.edge = c.next; c.next = this.chooseNext(c.edge);
      }
      this.place(c, 1 - Math.exp(-dt * 8));
      // drove off the map: reappear somewhere inside
      const p = c.mesh.position;
      if (Math.abs(p.x) > this.R + 30 || Math.abs(p.z) > this.R + 30) {
        const inside = this.edges.filter(e => e.pts.some(([x, y]) => Math.abs(x) < this.R - 50 && Math.abs(y) < this.R - 50));
        if (inside.length) this.spawn(inside, inside.reduce((s, e) => s + e.len, 0), c);
      }
    }
  }

  /** Position from front/rear axle points on the path, so cars swing smoothly through bends. */
  private place(c: Car, k: number) {
    const [f, ef] = this.alongE(c, c.s + 1.4), [r, er] = this.alongE(c, c.s - 1.4);
    const want = Math.atan2(f[1] - r[1], f[0] - r[0]);
    c.heading += Math.atan2(Math.sin(want - c.heading), Math.cos(want - c.heading)) * k;
    // keep right: offset by the lane on two-way roads
    const lane = c.edge.lane, rx = Math.sin(c.heading) * lane, ry = -Math.cos(c.heading) * lane;
    const x = (f[0] + r[0]) / 2 + rx, y = (f[1] + r[1]) / 2 + ry;
    const hf = this.heightOn(ef, f[0] + rx, f[1] + ry), hr = this.heightOn(er, r[0] + rx, r[1] + ry);
    c.mesh.visible = !c.edge.tunnel;
    c.mesh.position.set(x, (hf + hr) / 2 + 0.05, -y);
    c.mesh.rotation.set(0, c.heading, Math.atan2(hf - hr, 2.8), 'YZX');
  }
}
