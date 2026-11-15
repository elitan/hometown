// House detail: wall/roof textures (Swedish wood panelling, roof tile rows), instanced windows with white
// frames and reflective glass, front doors and chimneys — the things that stop houses reading as boxes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glowingWindows } from './season';
import { pip, type Poly, type XY } from './geo';
import type { OBB, RoofSpec } from './roofs';

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, S: number) => void, S = 256) {
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  draw(ctx, S);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Vertical board panelling, 2 m tile (u/v are meters on the walls), grey so vertex colours tint it. */
export function wallTexture() {
  const t = canvasTexture((ctx, S) => {
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, S, S);
    const boards = 14, w = S / boards;
    for (let i = 0; i < boards; i++) {
      const l = 232 + Math.round(Math.random() * 18);
      ctx.fillStyle = `rgb(${l},${l},${l})`; ctx.fillRect(i * w, 0, w, S);
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(i * w, 0, 1.6, S);      // groove shadow
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(i * w + 1.6, 0, 1, S); // board edge highlight
    }
  });
  t.repeat.set(0.5, 0.5);
  return t;
}

/** Roof tile rows (v runs up the slope), 2 m tile. */
export function roofTexture() {
  const t = canvasTexture((ctx, S) => {
    ctx.fillStyle = '#d9d9d9'; ctx.fillRect(0, 0, S, S);
    const rows = 6, rh = S / rows, cols = 7, cw = S / cols;
    for (let r = 0; r < rows; r++) {
      const g = ctx.createLinearGradient(0, r * rh, 0, (r + 1) * rh);
      g.addColorStop(0, 'rgba(255,255,255,0.25)'); g.addColorStop(0.75, 'rgba(0,0,0,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
      ctx.fillStyle = g; ctx.fillRect(0, r * rh, S, rh);
      for (let c = 0; c <= cols; c++) {
        const x = c * cw + (r % 2 ? cw / 2 : 0);
        ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x, r * rh, 1.5, rh);
      }
    }
  });
  t.repeat.set(0.5, 0.5);
  return t;
}

/** UVs for a pitched roof: u along the ridge, v up the slope (meters). */
export function roofUVs(g: THREE.BufferGeometry, box: OBB, spec: RoofSpec) {
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  const c = Math.cos(box.angle), s = Math.sin(box.angle), cosP = Math.cos(spec.pitch * Math.PI / 180);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) - box.cx, y = -p.getZ(i) - box.cy;
    const u = x * c + y * s, v = -x * s + y * c;
    uv[i * 2] = u; uv[i * 2 + 1] = (box.short / 2 - Math.abs(v)) / cosP;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Height of the stone plinth the walls stand on (engine.ts draws it). */
export const PLINTH = 0.45;

type Kind = 'house' | 'barn' | 'church' | 'big' | 'shed';

export class HouseDetails {
  readonly group = new THREE.Group();
  private frames: THREE.Matrix4[] = [];
  private glass: THREE.Matrix4[] = [];
  private doors: THREE.Matrix4[] = [];
  private chimneys: THREE.Matrix4[] = [];
  private corners: THREE.Matrix4[] = [];
  private trim: THREE.Matrix4[] = [];

  /**
   * Windows (and a door) along each wall of a footprint. `ground` is the highest ground point of the footprint,
   * `wallTop` the top of the walls (eave) in scene units.
   */
  addWalls(p: Poly, ground: number, wallTop: number, kind: Kind, seed: number) {
    if (kind === 'shed') return;
    const ring = p.outer.slice(0, p.outer.length - (p.outer[0][0] === p.outer[p.outer.length - 1][0] && p.outer[0][1] === p.outer[p.outer.length - 1][1] ? 1 : 0));
    if (ring.length < 3) return;
    const wallH = wallTop - ground;
    if (wallH < 2.4) return;
    const storey = kind === 'big' ? 3.6 : kind === 'church' ? wallH : 2.8;
    const floors = Math.max(1, Math.min(kind === 'big' ? 60 : 8, Math.floor((wallH - 0.4) / storey)));
    const spacing = kind === 'barn' ? 6 : kind === 'big' ? 3.2 : 2.6;
    let longest = -1, longestLen = 0;
    ring.forEach((a, i) => { const b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > longestLen) { longestLen = l; longest = i; } });

    // white corner boards on wooden houses and barns (the falu-red-with-white-trim look)
    if (kind === 'house' || kind === 'barn') {
      const h = wallTop - (ground + PLINTH);
      ring.forEach((v, i) => {
        const prev = ring[(i + ring.length - 1) % ring.length], next = ring[(i + 1) % ring.length];
        const a1 = Math.atan2(v[1] - prev[1], v[0] - prev[0]), a2 = Math.atan2(next[1] - v[1], next[0] - v[0]);
        let turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < 0.5) return; // not a real corner
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a2);
        this.corners.push(new THREE.Matrix4().compose(new THREE.Vector3(v[0], ground + PLINTH + h / 2, -v[1]), q, new THREE.Vector3(1, h, 1)));
      });
    }

    ring.forEach((a, i) => {
      const b: XY = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 2.6) return;
      const ux = dx / L, uy = dy / L;
      // outward normal: whichever side of the edge is outside the footprint
      let nx = uy, ny = -ux;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (pip(mx + nx * 0.3, my + ny * 0.3, p.outer)) { nx = -nx; ny = -ny; }
      // turn the window box so its local +z points along the outward normal. World is x = east, z = -north,
      // and a Y-rotation by yaw sends +z to (sin yaw, 0, cos yaw), so we need sin = nx and cos = -ny.
      const yaw = Math.atan2(nx, -ny);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const n = Math.max(1, Math.floor((L - 1.2) / spacing));
      const doorAt = kind === 'house' && i === longest ? Math.floor(n / 2) + ((seed % 3) - 1) : -1;
      for (let f = 0; f < floors; f++) {
        const sill = ground + 0.95 + f * storey;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n, wx = a[0] + dx * t, wy = a[1] + dy * t;
          const big = kind === 'church' ? 2.2 : 1;
          if (f === 0 && k === doorAt) {
            const pos = new THREE.Vector3(wx + nx * 0.05, ground + 1.05, -(wy + ny * 0.05));
            this.doors.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
            continue;
          }
          const pos = new THREE.Vector3(wx + nx * 0.04, sill + 0.65 * big, -(wy + ny * 0.04));
          this.frames.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, big, 1)));
          pos.set(wx + nx * 0.07, sill + 0.65 * big, -(wy + ny * 0.07));
          this.glass.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, big, 1)));
        }
      }
    });
  }

  /** A chimney through the roof, a little off the ridge centre. */
  addChimney(box: OBB, ridgeY: number, seed: number) {
    const along = ((seed % 5) / 5 - 0.4) * box.long * 0.6;
    const x = box.cx + Math.cos(box.angle) * along, y = box.cy + Math.sin(box.angle) * along;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), box.angle);
    this.chimneys.push(new THREE.Matrix4().compose(new THREE.Vector3(x, ridgeY - 0.3, -y), q, new THREE.Vector3(1, 1, 1)));
  }

  /**
   * Roof edge boards: a fascia under each eave and barge boards up each gable, so the roof has visible
   * thickness and a painted edge instead of a paper-thin plane. `top` is the wall top (eave line).
   */
  addRoofTrim(box: OBB, spec: RoofSpec, top: number) {
    if (spec.type === 'flat') return;
    const { cx, cy, angle, long: L, short: S } = box;
    const o = Math.min(0.5, S * 0.06), tan = Math.tan(spec.pitch * Math.PI / 180);
    const eaveY = top - o * tan, ridgeY = top + (S / 2) * tan;
    const c = Math.cos(angle), s = Math.sin(angle);
    const P = (u: number, v: number, y: number) => new THREE.Vector3(cx + u * c - v * s, y, -(cy + u * s + v * c));
    const Lu = L / 2 + o, Sv = S / 2 + o;
    const board = (a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) => {
      // a 1 x 1 x 1 box stretched from a to b, its thin side facing `out`
      const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
      const x = dir.normalize(), z = out.clone().sub(x.clone().multiplyScalar(out.dot(x))).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      if (y.y > 0) { y.negate(); z.negate(); } // y points down, under the roof edge (the box is symmetric in z)
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      const mid = a.clone().add(b).multiplyScalar(0.5).addScaledVector(y, 0.1);
      this.trim.push(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(len + 0.06, 1, 1)));
    };
    const side = (v: number) => new THREE.Vector3(-s * Math.sign(v), 0, -c * Math.sign(v));
    const end = (u: number) => new THREE.Vector3(c * Math.sign(u), 0, -s * Math.sign(u));
    if (spec.type === 'gabled') {
      for (const v of [-Sv, Sv]) board(P(-Lu, v, eaveY), P(Lu, v, eaveY), side(v));
      for (const u of [-Lu, Lu]) for (const v of [-Sv, Sv]) board(P(u, v, eaveY), P(u, 0, ridgeY), end(u));
    } else {
      for (const v of [-Sv, Sv]) board(P(-Lu, v, eaveY), P(Lu, v, eaveY), side(v));
      for (const u of [-Lu, Lu]) board(P(u, -Sv, eaveY), P(u, Sv, eaveY), end(u));
    }
  }

  /** A window high up in each gable end of a pitched house roof (the attic room). */
  addGableWindows(box: OBB, spec: RoofSpec, top: number) {
    if (spec.type !== 'gabled') return;
    const rise = (box.short / 2) * Math.tan(spec.pitch * Math.PI / 180);
    if (rise < 2.2 || box.short < 6) return;
    const c = Math.cos(box.angle), s = Math.sin(box.angle);
    for (const sgn of [-1, 1]) {
      const u = sgn * (box.long / 2), nx = c * sgn, ny = s * sgn;
      const x = box.cx + u * c, y = box.cy + u * s, h = top + Math.min(rise * 0.38, 1.6) + 0.65;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(nx, -ny));
      this.frames.push(new THREE.Matrix4().compose(new THREE.Vector3(x + nx * 0.04, h, -(y + ny * 0.04)), q, new THREE.Vector3(1, 1, 1)));
      this.glass.push(new THREE.Matrix4().compose(new THREE.Vector3(x + nx * 0.07, h, -(y + ny * 0.07)), q, new THREE.Vector3(1, 1, 1)));
    }
  }

  finish() {
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], shadow = false) => {
      if (!list.length) return;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((x, i) => m.setMatrixAt(i, x));
      m.castShadow = shadow; m.receiveShadow = true;
      this.group.add(m);
    };
    const white = new THREE.MeshStandardMaterial({ color: '#f3f1ea', roughness: 0.6 });
    add(new THREE.BoxGeometry(1.25, 1.45, 0.08), white, this.frames);
    const glass = new THREE.MeshStandardMaterial({ color: '#2b3a46', roughness: 0.08, metalness: 0.1, envMapIntensity: 3 });
    glowingWindows(glass);
    add(new THREE.BoxGeometry(1.03, 1.23, 0.04), glass, this.glass);
    // glazing bars: a vertical bar and one across the upper third, so windows read as Swedish two-pane windows
    add(mergeGeometries([new THREE.BoxGeometry(0.07, 1.23, 0.05), new THREE.BoxGeometry(1.03, 0.06, 0.05).translate(0, 0.2, 0)])!.translate(0, 0, 0.03), white, this.glass);
    add(new THREE.BoxGeometry(0.2, 1, 0.2), white, this.corners);
    add(new THREE.BoxGeometry(1, 0.24, 0.07), white, this.trim, true);
    add(new THREE.BoxGeometry(1.0, 2.1, 0.1), new THREE.MeshStandardMaterial({ color: '#5b3b2a', roughness: 0.7 }), this.doors);
    add(new THREE.BoxGeometry(0.55, 1.6, 0.55).translate(0, 0.8, 0), new THREE.MeshStandardMaterial({ color: '#7a3e30', roughness: 0.85 }), this.chimneys, true);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
  }
}
