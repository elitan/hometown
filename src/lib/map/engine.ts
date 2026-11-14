// Three.js map engine: terrain + draped map texture, buildings, trees, labels, hover names, camera.
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LocalProjection, inPoly, pick, polygons, rand, segDist, toXY, type OsmData, type Poly, type XY } from './geo';
import type { Elevation, Imagery, LaserTrees, Surface } from './sources';
import { measureRoof, obb, polyArea, roofGeometry, roofSpec } from './roofs';
import { Traffic, type Car, type RoadWay } from './traffic';
import { Railway, type RailWay, type Train } from './rail';
import { Post, fitShadow, groundMaterial, installSky } from './look';
import { Water } from './water';
import { Forest, type TreeSpec } from './forest';
import { HouseDetails, roofTexture, roofUVs, wallTexture } from './houses';
import { bridgeGeometry, isBridge, isTunnel, makeDeckAt, type Bridge } from './bridges';
import {
  FIELDS, GROUND, LAND, LAND_ORDER, PLACE_KINDS, ROAD, ROOFS, UNPAVED, WALLS, WATER, buildingHeight, pretty, type MapStyle,
} from './styles';

export type BuildInput = { P: LocalProjection; data: OsmData; elev: Elevation | null; img: Imagery | null; laser: LaserTrees | null; surface?: Surface | null; R: number; exag: number; style: MapStyle };
export type BuildStats = { buildings: number; roofsMeasured: number; trees: number; treeSource?: 'laser' | 'estimated'; elevMin: number | null; elevMax: number | null };
type Named = { name: string; kind: string };
type Sample = (x: number, y: number, r?: number) => THREE.Color | null;
type Label = { name: string; x: number; y: number; h: number; kind: 'place' | 'water'; el: HTMLDivElement };

export type EngineDom = { container: HTMLElement; labels: HTMLElement; tip: HTMLElement; compass: HTMLElement };

function paint(g: THREE.BufferGeometry, hex: THREE.ColorRepresentation, roofHex?: THREE.ColorRepresentation) {
  const c = new THREE.Color(hex), r = roofHex !== undefined ? new THREE.Color(roofHex) : c;
  const n = g.attributes.position.count, nrm = g.attributes.normal, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const col = roofHex !== undefined && nrm.getY(i) > 0.5 ? r : c;
    a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
/** Split a building into wall faces and roof faces (by facing), dropping hidden floors. Keeps uv + colour. */
function splitFacing(g: THREE.BufferGeometry) {
  const geo = g.index ? g.toNonIndexed() : g;
  const names = ['position', 'normal', 'uv', 'color'] as const;
  const walls: Record<string, number[]> = {}, roofs: Record<string, number[]> = {};
  for (const n of names) { walls[n] = []; roofs[n] = []; }
  const pos = geo.attributes.position, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const ny = c.clone().sub(b).cross(a.clone().sub(b)).normalize().y;
    const out = ny > 0.25 ? roofs : ny > -0.5 ? walls : null;
    if (!out) continue;
    for (const n of names) {
      const attr = geo.attributes[n], k = attr.itemSize;
      for (let j = 0; j < 3; j++) for (let q = 0; q < k; q++) out[n].push(attr.array[(i + j) * k + q]);
    }
  }
  const mk = (d: Record<string, number[]>) => {
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(d.position, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(d.normal, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
    out.setAttribute('color', new THREE.Float32BufferAttribute(d.color, 3));
    return out;
  };
  return { walls: mk(walls), roofs: mk(roofs) };
}
function clean(ring: XY[]) {
  const r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r.map(([x, y]) => new THREE.Vector2(x, y));
}
function shape(poly: Poly) {
  const s = new THREE.Shape(clean(poly.outer));
  for (const h of poly.holes) s.holes.push(new THREE.Path(clean(h)));
  return s;
}

/**
 * Typical roof colour from the photo: sample a grid inside the footprint (away from its edges),
 * drop vegetation-coloured pixels (overhanging trees, misaligned lawn) and take the per-channel median.
 */
function roofColor(p: Poly, sample: Sample): THREE.Color | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const step = Math.max(0.8, Math.min(x1 - x0, y1 - y0) / 8), m = 1.2;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [], hsl = { h: 0, s: 0, l: 0 };
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) {
    if (![[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([dx, dy]) => inPoly(x + dx, y + dy, p))) continue;
    const c = sample(x, y, 0);
    if (!c) continue;
    c.getHSL(hsl);
    if (hsl.h > 0.16 && hsl.h < 0.45 && hsl.s > 0.12) continue; // looks like vegetation
    rs.push(c.r); gs.push(c.g); bs.push(c.b);
  }
  if (rs.length < 3) return null;
  const med = (a: number[]) => a.sort((u, v) => u - v)[a.length >> 1];
  return new THREE.Color(med(rs), med(gs), med(bs));
}

/** Wall colour guess from the real roof colour: tile roofs sit on light render/brick, dark roofs often on falu-red wood. */
function wallFor(roof: THREE.Color | null, kind: 'house' | 'barn' | 'church') {
  if (kind === 'church') return '#f6f3ec';
  if (kind === 'barn') return pick(['#9c3a26', '#a8452e', '#8f3524']);
  if (!roof) return pick(WALLS);
  const { h, s } = roof.getHSL({ h: 0, s: 0, l: 0 });
  const tile = s > 0.22 && (h < 0.09 || h > 0.94);
  return tile ? pick(['#f4f1ea', '#efe3bf', '#f2e6c9', '#e9d9a6', '#ddd6c8'])
              : pick(['#a8452e', '#9c3a26', '#f4f1ea', '#ddd6c8', '#efe3bf']);
}

export class MapEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: MapControls;
  private sun = new THREE.DirectionalLight(0xffeccc, 2.6);
  private world: THREE.Group | null = null;
  private fly: { from: THREE.Vector3; fromT: THREE.Vector3; pos: THREE.Vector3; target: THREE.Vector3; t0: number; ms: number } | null = null;
  private H: (x: number, y: number) => number = () => 0;
  private R = 1000;
  private named = { buildings: [] as (Named & { p: Poly })[], roads: [] as (Named & { pts: XY[]; w: number })[], areas: [] as (Named & { polys: Poly[]; water: boolean })[] };
  private labels: Label[] = [];
  private homeView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private tipRaf = 0;
  private disposed = false;
  onUserInteract?: () => void;
  private lastNow = 0;
  private frameNo = 0;
  private traffic: Traffic | null = null;
  private railway: Railway | null = null;
  private water: Water | null = null;
  /** Follow cam: the vehicle being followed, and callbacks for the HUD. */
  private follow: { name: string; pose: () => { pos: THREE.Vector3; fwd: THREE.Vector3; kmh: number; back: number; up: number } | null; hudAt: number } | null = null;
  private followLook = new THREE.Vector3();
  onFollow?: (name: string, kmh: number) => void;
  onFollowEnd?: () => void;
  private downAt: [number, number] | null = null;
  private trafficOn = true;

  constructor(private dom: EngineDom) {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(dom.container.clientWidth, dom.container.clientHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in recent three.js
    r.shadowMap.autoUpdate = false; // refreshed every other frame in tick()
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.75;
    dom.container.appendChild(r.domElement);

    // haze toward the horizon, matched to the sky colour near the horizon
    this.scene.fog = new THREE.Fog(0xc4d3de, 2600, 6500);
    installSky(r, this.scene);
    this.camera = new THREE.PerspectiveCamera(45, dom.container.clientWidth / dom.container.clientHeight, 1, 14000);
    this.camera.position.set(0, 2000, 600);
    const c = this.controls = new MapControls(this.camera, r.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.46; c.minDistance = 25; c.maxDistance = 5000;
    c.zoomToCursor = true;
    c.addEventListener('start', () => { this.fly = null; this.stopFollow(); this.onUserInteract?.(); });

    this.scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x6b7a52, 0.35)); // sky light mostly comes from the environment map
    this.sun.color.set(0xfff0dc);
    this.sun.intensity = 3.4;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.15;
    this.scene.add(this.sun, this.sun.target);

    addEventListener('resize', this.onResize);
    r.domElement.addEventListener('pointermove', this.onPointerMove);
    r.domElement.addEventListener('pointerdown', e => { this.downAt = [e.clientX, e.clientY]; });
    r.domElement.addEventListener('pointerup', this.onClick);
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    r.domElement.addEventListener('pointerleave', this.hideTip);
    this.post = new Post(r, this.scene, this.camera, dom.container.clientWidth, dom.container.clientHeight);
    r.setAnimationLoop(this.tick);
  }
  private post: Post;

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    removeEventListener('resize', this.onResize);
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    this.clearWorld();
    this.controls.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.dom.labels.innerHTML = '';
  }

  // ---------- loop / camera ----------

  private onResize = () => {
    const { clientWidth: w, clientHeight: h } = this.dom.container;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
  };

  private tick = (now: number) => {
    const dt = this.lastNow ? (now - this.lastNow) / 1000 : 0;
    this.lastNow = now;
    if (this.trafficOn) { this.traffic?.update(dt); this.railway?.update(dt); }
    this.water?.update(dt);
    this.forest?.update(this.camera.position, now);
    this.applyKeys(dt);
    if (this.follow) this.updateFollow(dt, now);
    else if (this.fly) {
      const f = this.fly, k = Math.min(1, (now - f.t0) / f.ms), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(f.from, f.pos, e);
      this.controls.target.lerpVectors(f.fromT, f.target, e);
      if (k >= 1) this.fly = null;
    }
    if (!this.follow) this.controls.update();
    const center = this.follow ? this.followLook : this.controls.target;
    fitShadow(this.sun, center, this.camera.position.distanceTo(center), this.R * 1.35);
    if ((this.frameNo++ & 1) === 0) this.renderer.shadowMap.needsUpdate = true;
    this.post.render();
    this.updateLabels();
    this.dom.compass.style.transform = `rotate(${THREE.MathUtils.radToDeg(this.controls.getAzimuthalAngle())}deg)`;
  };

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, ms = 1600) {
    this.fly = { from: this.camera.position.clone(), fromT: this.controls.target.clone(), pos, target, t0: performance.now(), ms };
  }

  resetNorth() {
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off); sph.theta = 0;
    this.flyTo(this.controls.target.clone().add(new THREE.Vector3().setFromSpherical(sph)), this.controls.target.clone(), 700);
  }
  zoom(f: number) {
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f);
    const len = THREE.MathUtils.clamp(off.length(), this.controls.minDistance, this.controls.maxDistance);
    this.flyTo(this.controls.target.clone().add(off.setLength(len)), this.controls.target.clone(), 350);
  }
  /** Fly to a lat/lon on the current map, looking at it from `dist` meters away. */
  focus(lat: number, lon: number, dist = 120) {
    const ctx = this.treeCtx;
    if (!ctx) return;
    const [x, y] = ctx.P.proj(lat, lon), h = ctx.H(x, y);
    const target = new THREE.Vector3(x, h, -y);
    this.flyTo(target.clone().add(new THREE.Vector3(dist * 0.45, dist * 0.6, dist * 0.65)), target, 1200);
  }
  /** Fixed camera views for visual comparison while developing: [lat, lon, distance, height factor]. */
  debugView(lat: number, lon: number, dist: number, heightK = 0.6, yaw = 0.6) {
    const ctx = this.treeCtx;
    if (!ctx) return;
    this.stopFollow();
    const [x, y] = ctx.P.proj(lat, lon), h = ctx.H(x, y);
    const target = new THREE.Vector3(x, h + 2, -y);
    this.fly = null;
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(Math.sin(yaw) * dist, dist * heightK, Math.cos(yaw) * dist));
    this.camera.lookAt(target);
  }
  home() { if (this.homeView) this.flyTo(this.homeView.pos.clone(), this.homeView.target.clone(), 1200); }
  screenshot() {
    this.post.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ---------- build ----------

  private clearWorld() {
    this.stopFollow();
    if (!this.world) return;
    this.world.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      // some meshes (cars) have one material per part
      const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as THREE.MeshStandardMaterial[];
      for (const mat of mats) { mat.map?.dispose(); mat.dispose(); }
    });
    this.scene.remove(this.world);
    this.world = null;
    this.forest?.dispose();
    this.forest = null;
    this.treeCtx = null;
    this.traffic?.dispose();
    this.traffic = null;
    this.railway?.dispose();
    this.railway = null;
    this.water?.dispose();
    this.water = null;
  }

  build({ P, data, elev, img, laser, surface, R, exag, style }: BuildInput, animate: boolean): BuildStats {
    if (this.disposed) return { buildings: 0, roofsMeasured: 0, trees: 0, elevMin: null, elevMax: null };
    this.clearWorld();
    const world = this.world = new THREE.Group();
    this.scene.add(world);

    // terrain height in local meters, lowest point in the area ≈ 0
    const hiRes = elev?.source === 'lantmateriet';
    const seg = Math.min(hiRes ? 500 : 300, Math.round(2 * R / (hiRes ? 4 : 8)));
    let base = Infinity, top = -Infinity;
    if (elev) for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
      const h = elev.at(...P.unproj(-R + i * R / 12, -R + j * R / 12)); base = Math.min(base, h); top = Math.max(top, h);
    }
    const H = this.H = elev ? (x: number, y: number) => (elev.at(...P.unproj(x, y)) - base) * exag : () => 0;
    this.R = R;

    const { tex, forests, sample, roofTints } = this.drawMapTexture(P, data, R, style, img);
    const g = new THREE.PlaneGeometry(2 * R, 2 * R, seg, seg).rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) { const y = H(pos.getX(i), -pos.getZ(i)); pos.setY(i, y); minY = Math.min(minY, y); }
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, groundMaterial(tex, R));
    ground.receiveShadow = true;
    world.add(ground);
    world.add(this.skirt(H, R, seg, minY - 30));

    // buildings (sunk below the lowest footprint point), named things, places
    const wallGeos: THREE.BufferGeometry[] = [], roofGeos: THREE.BufferGeometry[] = [], details = new HouseDetails(), treePts: XY[] = [], places: { name: string; xy: XY }[] = [];
    const named: typeof this.named = { buildings: [], roads: [], areas: [] };
    let buildingCount = 0, roofsMeasured = 0;
    const heightAt = surface ? (x: number, y: number) => surface.at(...P.unproj(x, y)) : null;
    const drivable: RoadWay[] = [], bridges: Bridge[] = [], railWays: RailWay[] = [], lakes: Poly[] = [];

    const inside = ([x, y]: XY) => Math.abs(x) < R && Math.abs(y) < R;
    for (const el of data.elements) {
      const t = el.tags || {};
      if (el.type === 'node') {
        if (t.natural === 'tree') treePts.push(P.proj(el.lat!, el.lon!));
        if (t.place && t.name && PLACE_KINDS.has(t.place)) places.push({ name: t.name, xy: P.proj(el.lat!, el.lon!) });
        continue;
      }
      if (t.building) {
        for (const p of polygons(P, el)) {
          if (!p.outer.some(inside)) continue;
          let cx = 0, cy = 0;
          for (const [x, y] of p.outer) { cx += x; cy += y; }
          cx /= p.outer.length; cy /= p.outer.length;
          const hs = [...p.outer, [cx, cy] as XY].map(([x, y]) => H(x, y));
          const lo = Math.min(...hs) - 1.5 * exag, hi = Math.max(...hs);
          try {
            let box = obb(p.outer);
            let spec = roofSpec(t, box, polyArea(p) / Math.max(1, box.long * box.short));
            // real roof shape from the laser data when it's clean enough (OSM height/roof tags still win)
            const measured = heightAt && !t.height && !t['roof:shape'] ? measureRoof(p, box, heightAt) : null;
            if (measured) { box = measured.box; spec = measured.spec; roofsMeasured++; }
            const walls = spec.type === 'flat' ? (measured ? spec.eave : buildingHeight(t)) : spec.eave;
            const geo = new THREE.ExtrudeGeometry(shape(p), { depth: walls + (hi - lo), bevelEnabled: false });
            geo.rotateX(-Math.PI / 2).translate(0, lo, 0);
            const barn = /barn|farm_auxiliary|shed/.test(t.building);
            const church = t.building === 'church' || t.amenity === 'place_of_worship';
            const real = roofTints.get(p) ?? null;
            const roof: THREE.ColorRepresentation = real ? real.clone().multiplyScalar(1.1) : church ? '#55504b' : pick(ROOFS);
            const wall = wallFor(real, church ? 'church' : barn ? 'barn' : 'house');
            const parts = [paint(geo, wall, roof)];
            if (spec.type !== 'flat') parts.push(paint(roofUVs(roofGeometry(box, spec, hi + walls), box, spec), wall, roof));
            for (const g of parts) { const sp = splitFacing(g); wallGeos.push(sp.walls); roofGeos.push(sp.roofs); g.dispose(); }
            // windows, a front door, and a chimney on most pitched house roofs
            const b = t.building, lv = parseFloat(t['building:levels']);
            const kind = church ? 'church' : /barn|farm_auxiliary|stable|cowshed/.test(b) ? 'barn'
              : /garage|garages|shed|carport|greenhouse|roof|hut/.test(b) ? 'shed'
              : /apartments|industrial|commercial|retail|office|school|warehouse|hospital|public/.test(b) || lv >= 3 ? 'big' : 'house';
            details.addWalls(p, hi, hi + walls, kind, el.id);
            if (kind === 'house' && spec.type !== 'flat' && el.id % 10 < 7) details.addChimney(box, hi + walls + (box.short / 2) * Math.tan(spec.pitch * Math.PI / 180), el.id);
            buildingCount++;
          } catch { /* degenerate footprint */ }
          named.buildings.push({
            p, name: t.name || (t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim() : ''),
            kind: t.building === 'yes' ? (t.amenity ? pretty(t.amenity) : 'Building') : pretty(t.building),
          });
        }
        continue;
      }
      if ((t.highway || t.railway === 'rail') && el.type === 'way' && el.geometry && el.geometry.length > 1 && isBridge(t)) {
        bridges.push({ pts: toXY(P, el.geometry), width: t.railway ? 4 : (ROAD[t.highway]?.[0] ?? 3), rail: !!t.railway });
      }
      if (/^(rail|light_rail|narrow_gauge)$/.test(t.railway ?? '') && el.type === 'way' && el.geometry && el.geometry.length > 1 && t.service !== 'yard') {
        const pts = toXY(P, el.geometry);
        railWays.push({ pts, bridgeAt: isBridge(t) ? makeDeckAt(pts, H) : undefined, tunnel: isTunnel(t) });
      }
      if (t.highway && el.type === 'way' && el.geometry && el.geometry.length > 1 && t.area !== 'yes' && /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/.test(t.highway)) {
        const pts = toXY(P, el.geometry);
        if (t.oneway === '-1') pts.reverse();
        drivable.push({
          pts, highway: t.highway.replace('_link', ''), oneway: t.oneway === 'yes' || t.oneway === '-1' || t.junction === 'roundabout' || t.highway === 'motorway',
          deckAt: isBridge(t) ? makeDeckAt(pts, H) : undefined, tunnel: isTunnel(t),
        });
      }
      if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') lakes.push(...polygons(P, el));
      if (!t.name) continue;
      if (t.highway && el.geometry) named.roads.push({ pts: toXY(P, el.geometry), w: ROAD[t.highway]?.[0] ?? 3, name: t.name, kind: pretty(t.highway) + ' road' });
      else if (t.waterway && el.geometry && t.waterway !== 'riverbank') named.roads.push({ pts: toXY(P, el.geometry), w: 4, name: t.name, kind: pretty(t.waterway) });
      else if (t.natural === 'water' || t.landuse || t.leisure || t.natural) {
        const isWater = t.natural === 'water';
        named.areas.push({ polys: polygons(P, el), name: t.name, kind: isWater ? pretty(t.water || 'lake') : pretty(t.landuse || t.leisure || t.natural), water: isWater });
      }
    }
    this.named = named;
    const addBuildingMesh = (geos: THREE.BufferGeometry[], map: THREE.Texture, roughness: number) => {
      if (!geos.length) return;
      const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness }));
      m.castShadow = m.receiveShadow = true;
      world.add(m);
    };
    addBuildingMesh(wallGeos, wallTexture(), 0.85);
    addBuildingMesh(roofGeos, roofTexture(), 0.75);
    details.finish();
    world.add(details.group);

    // bridges (the bare-earth terrain has none)
    const decks = bridges.flatMap(b => bridgeGeometry(b, H));
    if (decks.length) {
      const m = new THREE.Mesh(mergeGeometries(decks), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      m.castShadow = m.receiveShadow = true;
      world.add(m);
    }

    // lakes with real water surfaces
    if (lakes.length) { this.water = new Water(lakes, H); world.add(this.water.group); }

    // railway track + trains
    if (railWays.length) {
      this.railway = new Railway(railWays, H, R);
      world.add(this.railway.group);
    }

    // traffic on the drivable roads
    if (drivable.length) {
      this.traffic = new Traffic(drivable, H, R);
      this.traffic.group.visible = this.trafficOn;
      world.add(this.traffic.group);
    }

    // trees: real laser-measured trees when available, otherwise scatter in forest polygons + mapped trees
    this.treeCtx = { world, P, R, H, sample, buildings: named.buildings.map(b => b.p), bridges };
    const stats = { buildings: buildingCount, roofsMeasured, elevMin: elev ? Math.round(base) : null, elevMax: elev ? Math.round(top) : null };
    if (laser?.trees.length) {
      const n = this.setLaserTrees(laser);
      this.finishBuild(R, H, places, named, inside, animate);
      return { ...stats, trees: n, treeSource: 'laser' };
    }
    const MAX = 26000, spacing = 110;
    for (const f of forests) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of f.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      x0 = Math.max(x0, -R); x1 = Math.min(x1, R); y0 = Math.max(y0, -R); y1 = Math.min(y1, R);
      if (x0 >= x1 || y0 >= y1) continue;
      const tries = (x1 - x0) * (y1 - y0) / spacing;
      for (let i = 0; i < tries && treePts.length < MAX; i++) {
        const x = rand(x0, x1), y = rand(y0, y1);
        if (inPoly(x, y, f)) treePts.push([x, y]);
      }
    }
    const trees = treePts.filter(inside).map(([x, y]) => ({ x, y, h: rand(8, 13), r: rand(2, 3.2) }));
    this.replaceTrees(trees);
    this.finishBuild(R, H, places, named, inside, animate);
    return { ...stats, trees: trees.length, treeSource: 'estimated' };
  }

  private treeCtx: { world: THREE.Group; P: LocalProjection; R: number; H: (x: number, y: number) => number; sample: Sample | null; buildings: Poly[]; bridges: Bridge[] } | null = null;
  private forest: Forest | null = null;

  setTraffic(on: boolean) {
    this.trafficOn = on;
    if (!on) this.stopFollow();
    if (this.traffic) this.traffic.group.visible = on;
  }

  /** Swap the current trees (estimated or real) for a new set, keeping the rest of the scene. */
  private replaceTrees(trees: TreeSpec[]) {
    const ctx = this.treeCtx;
    if (!ctx) return;
    this.forest?.dispose();
    this.forest = new Forest(trees, ctx.H, ctx.sample);
    ctx.world.add(this.forest.group);
    this.forest.update(this.camera.position, performance.now() + 1e6);
  }


  /** Replace the trees with laser-measured ones (can arrive after the map is already shown). Returns the count. */
  setLaserTrees(laser: LaserTrees) {
    const ctx = this.treeCtx;
    if (!ctx || this.disposed) return 0;
    const blocked = this.buildingMask(ctx.buildings, ctx.R, ctx.bridges);
    const real: TreeSpec[] = [];
    for (const [lon, lat, h, r] of laser.trees) {
      const [x, y] = ctx.P.proj(lat, lon);
      if (Math.abs(x) < ctx.R && Math.abs(y) < ctx.R && !blocked(x, y)) real.push({ x, y, h, r });
    }
    if (real.length > 60000) real.sort((a, b) => b.h - a.h).length = 60000; // keep the biggest if there are very many
    this.replaceTrees(real);
    return real.length;
  }

  /** 1 m raster of building footprints (+1.5 m margin) so laser "trees" on roofs are dropped. */
  private buildingMask(polys: Poly[], R: number, bridges: Bridge[] = []) {
    const S = Math.ceil(2 * R), cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.lineJoin = ctx.lineCap = 'round';
    for (const p of polys) {
      ctx.beginPath();
      p.outer.forEach(([x, y], i) => { const a = x + R, b = R - y; if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // bridge decks show up in the laser data as tall "vegetation" too
    for (const b of bridges) {
      ctx.lineWidth = b.width + 4; ctx.beginPath();
      b.pts.forEach(([x, y], i) => { const a = x + R, c = R - y; if (i) ctx.lineTo(a, c); else ctx.moveTo(a, c); });
      ctx.stroke();
    }
    const d = ctx.getImageData(0, 0, S, S).data;
    return (x: number, y: number) => {
      const px = Math.floor(x + R), py = Math.floor(R - y);
      return px >= 0 && py >= 0 && px < S && py < S && d[(py * S + px) * 4 + 3] > 0;
    };
  }

  /** Labels for places and named lakes, then lighting/camera framing. */
  private finishBuild(R: number, H: (x: number, y: number) => number, places: { name: string; xy: XY }[],
                      named: MapEngine['named'], inside: (p: XY) => boolean, animate: boolean) {
    const lbl: Omit<Label, 'el' | 'h'>[] = places.filter(p => inside(p.xy)).map(p => ({ name: p.name, x: p.xy[0], y: p.xy[1], kind: 'place' as const }));
    for (const a of named.areas) if (a.water) {
      const big = a.polys.reduce<Poly | null>((m, p) => p.outer.length > (m?.outer.length || 0) ? p : m, null);
      if (!big) continue;
      let sx = 0, sy = 0;
      for (const [x, y] of big.outer) { sx += x; sy += y; }
      const c: XY = [sx / big.outer.length, sy / big.outer.length];
      if (inside(c)) lbl.push({ name: a.name, x: c[0], y: c[1], kind: 'water' });
    }
    this.setLabels(lbl.map(l => ({ ...l, h: H(l.x, l.y) + (l.kind === 'place' ? 45 : 4) })));

    this.frame(R, H(0, 0), animate);
  }

  private skirt(H: (x: number, y: number) => number, R: number, seg: number, bottom: number) {
    const sp: number[] = [], sc: number[] = [], si: number[] = [];
    const soilTop = new THREE.Color('#7a5c43'), soilBot = new THREE.Color('#3f2f24');
    const edges: [XY, XY][] = [[[-R, R], [R, R]], [[R, R], [R, -R]], [[R, -R], [-R, -R]], [[-R, -R], [-R, R]]];
    for (const [[ax, ay], [bx, by]] of edges) {
      const off = sp.length / 3;
      for (let t = 0; t <= seg; t++) {
        const x = ax + (bx - ax) * t / seg, y = ay + (by - ay) * t / seg;
        sp.push(x, H(x, y), -y, x, bottom, -y);
        sc.push(soilTop.r, soilTop.g, soilTop.b, soilBot.r, soilBot.g, soilBot.b);
        if (t) { const q = off + (t - 1) * 2; si.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    g.setIndex(si); g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  private frame(R: number, mid: number, animate: boolean) {
    const cl = R + 0.5;
    this.renderer.clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), cl), new THREE.Plane(new THREE.Vector3(-1, 0, 0), cl),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), cl), new THREE.Plane(new THREE.Vector3(0, 0, -1), cl),
    ];
    const fog = this.scene.fog as THREE.Fog;
    fog.near = R * 2.2; fog.far = R * 5.5;
    const fit = this.camera.aspect < 1 ? 1 / Math.sqrt(this.camera.aspect) : 1; // portrait screens stand further back
    this.homeView = { pos: new THREE.Vector3(0, mid + R * 0.95 * fit, R * 1.45 * fit), target: new THREE.Vector3(0, mid, 0) };
    if (animate) {
      this.camera.position.set(R * 0.1, mid + R * 3, R * 0.4);
      this.controls.target.set(0, mid, 0);
      this.flyTo(this.homeView.pos.clone(), this.homeView.target.clone(), 2200);
    } else {
      // keep the current view, just re-seat the target on the new terrain
      const t = this.controls.target, dy = this.H(t.x, -t.z) - t.y;
      t.y += dy; this.camera.position.y += dy;
    }
  }

  // ---------- map texture (2D layers draped over terrain) ----------

  private drawMapTexture(P: LocalProjection, data: OsmData, R: number, style: MapStyle, img: Imagery | null) {
    const S = Math.min(4096, this.renderer.capabilities.maxTextureSize);
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    const k = S / (2 * R);
    const px = ([x, y]: XY) => [(x + R) * k, (R - y) * k] as const;
    const trace = (ring: XY[]) => ring.forEach((p, i) => { const [a, b] = px(p); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
    const fill = (polys: Poly[], color: string) => {
      ctx.beginPath();
      for (const p of polys) { trace(p.outer); ctx.closePath(); for (const h of p.holes) { trace(h); ctx.closePath(); } }
      ctx.fillStyle = color; ctx.fill('evenodd');
    };
    const stroke = (pts: XY[], w: number, color: string) => {
      ctx.beginPath(); trace(pts);
      ctx.lineWidth = Math.max(w * k, 1); ctx.strokeStyle = color; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke();
    };

    const land: { polys: Poly[]; color: string; order: number }[] = [], waterPolys: Poly[] = [], waterLines: { pts: XY[]; w: number }[] = [];
    const roads: { pts: XY[]; w: number; c: string; paved: boolean }[] = [], forests: Poly[] = [], footprints: Poly[] = [];
    for (const el of data.elements) {
      const t = el.tags || {};
      if (t.building) { footprints.push(...polygons(P, el)); continue; }
      if ((t.highway || t.railway) && (isBridge(t) || isTunnel(t))) continue; // bridges get a deck; tunnels are underground
      if (t.highway && el.type === 'way' && el.geometry && t.area !== 'yes') {
        const [w, c] = ROAD[t.highway] || [3, '#8a8a8a'];
        roads.push({ pts: toXY(P, el.geometry), w, c, paved: !UNPAVED.has(t.highway) });
      } else if (t.railway === 'rail' && el.geometry) {
        // drawn in 3D by rail.ts
      } else if (t.waterway && el.type === 'way' && el.geometry && t.waterway !== 'riverbank') {
        const widths: Record<string, number> = { river: 10, canal: 8, stream: 2.5, ditch: 1.5, drain: 1.5 };
        waterLines.push({ pts: toXY(P, el.geometry), w: widths[t.waterway] ?? 2 });
      } else if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') {
        waterPolys.push(...polygons(P, el));
      } else {
        const kind = t.landuse || t.natural || t.leisure;
        const color = kind === 'farmland' ? pick(FIELDS) : LAND[kind];
        if (!color) continue;
        const polys = polygons(P, el);
        land.push({ polys, color, order: LAND_ORDER[kind] ?? 2 });
        if (kind === 'forest' || kind === 'wood') forests.push(...polys);
      }
    }

    const photo = !!img && style !== 'illustrated';
    let sample: Sample | null = null;
    const roofTints = new Map<Poly, THREE.Color>();
    if (photo && img) {
      const [ax, ay] = img.px(...P.unproj(-R, R)), [bx, by] = img.px(...P.unproj(R, -R));
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = 'saturate(1.12) contrast(1.06) brightness(1.04)';
      ctx.drawImage(img.cv, ax, ay, bx - ax, by - ay, 0, 0, S, S);
      ctx.filter = 'none';
      sample = this.makeSampler(cv, R);
      // one smooth colour per roof: the median of its interior photo pixels, ignoring vegetation
      for (const p of footprints) { const c = roofColor(p, sample); if (c) roofTints.set(p, c); }
    } else {
      ctx.fillStyle = GROUND; ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < S * S / 60; i++) { // subtle grass grain
        ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,240,.05)' : 'rgba(20,50,10,.05)';
        ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
      }
      land.sort((a, b) => a.order - b.order).forEach(l => fill(l.polys, l.color));
    }

    if (style !== 'satellite' || !photo) {
      ctx.globalAlpha = photo ? 0.85 : 1;
      // lake beds: dark and wet-looking; the actual water surface is a 3D mesh (water.ts), and wherever the bank
      // rises above the water level this is what shows, so it must read as shore, not as painted water
      if (waterPolys.length) { ctx.save(); ctx.globalAlpha = 1; fill(waterPolys, '#3b4a43'); ctx.restore(); }
      waterLines.forEach(l => stroke(l.pts, l.w, WATER));
      roads.sort((a, b) => a.w - b.w);
      roads.filter(r => r.paved).forEach(r => stroke(r.pts, r.w + 1.4, '#4d4a45'));
      roads.forEach(r => stroke(r.pts, r.w, r.c));
      ctx.globalAlpha = 1;
    }

    // contact shadow under every building so houses feel planted, not floating
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 2.5 * k;
    fill(footprints, 'rgba(40,36,30,.75)');
    ctx.restore();

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return { tex, forests, sample, roofTints };
  }

  /** Low-res copy of the photo texture for sampling roof and tree colors. */
  private makeSampler(cv: HTMLCanvasElement, R: number): Sample {
    const SS = 2048, sc = document.createElement('canvas'); sc.width = sc.height = SS;
    const sctx = sc.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(cv, 0, 0, SS, SS);
    const sd = sctx.getImageData(0, 0, SS, SS).data, sk = SS / (2 * R);
    return (x, y, r = 1) => {
      const cx = Math.round((x + R) * sk), cy = Math.round((R - y) * sk);
      let rr = 0, gg = 0, bb = 0, n = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const qx = cx + i, qy = cy + j;
        if (qx < 0 || qy < 0 || qx >= SS || qy >= SS) continue;
        const o = (qy * SS + qx) * 4; rr += sd[o]; gg += sd[o + 1]; bb += sd[o + 2]; n++;
      }
      return n ? new THREE.Color().setRGB(rr / n / 255, gg / n / 255, bb / n / 255, THREE.SRGBColorSpace) : null;
    };
  }



  // ---------- labels ----------

  private setLabels(items: Omit<Label, 'el'>[]) {
    this.dom.labels.innerHTML = '';
    this.labels = items.map(it => {
      const el = document.createElement('div');
      el.className = 'label ' + it.kind; el.textContent = it.name;
      this.dom.labels.appendChild(el);
      return { ...it, el };
    });
  }
  private pv = new THREE.Vector3();
  private updateLabels() {
    const { clientWidth: W, clientHeight: Hh } = this.dom.container;
    for (const l of this.labels) {
      this.pv.set(l.x, l.h, -l.y).project(this.camera);
      const vis = this.pv.z < 1 && Math.abs(this.pv.x) < 1.05 && Math.abs(this.pv.y) < 1.05;
      l.el.style.opacity = vis ? '1' : '0';
      if (vis) l.el.style.transform = `translate(${(this.pv.x + 1) / 2 * W}px,${(1 - this.pv.y) / 2 * Hh}px) translate(-50%,-100%)`;
    }
  }

  // ---------- hover names ----------

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();
  private groundAt(e: PointerEvent): XY | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const r = this.ray.ray;
    if (r.direction.y > -1e-3) return null;
    let h = this.controls.target.y;
    for (let i = 0; i < 6; i++) { r.at((h - r.origin.y) / r.direction.y, this.hit); h = this.H(this.hit.x, -this.hit.z); }
    const x = this.hit.x, y = -this.hit.z;
    return Math.abs(x) < this.R && Math.abs(y) < this.R ? [x, y] : null;
  }
  private lookup([x, y]: XY): Named | null {
    for (const b of this.named.buildings) if (inPoly(x, y, b.p)) return { name: b.name || b.kind, kind: b.name ? b.kind : '' };
    let best: Named | null = null, bd = Infinity;
    for (const r of this.named.roads) { const d = segDist(x, y, r.pts) - r.w / 2; if (d < 5 && d < bd) { bd = d; best = r; } }
    if (best) return best;
    for (const a of this.named.areas) if (a.polys.some(p => inPoly(x, y, p))) return a;
    return null;
  }
  // ---------- follow cam ----------

  private vehicleAt(e: PointerEvent | MouseEvent) {
    const meshes: THREE.Object3D[] = [];
    if (this.trafficOn) {
      this.traffic?.group.children.forEach(m => m.visible && meshes.push(m));
      this.railway?.group.children.forEach(m => m.userData.vehicle && m.visible && meshes.push(m));
    }
    if (!meshes.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    // a little forgiving: cars are small from far away
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (hit) return hit.object.userData.vehicle as { kind: 'car'; car: Car; name: string } | { kind: 'train'; train: Train };
    let best: THREE.Object3D | null = null, bestD = Infinity;
    for (const m of meshes) {
      const d = this.ray.ray.distanceToPoint(m.position), dist = m.position.distanceTo(this.camera.position);
      if (d < Math.max(3, dist * 0.012) && d < bestD) { bestD = d; best = m; }
    }
    return best?.userData.vehicle ?? null;
  }

  private onClick = (e: PointerEvent) => {
    const d = this.downAt; this.downAt = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 6) return;
    const v = this.vehicleAt(e);
    if (v) this.startFollow(v);
    else this.stopFollow();
  };

  // ---------- keyboard ----------

  private held = new Set<string>();
  private static MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', '_']);

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return this.stopFollow();
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (!MapEngine.MOVE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const fresh = !this.held.has(e.key);
    this.held.add(e.key);
    this.shift = e.shiftKey;
    if (this.follow) this.stopFollow();
    this.fly = null;
    this.onUserInteract?.();
    // a quick tap is released before the next frame: give each fresh press a small step of its own
    if (fresh) this.applyKeys(0.08);
  };
  private onKeyUp = (e: KeyboardEvent) => { this.held.delete(e.key); this.shift = e.shiftKey; };
  private onBlur = () => this.held.clear();
  private shift = false;

  /**
   * Smooth movement while keys are held: arrows pan along the ground (speed scales with zoom),
   * Shift+arrows orbit / tilt, +/- zoom.
   */
  private applyKeys(dt: number) {
    if (!this.held.size || this.follow) return;
    const h = this.held, target = this.controls.target, cam = this.camera.position;
    const offset = cam.clone().sub(target), dist = offset.length();
    const x = (h.has('ArrowRight') ? 1 : 0) - (h.has('ArrowLeft') ? 1 : 0);
    const y = (h.has('ArrowUp') ? 1 : 0) - (h.has('ArrowDown') ? 1 : 0);
    const z = (h.has('+') || h.has('=') ? 1 : 0) - (h.has('-') || h.has('_') ? 1 : 0);
    if (this.shift && (x || y)) {
      const sph = new THREE.Spherical().setFromVector3(offset);
      sph.theta -= x * 1.6 * dt;
      sph.phi = THREE.MathUtils.clamp(sph.phi + y * 0.9 * dt, 0.15, this.controls.maxPolarAngle); // Shift+Up tilts toward the horizon
      cam.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
    } else if (x || y) {
      const fwd = new THREE.Vector3(-offset.x, 0, -offset.z).normalize(), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const step = Math.max(10, dist * 0.5) * dt;
      const move = fwd.multiplyScalar(y * step).addScaledVector(right, x * step);
      // stay inside the map
      const lim = this.R;
      move.x = THREE.MathUtils.clamp(target.x + move.x, -lim, lim) - target.x;
      move.z = THREE.MathUtils.clamp(target.z + move.z, -lim, lim) - target.z;
      target.add(move); cam.add(move);
      // keep the target on the terrain so the view doesn't sink into hills
      const dy = this.H(target.x, -target.z) - target.y;
      target.y += dy; cam.y += dy;
    }
    if (z) {
      const len = THREE.MathUtils.clamp(dist * Math.exp(-z * 1.4 * dt), this.controls.minDistance, this.controls.maxDistance);
      cam.copy(target).add(offset.setLength(len));
    }
  }

  get following() { return !!this.follow; }

  private startFollow(v: { kind: 'car'; car: Car; name: string } | { kind: 'train'; train: Train }) {
    const up = new THREE.Vector3(0, 1, 0);
    const dirOf = (o: THREE.Object3D) => new THREE.Vector3(1, 0, 0).applyAxisAngle(up, o.rotation.y);
    const size = (m: THREE.Mesh) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox!; };
    if (v.kind === 'car') {
      const c = v.car, bb = size(c.mesh);
      // ~2.5 m behind the rear bumper and ~1.6 m above the roof
      const back = bb.max.x + 2.5, upBy = bb.max.y + 1.6;
      this.follow = { name: v.name, hudAt: 0, pose: () => ({ pos: c.mesh.position, fwd: dirOf(c.mesh), kmh: c.v * 3.6, back, up: upBy }) };
    } else {
      const t = v.train, rail = this.railway;
      this.follow = {
        name: t.name, hudAt: 0,
        // just behind and above the leading car, looking down the line
        pose: () => rail?.trains.includes(t) && t.meshes[0].visible
          ? { pos: t.meshes[0].position, fwd: dirOf(t.meshes[0]), kmh: t.v * 3.6, back: t.cars[0].len / 2 + 3, up: size(t.meshes[0]).max.y + 2.6 }
          : null,
      };
    }
    this.fly = null;
    this.hideTip();
    this.followLook.copy(this.controls.target);
    this.onFollow?.(this.follow.name, 0);
  }

  stopFollow() {
    if (!this.follow) return;
    this.follow = null;
    this.controls.target.copy(this.followLook);
    this.onFollowEnd?.();
  }

  private updateFollow(dt: number, now: number) {
    const f = this.follow!, p = f.pose();
    if (!p) return this.stopFollow();
    const want = p.pos.clone().addScaledVector(p.fwd, -p.back).add(new THREE.Vector3(0, p.up, 0));
    const look = p.pos.clone().addScaledVector(p.fwd, 14).add(new THREE.Vector3(0, 1.2, 0));
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(want, k);
    this.followLook.lerp(look, k);
    this.camera.lookAt(this.followLook);
    this.controls.target.copy(this.followLook);
    if (now - f.hudAt > 120) { f.hudAt = now; this.onFollow?.(f.name, p.kmh); }
  }

  private hideTip = () => this.dom.tip.classList.remove('on');
  private onPointerMove = (e: PointerEvent) => {
    if (e.buttons) return this.hideTip();
    cancelAnimationFrame(this.tipRaf);
    this.tipRaf = requestAnimationFrame(() => {
      const v = this.follow ? null : this.vehicleAt(e);
      this.renderer.domElement.style.cursor = v ? 'pointer' : '';
      const veh = v && { name: v.kind === 'car' ? v.name : v.train.name, kind: 'Click to follow' };
      const p = veh ? null : this.groundAt(e), f = veh || (p && this.lookup(p)), tip = this.dom.tip;
      if (!f) return this.hideTip();
      tip.replaceChildren();
      const b = document.createElement('b'); b.textContent = f.name; tip.append(b);
      if (f.kind) { const s = document.createElement('span'); s.textContent = f.kind; tip.append(s); }
      tip.style.transform = `translate(${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)}px,${e.clientY + 16}px)`;
      tip.classList.add('on');
    });
  };
}
