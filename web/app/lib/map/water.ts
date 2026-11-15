// Lakes as real water: a flat surface at the shoreline level with animated ripples, reflecting the sky.
import * as THREE from 'three';
import type { Poly } from './geo';

type Height = (x: number, y: number) => number;

/** Tileable ripple normal map, drawn once: a few interfering sine waves, encoded as RGB normals. */
function rippleNormals(size = 256) {
  const h = new Float32Array(size * size);
  const waves = Array.from({ length: 7 }, (_, i) => ({ fx: Math.round(Math.cos(i * 2.1) * (2 + i)), fy: Math.round(Math.sin(i * 1.7) * (2 + i)), a: 1 / (1 + i * 0.6), p: i * 1.3 }));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(((x * w.fx + y * w.fy) / size) * Math.PI * 2 + w.p);
    h[y * size + x] = v;
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
    const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
    const n = new THREE.Vector3(-dx, -dy, 4).normalize(), o = (y * size + x) * 4;
    data[o] = (n.x * 0.5 + 0.5) * 255; data[o + 1] = (n.y * 0.5 + 0.5) * 255; data[o + 2] = (n.z * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export class Water {
  readonly group = new THREE.Group();
  private normals = rippleNormals();
  private offset2 = { value: new THREE.Vector2() };
  private material: THREE.MeshStandardMaterial;
  private t = 0;

  /** `sea`: also lay a sea surface at this scene height (coastal places), under everything else. */
  constructor(lakes: Poly[], H: Height, sea: { y: number; R: number } | null = null) {
    this.normals.repeat.set(1 / 24, 1 / 24);
    this.material = new THREE.MeshStandardMaterial({
      color: '#1f3b4a', roughness: 0.06, metalness: 0, envMapIntensity: 4.5,
      normalMap: this.normals, normalScale: new THREE.Vector2(0.35, 0.35),
    });
    // second, finer ripple layer moving the other way, mixed into the normal-map lookup
    this.material.onBeforeCompile = sh => {
      sh.uniforms.offset2 = this.offset2;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <normalmap_pars_fragment>', '#include <normalmap_pars_fragment>\nuniform vec2 offset2;')
        .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'vec3 mapN = normalize( texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0 + ( texture2D( normalMap, vNormalMapUv * 2.7 + offset2 ).xyz * 2.0 - 1.0 ) * vec3( 0.8, 0.8, 0.0 ) );');
    };

    if (sea) {
      const g = new THREE.PlaneGeometry(sea.R * 2, sea.R * 2).rotateX(-Math.PI / 2).translate(0, sea.y, 0);
      // planar UVs in meters, like the lake shapes (ShapeGeometry uses world coordinates)
      const p = g.attributes.position, uv = new Float32Array(p.count * 2);
      for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i); uv[i * 2 + 1] = -p.getZ(i); }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      this.group.add(m);
    }
    for (const p of lakes) {
      if (p.outer.length < 4) continue;
      // water level: a low percentile of the shoreline height (the DTM is flat over water, shores rise)
      const shore = p.outer.map(([x, y]) => H(x, y)).sort((a, b) => a - b);
      const level = shore[Math.floor(shore.length * 0.2)];
      const shape = new THREE.Shape(p.outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of p.holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, level + 0.12, 0);
      const m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  update(dt: number) {
    this.t += dt;
    this.normals.offset.set(this.t * 0.0035, this.t * 0.002);
    this.offset2.value.set(-this.t * 0.011, this.t * 0.008);
    this.normals.updateMatrix();
  }

  dispose() {
    this.group.removeFromParent();
    this.material.dispose(); this.normals.dispose();
    this.group.traverse(o => (o as THREE.Mesh).geometry?.dispose());
  }
}
