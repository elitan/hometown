// Seasons and night lights as shader uniforms shared by every material that changes with them (ground, roofs,
// trees, windows, lamps, vehicles), so switching season or hour is instant: no rebuild, just new uniform values.
import * as THREE from 'three';
import type { Season } from './sun';

export const seasonUniforms = {
  uSnow: { value: 0 },    // 0..1 snow cover on the ground and on anything facing up
  uAutumn: { value: 0 },  // 0..1 yellowing leaves and grass
  uSpring: { value: 0 },  // 0..1 fresh light-green leaves
  uBare: { value: 0 },    // 0..1 deciduous trees without leaves
};

/** Night lights: `uLights` 0..1 turns on windows, street lamps and vehicle lights; `lightMap` holds lamp pools. */
const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
black.needsUpdate = true;
export const nightUniforms = {
  uLights: { value: 0 },
  lightMap: { value: black as THREE.Texture },
};

export function setSeason(s: Season) {
  seasonUniforms.uSnow.value = s === 'winter' ? 1 : 0;
  seasonUniforms.uAutumn.value = s === 'autumn' ? 1 : 0;
  seasonUniforms.uSpring.value = s === 'spring' ? 1 : 0;
  seasonUniforms.uBare.value = s === 'winter' ? 1 : 0;
}

const PARS = `
uniform float uSnow; uniform float uAutumn; uniform float uSpring; uniform float uBare; uniform float uLights;
float seasonHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float seasonNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(seasonHash(i), seasonHash(i + vec2(1, 0)), f.x), mix(seasonHash(i + vec2(0, 1)), seasonHash(i + vec2(1, 1)), f.x), f.y);
}
// how much a colour looks like vegetation (green dominant)
float greenness(vec3 c) { return clamp((c.g - max(c.r, c.b)) * 6.0, 0.0, 1.0); }
vec3 seasonGrass(vec3 c) {
  float g = greenness(c), l = dot(c, vec3(0.3, 0.59, 0.11));
  c = mix(c, c * vec3(1.06, 1.12, 0.82) + vec3(0.01, 0.02, 0.0), g * uSpring);
  c = mix(c, vec3(l * 1.32, l * 1.08, l * 0.52), g * uAutumn * 0.75);
  return c;
}
`;

type Hook = (sh: THREE.WebGLProgramParametersWithUniforms) => void;

/** Chain a shader hook onto a material, keeping any earlier onBeforeCompile. */
function hook(mat: THREE.Material, key: string, fn: Hook) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, seasonUniforms, nightUniforms);
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', PARS + '\nvoid main() {');
    fn(sh);
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + key;
}

// snow lies on whatever faces up (view-space normal against view-space up), patchy at the edges
const SNOW_ON_TOP = (amount: string, min: string) => `
  {
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float facing = smoothstep(${min}, ${min} + 0.25, dot(normal, upV));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), facing * ${amount});
  }`;

/** Roofs: snow on every slope that isn't too steep. */
export function seasonalRoof(mat: THREE.Material) {
  hook(mat, 'roof', sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + SNOW_ON_TOP('uSnow', '0.35'));
  });
}

/**
 * Ground: grass yellows in autumn and freshens in spring; in winter snow covers it, except on ploughed
 * roads (`roadMask`, white = road) where it stays thin and grey.
 */
export function seasonalGround(mat: THREE.Material, roadMask: THREE.Texture) {
  hook(mat, 'ground', sh => {
    sh.uniforms.roadMask = { value: roadMask };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform sampler2D roadMask;\nuniform sampler2D lightMap;\nvoid main() {')
      // street lamp pools: the lit ground keeps its own colour, warmed by the lamp
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // bright ground (snow) needs less to look lit, and must not burn out to white
          float pool = texture2D(lightMap, vMapUv).r, gl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.78, 0.5) * pool * uLights * mix(2.4, 0.55, smoothstep(0.15, 0.7, gl));
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb = seasonGrass(diffuseColor.rgb);
        if (uSnow > 0.0) {
          float road = texture2D(roadMask, vMapUv).r;
          float patchy = seasonNoise(vMapUv * 900.0) * 0.5 + seasonNoise(vMapUv * 3500.0) * 0.5;
          vec3 snow = vec3(0.9, 0.93, 0.97) * (0.92 + 0.1 * patchy);
          float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          vec3 ploughed = mix(vec3(0.42, 0.43, 0.45) * (0.8 + 0.5 * lum), snow, 0.12 + 0.2 * patchy);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(snow, ploughed, road), uSnow);
        }`);
  });
}

/**
 * Tree crowns. Needles: snow on the upper side of the branches in winter. Leaves: fresh green in spring,
 * yellow to orange (varying per tree) in autumn, gone in winter except a few twigs.
 */
export function seasonalFoliage(mat: THREE.Material, kind: 'needle' | 'leaf') {
  hook(mat, kind, sh => {
    instanceSeed(sh, 'vTreeSeed');
    if (kind === 'needle') {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>' + SNOW_ON_TOP('uSnow * 0.85', '0.15'));
      return;
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 c = diffuseColor.rgb;
        float l = dot(c, vec3(0.3, 0.59, 0.11));
        vec3 spring = c * vec3(1.12, 1.25, 0.7) + vec3(0.03, 0.05, 0.0);
        // autumn: from yellow birch to orange-red maple, a few trees still green
        vec3 autumn = mix(vec3(0.85, 0.62, 0.12), vec3(0.78, 0.3, 0.08), smoothstep(0.55, 0.95, vTreeSeed)) * (l * 2.2 + 0.12);
        autumn = mix(autumn, c, step(vTreeSeed, 0.12));
        c = mix(c, spring, uSpring);
        c = mix(c, autumn, uAutumn);
        c = mix(c, vec3(0.36, 0.31, 0.27) * (0.8 + l), uBare);
        diffuseColor.rgb = c;
        #ifdef USE_MAP
          // bare: keep a sparse fifth of the leaf texture, as a see-through mass of twigs
          diffuseColor.a *= mix(1.0, step(0.8, sampledDiffuseColor.r), uBare);
        #endif
      }`);
  });
}

/** A stable random number per instance (from its position), as a varying named `name`. */
function instanceSeed(sh: THREE.WebGLProgramParametersWithUniforms, name: string) {
  sh.vertexShader = sh.vertexShader
    .replace('void main() {', `varying float ${name};\nvoid main() {`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        ${name} = fract(sin(instanceMatrix[3].x * 0.137 + instanceMatrix[3].y * 0.291 + instanceMatrix[3].z * 0.711) * 437.585);
      #else
        ${name} = 0.5;
      #endif`);
  sh.fragmentShader = sh.fragmentShader.replace('void main() {', `varying float ${name};\nvoid main() {`);
}

/** Window glass: about half the windows glow warm at night, each a slightly different shade. */
export function glowingWindows(mat: THREE.Material) {
  hook(mat, 'windows', sh => {
    instanceSeed(sh, 'vWinSeed');
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      // far away a window is a pixel or less: keep it dimmer so it doesn't sparkle as the camera moves
      float winFar = mix(1.0, 0.5, smoothstep(150.0, 900.0, length(vViewPosition)));
      if (vWinSeed < 0.5) totalEmissiveRadiance += mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.85, 0.6), fract(vWinSeed * 9.0)) * (0.8 + 0.8 * fract(vWinSeed * 23.0)) * uLights * winFar;`);
  });
}

/** A light source that switches on at dusk (street lamp heads). `strength` > 1 makes it bloom. */
export function glowingLamp(mat: THREE.Material, color: THREE.ColorRepresentation, strength: number) {
  const c = new THREE.Color(color);
  hook(mat, 'lamp' + c.getHexString() + strength, sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)}) * ${strength.toFixed(2)} * uLights;`);
  });
}

/** Vehicle lamps, coloured by vertex colour (white front, red rear): faint by day, bright at night. */
export function glowingVehicleLamps(mat: THREE.Material) {
  hook(mat, 'vehiclelamps', sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance = vColor.rgb * mix(0.15, 7.0, uLights);
      #endif`);
  });
}

/** Train paint: the dark window band and windscreen glow from the lit inside at night. */
export function glowingTrainWindows(mat: THREE.Material) {
  const band = new THREE.Color('#1c2430');
  hook(mat, 'trainwindows', sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        if (distance(vColor.rgb, vec3(${band.r.toFixed(4)}, ${band.g.toFixed(4)}, ${band.b.toFixed(4)})) < 0.004)
          totalEmissiveRadiance += vec3(1.0, 0.88, 0.68) * 0.55 * uLights;
      #endif`);
  });
}

/** Soft cone of headlight on the road ahead (u = distance from the lamps, v = across), drawn additively. */
export function beamTexture() {
  const W = 128, H = 64, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!, img = ctx.createImageData(W, H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    const u = x / (W - 1), v = Math.abs(y / (H - 1) - 0.5) * 2, half = 0.45 + 0.55 * u;
    const t = Math.max(0, 1 - v / half), across = t * t * (3 - 2 * t); // soft-edged, wide core
    const a = Math.pow(1 - u, 1.4) * across * Math.min(1, u * 10);
    const o = (y * W + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(255 * a); img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
