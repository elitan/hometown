// House detail: wall/roof textures (Swedish wood panelling, roof tile rows), instanced windows with white
// frames and reflective glass, front doors and chimneys — the things that stop houses reading as boxes.
import * as THREE from 'three';
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

type Kind = 'house' | 'barn' | 'church' | 'big' | 'shed';

export class HouseDetails {
  readonly group = new THREE.Group();
  private frames: THREE.Matrix4[] = [];
  private glass: THREE.Matrix4[] = [];
  private doors: THREE.Matrix4[] = [];
  private chimneys: THREE.Matrix4[] = [];

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
    const floors = Math.max(1, Math.min(8, Math.floor((wallH - 0.4) / storey)));
    const spacing = kind === 'barn' ? 6 : kind === 'big' ? 3.2 : 2.6;
    let longest = -1, longestLen = 0;
    ring.forEach((a, i) => { const b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > longestLen) { longestLen = l; longest = i; } });

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

  finish() {
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], shadow = false) => {
      if (!list.length) return;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((x, i) => m.setMatrixAt(i, x));
      m.castShadow = shadow; m.receiveShadow = true;
      this.group.add(m);
    };
    add(new THREE.BoxGeometry(1.15, 1.3, 0.08), new THREE.MeshStandardMaterial({ color: '#f1efe8', roughness: 0.6 }), this.frames);
    add(new THREE.BoxGeometry(0.95, 1.1, 0.04), new THREE.MeshStandardMaterial({ color: '#2b3a46', roughness: 0.08, metalness: 0.1, envMapIntensity: 3 }), this.glass);
    add(new THREE.BoxGeometry(1.0, 2.1, 0.1), new THREE.MeshStandardMaterial({ color: '#5b3b2a', roughness: 0.7 }), this.doors);
    add(new THREE.BoxGeometry(0.55, 1.6, 0.55).translate(0, 0.8, 0), new THREE.MeshStandardMaterial({ color: '#7a3e30', roughness: 0.85 }), this.chimneys, true);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
  }
}
