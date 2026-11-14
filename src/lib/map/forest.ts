// Trees: procedural spruce / broadleaf / birch models with soft "foliage" shading, in a few variants,
// detailed near the camera and simple far away (re-bucketed as the camera moves), all instanced.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rand } from './geo';

/** One tree: local position (x east, y north), height and crown radius in meters. */
export type TreeSpec = { x: number; y: number; h: number; r: number };
type Height = (x: number, y: number) => number;
type Sample = (x: number, y: number, r?: number) => THREE.Color | null;

const NEAR = 260; // meters from the camera: detailed models inside, simple ones beyond
const VARIANTS = 3;

// Unit models: spruce is 10 m tall with a 2.6 m crown radius, broadleaf 8.9 m tall with 3.4 m (same as before,
// so per-tree scaling from measured height/crown stays the same).

/** Seeded random so variants are stable between rebuilds. */
function rng(seed: number) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

/**
 * Leaf texture drawn once on a canvas: many small leaves (or needles) in grey shades on transparency,
 * tinted per tree by the instance colour. Alpha-cut on the crowns gives ragged edges and see-through gaps.
 */
function leafTexture(kind: 'leaf' | 'needle') {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!, r = rng(kind === 'leaf' ? 11 : 23);
  const n = kind === 'leaf' ? 1400 : 2600;
  for (let i = 0; i < n; i++) {
    const x = r() * S, y = r() * S, a = r() * Math.PI, l = Math.round(150 + r() * 105);
    ctx.fillStyle = `rgb(${l},${l},${l})`;
    // draw wrapped so the texture tiles seamlessly
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      ctx.save(); ctx.translate(x + ox, y + oy); ctx.rotate(a);
      ctx.beginPath();
      if (kind === 'leaf') ctx.ellipse(0, 0, 5 + r() * 4, 2.6 + r() * 2, 0, 0, Math.PI * 2);
      else ctx.rect(-6, -0.9, 12, 1.8);
      ctx.fill(); ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Crown shading: normals are a blend of "away from the crown centre" (soft, rounded mass of foliage) and the real
 * face normal (keeps clumps readable); vertex colours darken toward the inside/bottom (cheap ambient occlusion).
 */
function foliage(g: THREE.BufferGeometry, center: THREE.Vector3, radius: number, lowY: number, highY: number) {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.computeVertexNormals();
  const p = geo.attributes.position, fn = geo.attributes.normal;
  const n = new Float32Array(p.count * 3), c = new Float32Array(p.count * 3);
  const v = new THREE.Vector3(), f = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i); f.fromBufferAttribute(fn, i);
    const d = v.clone().sub(center);
    const out = Math.min(1, d.length() / radius);
    d.y *= 0.7; d.normalize().multiplyScalar(0.6).addScaledVector(f, 0.4); d.y += 0.15; d.normalize();
    n[i * 3] = d.x; n[i * 3 + 1] = d.y; n[i * 3 + 2] = d.z;
    const up = THREE.MathUtils.clamp((v.y - lowY) / (highY - lowY), 0, 1);
    const ao = 0.5 + 0.32 * out + 0.25 * up;
    c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = ao;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

function jitter(g: THREE.BufferGeometry, amount: number, r: () => number) {
  const p = g.attributes.position;
  // jitter shared positions consistently so the mesh doesn't crack
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    const o = seen.get(k) ?? [(r() - 0.5) * amount, (r() - 0.5) * amount * 0.6, (r() - 0.5) * amount];
    seen.set(k, o);
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  return g;
}

/** Spruce: stacked drooping tiers with a jagged (star-shaped) rim, like branch tips. */
function spruce(seed: number, detailed: boolean) {
  const r = rng(seed + 1);
  const tiers = detailed ? 7 : 2, parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers, rad = 2.6 * (1 - t * 0.85) * (0.9 + r() * 0.2), h = (detailed ? 3.0 : 4.4) * (1 - t * 0.3);
    const y = 1.6 + t * 7.4, segs = detailed ? 14 : 6;
    let cone: THREE.BufferGeometry = new THREE.ConeGeometry(rad, h, segs, 1, true).translate(0, y + h / 2, 0);
    // star rim: pull every other rim vertex inward, and let tips droop
    const p = cone.attributes.position;
    for (let k = 0; k < p.count; k++) {
      if (Math.abs(p.getY(k) - y) > 0.01) continue;
      const ang = Math.atan2(p.getZ(k), p.getX(k)), odd = Math.round((ang / (Math.PI * 2)) * segs) % 2 !== 0;
      const f = odd ? 0.62 : 1;
      p.setXYZ(k, p.getX(k) * f, y - (odd ? 0 : 0.35), p.getZ(k) * f);
    }
    cone.rotateY(r() * Math.PI);
    if (detailed) cone = jitter(cone.toNonIndexed(), 0.25, r);
    parts.push(cone.index ? cone.toNonIndexed() : cone);
  }
  return foliage(mergeGeometries(parts), new THREE.Vector3(0, 5.2, 0), 3, 1.6, 10);
}

/** Broadleaf: a lumpy crown of overlapping leaf clumps, lifted so the trunk shows. */
function broadleaf(seed: number, detailed: boolean) {
  const r = rng(seed + 7), parts: THREE.BufferGeometry[] = [];
  const center = new THREE.Vector3(0, 6.0, 0);
  const clumps = detailed ? 9 : 2;
  for (let i = 0; i < clumps; i++) {
    const a = r() * Math.PI * 2, rr = (detailed ? 1.7 : 1.1) * Math.sqrt(r()), yy = (r() - 0.45) * 2.4;
    const s = (detailed ? 1.25 : 1.9) + r() * 0.7;
    let b = new THREE.IcosahedronGeometry(detailed ? s : s * 1.25, detailed ? 1 : 0).scale(1, 0.85, 1).translate(Math.cos(a) * rr, center.y + yy, Math.sin(a) * rr).toNonIndexed();
    if (detailed) b = jitter(b, 0.35, r);
    parts.push(b);
  }
  return foliage(mergeGeometries(parts), center, 3.4, 3.0, 8.9);
}

function trunk(birch: boolean) {
  const g = new THREE.CylinderGeometry(0.14, 0.3, 5.2, 7).translate(0, 2.6, 0).toNonIndexed();
  const c = new Float32Array(g.attributes.position.count * 3);
  const col = new THREE.Color(birch ? '#e8e4da' : '#5a4433');
  for (let i = 0; i < c.length; i += 3) { c[i] = col.r; c[i + 1] = col.g; c[i + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  return g;
}

function material(map?: THREE.Texture) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, map: map ?? null, alphaTest: map ? 0.45 : 0, side: map ? THREE.DoubleSide : THREE.FrontSide });
  if (map) { map.repeat.set(2.2, 2.2); mat.alphaToCoverage = true; }
  // dissolve trees right in front of the camera (dithered), so a low or chase camera isn't stuck inside crowns
  mat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `void main() {
      float camD = length(vViewPosition);
      if (camD < 14.0 && fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) > (camD - 4.0) / 10.0) discard;`);
  };
  return mat;
}

type Inst = { m: THREE.Matrix4; trunk: THREE.Matrix4; color: THREE.Color; kind: number; variant: number; x: number; y: number; z: number };

export class Forest {
  readonly group = new THREE.Group();
  private items: Inst[] = [];
  // [kind][variant] -> near/far meshes; kind 0 = spruce, 1 = broadleaf
  private near: THREE.InstancedMesh[][] = [];
  private far: THREE.InstancedMesh[] = [];
  private trunks: THREE.InstancedMesh[] = [];
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private lastAt = 0;
  private mats = [material(leafTexture('needle')), material(leafTexture('leaf')), material()];

  constructor(trees: TreeSpec[], H: Height, sample: Sample | null) {
    // spruce vs broadleaf from the aerial photo: spruce canopies read darker from above
    const photo = trees.map(t => sample?.(t.x, t.y, 1) ?? null);
    const light = photo.map(c => c ? c.getHSL({ h: 0, s: 0, l: 0 }).l : NaN);
    const known = light.filter(l => !Number.isNaN(l)).sort((a, b) => a - b);
    const darkCut = known.length ? known[Math.floor(known.length * 0.45)] : 0;

    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), hsl = { h: 0, s: 0, l: 0 };
    trees.forEach((t, i) => {
      const kind = (Number.isNaN(light[i]) ? Math.random() < 0.5 : light[i] <= darkCut) ? 0 : 1;
      const ground = H(t.x, t.y) - 0.3;
      q.setFromAxisAngle(up, rand(0, Math.PI * 2));
      const pos = new THREE.Vector3(t.x, ground, -t.y);
      const sy = t.h / (kind === 0 ? 10 : 8.9), sxz = t.r / (kind === 0 ? 2.6 : 3.4);
      const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(sxz, sy, sxz));
      const tw = Math.min(1.5, Math.max(0.6, t.r / 2.8));
      const tm = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(tw, sy * (kind === 0 ? 0.75 : 1), tw));
      const color = new THREE.Color();
      const real = photo[i];
      if (real) {
        real.getHSL(hsl);
        color.setHSL(THREE.MathUtils.clamp(hsl.h, 0.17, 0.36), THREE.MathUtils.clamp(hsl.s * 1.1, 0.28, 0.55), THREE.MathUtils.clamp(hsl.l * 1.25, 0.16, 0.34));
      } else color.setHSL((kind === 0 ? 0.33 : 0.25) + rand(-0.025, 0.025), rand(0.32, 0.48), rand(0.18, 0.28));
      if (kind === 0) color.offsetHSL(0.02, -0.04, -0.04); // spruce: bluer, darker green
      this.items.push({ m, trunk: tm, color, kind, variant: i % VARIANTS, x: pos.x, y: pos.y + t.h * 0.5, z: pos.z });
    });

    const count = (k: number, v?: number) => this.items.filter(t => t.kind === k && (v === undefined || t.variant === v)).length;
    for (let k = 0; k < 2; k++) {
      const row: THREE.InstancedMesh[] = [];
      for (let v = 0; v < VARIANTS; v++) row.push(this.make(k === 0 ? spruce(v * 31, true) : broadleaf(v * 31, true), count(k, v), this.mats[k]));
      this.near.push(row);
      this.far.push(this.make(k === 0 ? spruce(5, false) : broadleaf(5, false), count(k), this.mats[k]));
    }
    // trunks only matter up close; a few birches among the broadleaves
    this.trunks.push(this.make(trunk(false), this.items.length, this.mats[2]), this.make(trunk(true), this.items.length, this.mats[2]));
  }

  private make(geo: THREE.BufferGeometry, n: number, mat: THREE.Material) {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false; // instances span the whole map
    this.group.add(m);
    return m;
  }

  /** Re-bucket near/far when the camera has moved enough (cheap enough to do a couple of times a second). */
  update(cam: THREE.Vector3, now: number) {
    if (cam.distanceTo(this.lastCam) < 20 && now - this.lastAt < 1500) return;
    if (now - this.lastAt < 250) return;
    this.lastCam.copy(cam); this.lastAt = now;
    const near2 = NEAR * NEAR;
    const nearIdx = this.near.map(row => row.map(() => 0)), farIdx = [0, 0], trunkIdx = [0, 0];
    for (let i = 0; i < this.items.length; i++) {
      const t = this.items[i];
      const dx = t.x - cam.x, dy = t.y - cam.y, dz = t.z - cam.z;
      if (dx * dx + dy * dy + dz * dz < near2) {
        const mesh = this.near[t.kind][t.variant], k = nearIdx[t.kind][t.variant]++;
        mesh.setMatrixAt(k, t.m); mesh.setColorAt(k, t.color);
        const birch = t.kind === 1 && i % 5 === 0 ? 1 : 0;
        this.trunks[birch].setMatrixAt(trunkIdx[birch]++, t.trunk);
      } else {
        const mesh = this.far[t.kind], k = farIdx[t.kind]++;
        mesh.setMatrixAt(k, t.m); mesh.setColorAt(k, t.color);
      }
    }
    const done = (m: THREE.InstancedMesh, n: number) => {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };
    this.near.forEach((row, k) => row.forEach((m, v) => done(m, nearIdx[k][v])));
    this.far.forEach((m, k) => done(m, farIdx[k]));
    this.trunks.forEach((m, k) => done(m, trunkIdx[k]));
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(o => (o as THREE.Mesh).geometry?.dispose());
    for (const m of this.mats) { m.map?.dispose(); m.dispose(); }
  }
}
