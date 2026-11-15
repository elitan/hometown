// Rendering "look": physical sky + image-based lighting, filmic post-processing (ambient occlusion),
// and a sun shadow that tightens around wherever the camera is looking (sharp up close, whole map from afar).
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Direction toward the sun (or moon) for an elevation and an azimuth clockwise from north, in degrees. */
export function skyDirection(elevation: number, azimuth: number) {
  // world: x = east, z = south (-north); spherical theta is measured from +z toward +x
  return new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(180 - azimuth));
}

/**
 * The physical sky, rendered into a cube map that is both the background and (pre-filtered) the environment
 * light. Re-rendered when the sun moves; at night a dark blue dome and stars fade in over it.
 */
export class SkyDome {
  private sky = new Sky();
  private skyScene = new THREE.Scene();
  private cube = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  private cubeCamera = new THREE.CubeCamera(1, 20000, this.cube);
  private pmrem: THREE.PMREMGenerator;
  private env: THREE.WebGLRenderTarget | null = null;
  private nightSky: THREE.ShaderMaterial;
  private stars: THREE.PointsMaterial;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.sky.scale.setScalar(10000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.6;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.0028;
    u.mieDirectionalG.value = 0.82;
    this.skyScene.add(this.sky);

    this.nightSky = new THREE.ShaderMaterial({
      uniforms: { uNight: { value: 0 }, uDeep: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // twilight blue right after sunset, deepening to a dark night sky (linear colours, before exposure)
      fragmentShader: `uniform float uNight; uniform float uDeep; varying vec3 vDir;
        void main() {
          float h = pow(clamp(vDir.y, 0.0, 1.0), 0.5);
          vec3 dusk = mix(vec3(0.16, 0.2, 0.36), vec3(0.05, 0.09, 0.22), h);
          vec3 deep = mix(vec3(0.016, 0.024, 0.05), vec3(0.003, 0.005, 0.013), h);
          // near the horizon the sunset glow shows through at dusk
          float a = uNight * mix(1.0 - 0.55 * (1.0 - h) * (1.0 - uDeep), 1.0, uDeep);
          gl_FragColor = vec4(mix(dusk, deep, uDeep), a);
        }`,
      side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), this.nightSky);
    dome.renderOrder = 1;
    this.skyScene.add(dome);

    const pts: number[] = [];
    for (let i = 0; i < 1800; i++) {
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1).normalize().multiplyScalar(4500);
      if (v.y > 150) pts.push(v.x, v.y, v.z);
    }
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.PointsMaterial({ color: 0xffffff, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const stars = new THREE.Points(g, this.stars);
    stars.renderOrder = 2;
    this.skyScene.add(stars);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    scene.background = this.cube.texture;
    scene.environmentIntensity = 0.18; // the physical sky is very bright; this keeps sky light a fill, not a floodlight
  }

  /** Re-render for a sun direction; `dusk` (0..1) fades in the twilight sky, `deep` (0..1) darkens it to night. */
  update(sun: THREE.Vector3, dusk: number, deep: number) {
    this.sky.material.uniforms.sunPosition.value.copy(sun);
    this.nightSky.uniforms.uNight.value = dusk;
    this.nightSky.uniforms.uDeep.value = deep;
    this.stars.opacity = deep;
    const planes = this.renderer.clippingPlanes;
    this.renderer.clippingPlanes = []; // the map's clipping box must not cut the sky
    this.cubeCamera.update(this.renderer, this.skyScene);
    this.renderer.clippingPlanes = planes;
    const env = this.pmrem.fromCubemap(this.cube.texture);
    this.env?.dispose();
    this.env = env;
    this.scene.environment = env.texture;
  }

  dispose() {
    this.env?.dispose(); this.cube.dispose(); this.pmrem.dispose();
  }
}

export class Post {
  readonly composer: EffectComposer;
  private ao: GTAOPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, w: number, h: number) {
    // MSAA render target (the default framebuffer's antialiasing doesn't apply once we post-process)
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(scene, camera));

    this.ao = new GTAOPass(scene, camera, w, h);
    this.ao.blendIntensity = 1;
    this.ao.updateGtaoMaterial({ radius: 4, distanceExponent: 1.4, thickness: 3, scale: 1.5, samples: 16, distanceFallOff: 1 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
    // AO is soft by nature: render it at half resolution (its cost was ~30% of the frame)
    const aoSetSize = this.ao.setSize.bind(this.ao);
    this.ao.setSize = (sw: number, sh: number) => aoSetSize(Math.max(1, sw >> 1), Math.max(1, sh >> 1));
    this.ao.setSize(w, h);
    this.composer.addPass(this.ao);

    // (no bloom: against this bright physical sky it washed the whole scene out)
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number) { this.composer.setSize(w, h); }
  render() { this.composer.render(); }
  dispose() { this.composer.dispose(); }
}

/**
 * Keep the sun's shadow box centred on the view and sized to the camera distance, snapped to shadow texels
 * so it doesn't shimmer while panning. Returns nothing; mutates the light.
 */
export function fitShadow(sun: THREE.DirectionalLight, dir: THREE.Vector3, center: THREE.Vector3, camDist: number, maxExtent: number) {
  const ext = THREE.MathUtils.clamp(camDist * 0.9, 45, maxExtent);
  const texel = (2 * ext) / sun.shadow.mapSize.x;
  const c = new THREE.Vector3(Math.round(center.x / texel) * texel, center.y, Math.round(center.z / texel) * texel);
  const back = ext * 2 + 300;
  sun.position.copy(c).addScaledVector(dir, back);
  sun.target.position.copy(c);
  sun.target.updateMatrixWorld();
  const sc = sun.shadow.camera;
  if (Math.abs(sc.right - ext) > ext * 0.04) {
    sc.left = sc.bottom = -ext; sc.right = sc.top = ext;
    sc.near = 1; sc.far = back + ext * 2;
    sc.updateProjectionMatrix();
  }
  // softer, less biased shadows up close, more forgiving far away
  sun.shadow.normalBias = 0.02 + ext / 2000;
}

/** Grayscale clumps and grain (grass tufts, gravel, soil), tileable; multiplied over the aerial photo up close. */
function detailTexture() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, S, S);
  const wrapped = (x: number, y: number, draw: (x: number, y: number) => void) => {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) draw(x + ox, y + oy);
  };
  // soft light/dark patches
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 6 + Math.random() * 22, l = Math.random() < 0.5 ? 40 : 215;
    wrapped(x, y, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${l},${l},${l},0.28)`); g.addColorStop(1, `rgba(${l},${l},${l},0)`);
      ctx.fillStyle = g; ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // tufts / grain
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * S, y = Math.random() * S, l = Math.round(50 + Math.random() * 160), r = 0.8 + Math.random() * 2.2;
    wrapped(x, y, (px, py) => { ctx.fillStyle = `rgba(${l},${l},${l},0.6)`; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); });
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/**
 * Ground material: the draped map/photo texture plus world-space detail at two scales that fades in up close,
 * so the ground stays crisp at street level instead of turning into a blurry photo.
 */
export function groundMaterial(map: THREE.Texture, R: number) {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95 });
  const detail = detailTexture();
  mat.onBeforeCompile = sh => {
    sh.uniforms.detailMap = { value: detail };
    sh.uniforms.mapSize = { value: 2 * R };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D detailMap;\nuniform float mapSize;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec2 wuv = vMapUv * mapSize;
        float d1 = texture2D( detailMap, wuv / 2.5 ).r, d2 = texture2D( detailMap, wuv / 11.0 + 0.37 ).r;
        float near = 1.0 - smoothstep( 60.0, 400.0, length( vViewPosition ) );
        float grain = mix( 1.0, ( d1 * 0.55 + d2 * 0.45 ) * 2.0, 0.75 * near + 0.15 );
        diffuseColor.rgb *= grain;`);
  };
  mat.userData.detail = detail;
  return mat;
}
