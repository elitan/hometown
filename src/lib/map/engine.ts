// Three.js map engine: terrain + draped map texture, buildings, trees, labels, hover names, camera.
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LocalProjection, inPoly, pick, polygons, rand, segDist, toXY, type OsmData, type Poly, type XY } from './geo';
import type { Elevation, Imagery, LaserTrees } from './sources';
import { obb, polyArea, roofGeometry, roofSpec } from './roofs';
import { Traffic, type Car, type RoadWay } from './traffic';
import { Railway, type RailWay, type Train } from './rail';
import { bridgeGeometry, isBridge, isTunnel, makeDeckAt, type Bridge } from './bridges';
import {
  FIELDS, GROUND, LAND, LAND_ORDER, PLACE_KINDS, ROAD, ROOFS, UNPAVED, WALLS, WATER, buildingHeight, pretty, type MapStyle,
} from './styles';

export type BuildInput = { P: LocalProjection; data: OsmData; elev: Elevation | null; img: Imagery | null; laser: LaserTrees | null; R: number; exag: number; style: MapStyle };
export type BuildStats = { buildings: number; trees: number; treeSource?: 'laser' | 'estimated'; elevMin: number | null; elevMax: number | null };
/** One tree: local position, height and crown radius in meters. */
type TreeSpec = { x: number; y: number; h: number; r: number };
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
  g.deleteAttribute('uv');
  return g;
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
  private traffic: Traffic | null = null;
  private railway: Railway | null = null;
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
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    dom.container.appendChild(r.domElement);

    this.scene.fog = new THREE.Fog(0xdfe9ec, 2600, 6500);
    this.camera = new THREE.PerspectiveCamera(45, dom.container.clientWidth / dom.container.clientHeight, 1, 14000);
    this.camera.position.set(0, 2000, 600);
    const c = this.controls = new MapControls(this.camera, r.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.46; c.minDistance = 25; c.maxDistance = 5000;
    c.zoomToCursor = true;
    c.addEventListener('start', () => { this.fly = null; this.stopFollow(); this.onUserInteract?.(); });

    this.scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x5d7a4c, 1.35));
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
    r.domElement.addEventListener('pointerleave', this.hideTip);
    r.setAnimationLoop(this.tick);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    removeEventListener('resize', this.onResize);
    removeEventListener('keydown', this.onKey);
    this.clearWorld();
    this.controls.dispose();
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
  };

  private tick = (now: number) => {
    const dt = this.lastNow ? (now - this.lastNow) / 1000 : 0;
    this.lastNow = now;
    if (this.trafficOn) { this.traffic?.update(dt); this.railway?.update(dt); }
    if (this.follow) this.updateFollow(dt, now);
    else if (this.fly) {
      const f = this.fly, k = Math.min(1, (now - f.t0) / f.ms), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(f.from, f.pos, e);
      this.controls.target.lerpVectors(f.fromT, f.target, e);
      if (k >= 1) this.fly = null;
    }
    if (!this.follow) this.controls.update();
    this.renderer.render(this.scene, this.camera);
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
  home() { if (this.homeView) this.flyTo(this.homeView.pos.clone(), this.homeView.target.clone(), 1200); }
  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ---------- build ----------

  private clearWorld() {
    this.stopFollow();
    if (!this.world) return;
    this.world.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.MeshLambertMaterial | undefined;
      mat?.map?.dispose(); mat?.dispose?.();
    });
    this.scene.remove(this.world);
    this.world = null;
    this.treeGroup = null;
    this.treeCtx = null;
    this.traffic?.dispose();
    this.traffic = null;
    this.railway?.dispose();
    this.railway = null;
  }

  build({ P, data, elev, img, laser, R, exag, style }: BuildInput, animate: boolean): BuildStats {
    if (this.disposed) return { buildings: 0, trees: 0, elevMin: null, elevMax: null };
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
    const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex }));
    ground.receiveShadow = true;
    world.add(ground);
    world.add(this.skirt(H, R, seg, minY - 30));

    // buildings (sunk below the lowest footprint point), named things, places
    const buildings: THREE.BufferGeometry[] = [], treePts: XY[] = [], places: { name: string; xy: XY }[] = [];
    const named: typeof this.named = { buildings: [], roads: [], areas: [] };
    let buildingCount = 0;
    const drivable: RoadWay[] = [], bridges: Bridge[] = [], railWays: RailWay[] = [];

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
            const box = obb(p.outer);
            const spec = roofSpec(t, box, polyArea(p) / Math.max(1, box.long * box.short));
            const walls = spec.type === 'flat' ? buildingHeight(t) : spec.eave;
            const geo = new THREE.ExtrudeGeometry(shape(p), { depth: walls + (hi - lo), bevelEnabled: false });
            geo.rotateX(-Math.PI / 2).translate(0, lo, 0);
            const barn = /barn|farm_auxiliary|shed/.test(t.building);
            const church = t.building === 'church' || t.amenity === 'place_of_worship';
            const real = roofTints.get(p) ?? null;
            const roof: THREE.ColorRepresentation = real ? real.clone().multiplyScalar(1.1) : church ? '#55504b' : pick(ROOFS);
            const wall = wallFor(real, church ? 'church' : barn ? 'barn' : 'house');
            buildings.push(paint(geo, wall, roof));
            if (spec.type !== 'flat') buildings.push(paint(roofGeometry(box, spec, hi + walls), wall, roof));
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
      if (!t.name) continue;
      if (t.highway && el.geometry) named.roads.push({ pts: toXY(P, el.geometry), w: ROAD[t.highway]?.[0] ?? 3, name: t.name, kind: pretty(t.highway) + ' road' });
      else if (t.waterway && el.geometry && t.waterway !== 'riverbank') named.roads.push({ pts: toXY(P, el.geometry), w: 4, name: t.name, kind: pretty(t.waterway) });
      else if (t.natural === 'water' || t.landuse || t.leisure || t.natural) {
        const isWater = t.natural === 'water';
        named.areas.push({ polys: polygons(P, el), name: t.name, kind: isWater ? pretty(t.water || 'lake') : pretty(t.landuse || t.leisure || t.natural), water: isWater });
      }
    }
    this.named = named;
    if (buildings.length) {
      const b = new THREE.Mesh(mergeGeometries(buildings), new THREE.MeshLambertMaterial({ vertexColors: true }));
      b.castShadow = b.receiveShadow = true;
      world.add(b);
    }

    // bridges (the bare-earth terrain has none)
    const decks = bridges.flatMap(b => bridgeGeometry(b, H));
    if (decks.length) {
      const m = new THREE.Mesh(mergeGeometries(decks), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      m.castShadow = m.receiveShadow = true;
      world.add(m);
    }

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
    const stats = { buildings: buildingCount, elevMin: elev ? Math.round(base) : null, elevMax: elev ? Math.round(top) : null };
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
  private treeGroup: THREE.Group | null = null;

  setTraffic(on: boolean) {
    this.trafficOn = on;
    if (!on) this.stopFollow();
    if (this.traffic) this.traffic.group.visible = on;
  }

  /** Swap the current trees (estimated or real) for a new set, keeping the rest of the scene. */
  private replaceTrees(trees: TreeSpec[]) {
    const ctx = this.treeCtx;
    if (!ctx) return;
    if (this.treeGroup) {
      this.treeGroup.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
      this.treeGroup.removeFromParent();
    }
    this.treeGroup = new THREE.Group();
    ctx.world.add(this.treeGroup);
    this.addTrees(this.treeGroup, trees, ctx.H, ctx.sample);
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
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  private frame(R: number, mid: number, animate: boolean) {
    const cl = R + 0.5;
    this.renderer.clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), cl), new THREE.Plane(new THREE.Vector3(-1, 0, 0), cl),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), cl), new THREE.Plane(new THREE.Vector3(0, 0, -1), cl),
    ];
    this.sun.position.set(R * 0.9, mid + R * 0.75, R * 0.35);
    this.sun.target.position.set(0, mid, 0);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -R * 1.35; sc.right = sc.top = R * 1.35; sc.near = 1; sc.far = R * 4;
    sc.updateProjectionMatrix();
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
      if (waterPolys.length) {
        ctx.save(); ctx.shadowColor = 'rgba(30,70,100,.35)'; ctx.shadowBlur = 6 * k; fill(waterPolys, WATER); ctx.restore();
        ctx.lineWidth = Math.max(2 * k, 1); ctx.strokeStyle = 'rgba(200,230,245,.55)';
        ctx.beginPath(); for (const p of waterPolys) { trace(p.outer); ctx.closePath(); } ctx.stroke();
      }
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

  /**
   * Instanced low-poly trees scaled to each tree's height and crown radius.
   * With an aerial photo, darker canopies become conifers and lighter ones broadleaf (spruce reads darker from above).
   */
  private addTrees(world: THREE.Group, trees: TreeSpec[], H: (x: number, y: number) => number, sample: Sample | null) {
    if (!trees.length) return;
    // unit shapes: conifer is 10 m tall with a 2.6 m crown, broadleaf 8.9 m tall with a 3.4 m crown
    const conifer = new THREE.ConeGeometry(2.6, 8, 6).translate(0, 6, 0);
    const broad = new THREE.IcosahedronGeometry(3.4, 0).translate(0, 5.5, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 2.6, 5).translate(0, 1.3, 0);

    const photo = trees.map(t => sample?.(t.x, t.y, 1) ?? null);
    const light = photo.map(c => c ? c.getHSL({ h: 0, s: 0, l: 0 }).l : NaN);
    const known = light.filter(l => !Number.isNaN(l)).sort((a, b) => a - b);
    const darkCut = known.length ? known[Math.floor(known.length * 0.45)] : 0;
    const isConifer = trees.map((_, i) => Number.isNaN(light[i]) ? Math.random() < 0.5 : light[i] <= darkCut);

    const nC = isConifer.filter(Boolean).length;
    const make = (geo: THREE.BufferGeometry, color: string, n: number) => {
      const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
      // dissolve trees right in front of the camera (dithered), so a low chase/zoom camera isn't stuck inside crowns
      mat.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader.replace('void main() {', `void main() {
          float camD = length(vViewPosition);
          if (camD < 14.0 && fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) > (camD - 4.0) / 10.0) discard;`);
      };
      const m = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
      m.count = n; m.castShadow = true;
      return m;
    };
    const mc = make(conifer, '#ffffff', nC), mb = make(broad, '#ffffff', trees.length - nC), mt = make(trunk, '#6b4f36', trees.length);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    let ic = 0, ib = 0;
    trees.forEach((t, i) => {
      const con = isConifer[i], ground = H(t.x, t.y) - 0.3;
      q.setFromAxisAngle(up, rand(0, Math.PI * 2));
      v.set(t.x, ground, -t.y);
      const sy = t.h / (con ? 10 : 8.9), sxz = t.r / (con ? 2.6 : 3.4);
      M.compose(v, q, s.set(sxz, sy, sxz));
      const mesh = con ? mc : mb, k = con ? ic++ : ib++;
      mesh.setMatrixAt(k, M);
      const real = photo[i];
      if (real) {
        // take the photo's hue but keep it leafy: clamp toward green and lift brightness for the shaded canopy
        const hsl = real.getHSL({ h: 0, s: 0, l: 0 });
        mesh.setColorAt(k, col.setHSL(THREE.MathUtils.clamp(hsl.h, 0.16, 0.4), Math.max(hsl.s, 0.3), THREE.MathUtils.clamp(hsl.l * 1.5, 0.18, 0.4)));
      } else mesh.setColorAt(k, col.setHSL((con ? 0.36 : 0.27) + rand(-0.03, 0.03), rand(0.35, 0.5), rand(0.22, 0.32)));
      const tw = Math.min(1.6, Math.max(0.6, t.r / 2.8));
      M.compose(v, q, s.set(tw, sy, tw));
      mt.setMatrixAt(i, M);
    });
    world.add(mc, mb, mt);
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

  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.stopFollow(); };

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
