// The meadow: grass blades and wildflowers, placed on the GPU in world-anchored cells around the
// camera. Grass comes in three shells cross-faded by distance. Flowers come in four, but what
// shows is one continuous field: every flower has a rank, fewer survive the further out they are,
// and the survivors grow to hold the same cover - so there is no distance at which the colour
// drops out or jumps. Everything leans with the wind's gust fronts and with the wake vortices.
import * as THREE from 'three';
import { U, World, shared } from '../core/ctx.js';
import { NOISE, NOISE_TEX, ATMOSPHERE, CLOUD_SHADOW, TERRAIN_LOOKUP, MEADOW, WIND, SHADOW, STRIP, TOWN_SHADOW_V, TOWN_MASK_V } from '../shaders/common.js';
import { SKY_UNIFORMS } from './sky.js';

const SHARED = [...SKY_UNIFORMS, 'uTime', 'uHeightTex', 'uSplatTex', 'uLightTex', 'uWorld', 'uNoiseTex', 'uWakeTex', 'uWake', 'uWind', 'uShadowTex', 'uShadowMat', 'uShadowOn', 'uRider', 'uStripTex',
  'uTownSh0', 'uTownSh1', 'uTownShM0', 'uTownShM1', 'uTownShP', 'uTownMask0', 'uTownMask1', 'uTownRect0', 'uTownRect1'];

// ----------------------------------------------------------------------------------------
// shell definitions. fade = [in0, in1, out0, out1] (metres from camera)
// ----------------------------------------------------------------------------------------
export const QUALITY = {
  minimal: { grass: 0.1, flowers: 0.15 },
  high: { grass: 1.0, flowers: 1.0 },
  medium: { grass: 0.6, flowers: 0.7 },
  low: { grass: 0.33, flowers: 0.45 },
};

function grassShells(q) {
  return [
    { cell: 7, per: 176 * q, segs: 5, width: 0.021, height: 0.50, fade: [-1, 0, 11, 16], lean: 1.0, root: 1.0 },
    { cell: 15, per: 42 * q, segs: 3, width: 0.046, height: 0.52, fade: [10, 15, 40, 52], lean: 1.0, root: 0.72 },
    { cell: 34, per: 6.2 * q, segs: 2, width: 0.150, height: 0.56, fade: [38, 50, 118, 150], lean: 0.9, root: 0.30 },
  ];
}
// Flowers thin with distance as FLOWER_N0 * (FLOWER_D0 / d)^1.5 candidates per square metre, and
// grow as (d / FLOWER_D0)^0.75, which keeps cover constant. (The splat density then decides how
// many of the candidates actually bloom.)
const FLOWER_N0 = 42, FLOWER_D0 = 14, FLOWER_END = 310;   // beyond that the ground's own flower wash carries the colour
function flowerShells(q) {
  // each shell supplies candidates at its own density and takes over where the field has thinned
  // to it: d = D0 * (N0 / N)^(2/3)
  const frac = [1, 0.38, 0.12, 0.03], cell = [11, 22, 46, 105], lod = [0, 1, 2, 2];
  const at = (f) => FLOWER_D0 * Math.pow(1 / f, 2 / 3);
  return frac.map((f, i) => ({
    cell: cell[i], per: FLOWER_N0 * q * f, lod: lod[i], n0: FLOWER_N0 * q,
    near: i ? at(frac[i]) * 0.85 : -2,                    // starts fading in (the nearer shell is fading out)
    full: i ? at(frac[i]) : -1,                           // has taken over
    far: i < frac.length - 1 ? at(frac[i + 1]) : FLOWER_END,   // has handed over to the next (or the field ends)
  }));
}

// ----------------------------------------------------------------------------------------
// geometry
// ----------------------------------------------------------------------------------------
function bladeGeometry(segs) {
  // position.x = side (-1/+1), position.y = t along the blade (0 root .. 1 tip)
  const pos = [], idx = [];
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    pos.push(-1, t, 0, 1, t, 0);
  }
  pos.push(0, 1, 0);
  for (let i = 0; i < segs - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const a = (segs - 1) * 2;
  idx.push(a, a + 1, a + 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

function flowerGeometry(lod) {
  // position.z = part: 0 stem (x = side, y = t), 1 head (x,y = unit disc coords)
  // (only the nearest shell draws stems: by 25 m they are a fraction of a pixel wide)
  const pos = [], idx = [];
  if (lod < 1) {
    const S = 4;
    for (let i = 0; i <= S; i++) pos.push(-1, i / S, 0, 1, i / S, 0);
    for (let i = 0; i < S; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const base = pos.length / 3;
  const R = lod === 0 ? 10 : lod === 1 ? 6 : 4;
  pos.push(0, 0, 1);
  for (let i = 0; i < R; i++) { const a = (i / R) * Math.PI * 2; pos.push(Math.cos(a), Math.sin(a), 1); }
  for (let i = 0; i < R; i++) idx.push(base, base + 1 + i, base + 1 + ((i + 1) % R));
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

// ----------------------------------------------------------------------------------------
// shaders
// ----------------------------------------------------------------------------------------
const PLACE = /* glsl */`
uniform vec4 uCell;     // origin.xz, cell size, seed
uniform vec4 uFade;     // in0, in1, out0, out1
uniform float uGridN;
uniform vec3 uCamPos2;
// stratified position of this instance inside the cell + its random numbers
vec2 placeInstance(out vec4 rnd){
  float id = float(gl_InstanceID);
  vec2 g = vec2(mod(id, uGridN), floor(id / uGridN));
  rnd = hash42(g * 1.37 + uCell.w * vec2(17.13, 91.71) + 3.1);
  vec4 r2 = hash42(g.yx * 2.11 + uCell.w * vec2(5.3, 47.9) + 11.7);
  return uCell.xy + (g + r2.xy) / uGridN * uCell.z;
}
float lodFade(float d){
  return smoothstep(uFade.x, uFade.y, d) * (1.0 - smoothstep(uFade.z, uFade.w, d));
}
`;

const SHADOW_FN = SHADOW;

const GRASS_VERT = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uSegs;
uniform vec2 uBlade;    // width, height
uniform float uLeanK;
${NOISE}
${NOISE_TEX}
${TERRAIN_LOOKUP}
${WIND}
${MEADOW}
${PLACE}
${TOWN_SHADOW_V}
${TOWN_MASK_V}
uniform vec3 uCamPos;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vInfo;     // t, random, gust, baked sun
varying vec3 vTint;
varying vec2 vAux;      // ao, wake pressure

void main(){
  vec4 rnd;
  vec2 xz = placeInstance(rnd);
  vec2 uv = worldUV(xz);
  float y = terrainH(xz);
  vec4 splat = textureLod(uSplatTex, uv, 0.0);
  vec4 light = textureLod(uLightTex, uv, 0.0);
  vec3 root = vec3(xz.x, y, xz.y);
  // in a town nothing grows on the paving, and the houses' shadows fall on what does grow
  splat.a *= 1.0 - smoothstep(0.08, 0.5, townMaskV(xz).a);
  light.r *= townShadowV(root + vec3(0.0, 0.35, 0.0));
  float d = distance(root, uCamPos);
  float cover = splat.a;
  // ragged edges: blades thin out before the sward ends
  float keep = step(rnd.z, cover * 1.25) * smoothstep(0.02, 0.5, cover);
  float fade = lodFade(d) * keep;
  // nothing to draw here (bare ground, or outside this shell): skip the wind and wake lookups
  if (fade <= 0.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // clumps: neighbours share height and lean
  vec4 cl = hash42(floor(xz / 0.75));
  float wet = splat.b;
  float hgt = uBlade.y * mix(0.50, 1.30, rnd.w) * mix(0.72, 1.28, cl.x) * mix(0.86, 1.22, wet) * (0.55 + 0.45 * cover);
  // flowers shade out the grass a little so the heads stand proud
  hgt *= 1.0 - 0.22 * splat.r;
  float wid = uBlade.x * mix(0.7, 1.25, rnd.x);

  // ---- wind + wake
  float gust = windGust(xz, uTime);
  vec2 wdir = uWind.xy;
  float ang = (rnd.y * 0.55 + cl.y) * 6.2831853;
  vec2 rdir = vec2(cos(ang), sin(ang));
  float flutter = sin(uTime * (3.4 + rnd.x * 3.1) + rnd.y * 6.2831) * (0.035 + 0.11 * gust);
  vec2 lean = rdir * (0.16 + 0.26 * cl.z) + wdir * (0.10 + 0.82 * gust) * uWind.z * uLeanK + vec2(-wdir.y, wdir.x) * flutter;
  vec4 wk = wakeAt(xz);
  // the wake drags blades along its push and whips them at the rider's passing speed
  float whip = sin(uTime * 23.0 + rnd.y * 40.0) * 0.5 * min(wk.z, 1.0);
  lean += wk.xy * (1.0 + whip) + vec2(-wk.y, wk.x) * whip * 0.35;
  float ll = length(lean);
  float tilt = min(ll, 1.42);
  vec2 ldir = lean / max(ll, 1e-4);
  hgt *= 1.0 - 0.18 * min(wk.z, 1.0);

  // ---- bezier blade in the plane of its lean
  float t = position.y;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 l3 = vec3(ldir.x, 0.0, ldir.y);
  vec3 p2 = up * (hgt * cos(tilt)) + l3 * (hgt * sin(tilt));
  vec3 p1 = up * (hgt * 0.58) + l3 * (hgt * sin(tilt) * 0.18);
  float it = 1.0 - t;
  vec3 c = p1 * (2.0 * it * t) + p2 * (t * t);
  vec3 tg = normalize(p1 * (2.0 * it - 2.0 * t) + p2 * (2.0 * t));
  vec3 side = normalize(cross(up, l3));
  // lean the flat of the blade toward the eye so it never goes edge-on and vanishes
  vec3 toCam = normalize(uCamPos - (root + c));
  vec3 vside = normalize(cross(tg, toCam));
  side = normalize(mix(side, vside * sign(dot(side, vside) + 1e-4), 0.42));
  float w = wid * (1.0 - pow(t, 1.7)) * (0.55 + 0.45 * smoothstep(0.0, 0.25, t) + 0.0);
  // far shells: fatter, shorter taper so the cover holds
  vec3 P = root + c * fade + side * (position.x * w * fade);
  vec3 n = normalize(cross(side, tg));
  n = normalize(n + side * position.x * 0.55);

  vWorld = P;
  vNormal = n;
  vInfo = vec4(t, rnd.w, gust, light.r);
  // on cliff ledges the sward is short, wind-burnt and darker (matches the far-field ground)
  vTint = mix(meadowTint(xz, wet), vec3(0.135, 0.170, 0.060), smoothstep(0.25, 0.8, light.a) * 0.62) * mix(0.88, 1.14, cl.w);
  vAux = vec2(light.g, min(wk.z, 1.0));
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

const GRASS_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uRoot;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vInfo;
varying vec3 vTint;
varying vec2 vAux;
${NOISE}
${ATMOSPHERE}
${CLOUD_SHADOW}
${SHADOW_FN}
void main(){
  // MSAA can extrapolate varyings past the blade's ends: clamp before any pow()
  float t = clamp(vInfo.x, 0.0, 1.0);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);
  if (dot(N, V) < 0.0) N = -N;
  // colour runs from shaded thatch at the root to sun-bleached tips. In the sparse far shells a
  // blade stands in for a whole tuft, so it carries the canopy colour nearly root to tip.
  vec3 rootC = vTint * mix(1.05, 0.42, uRoot);
  vec3 tipC = vTint * mix(1.30, 1.62, uRoot) + vec3(0.050, 0.060, 0.004) * uRoot;
  vec3 alb = mix(rootC, tipC, pow(t, 1.25)) * mix(0.84, 1.16, vInfo.y);
  alb = mix(alb, vec3(0.50, 0.46, 0.20), smoothstep(0.80, 1.0, t) * 0.30 * vInfo.y);   // seed-head straw

  float sh = vInfo.w * cloudShadow(vWorld.xz, uTime) * riderShadow(vWorld);
  float ndl = dot(N, uSunDir);
  float dif = saturate(ndl * 0.55 + 0.45);
  // light pouring through the blades when you look toward the sun
  float back = pow(saturate(dot(V, -uSunDir) * 0.5 + 0.5), 4.0);
  vec3 trans = vTint * vec3(2.3, 2.5, 0.75) * back * (0.25 + 0.75 * t);
  float ao = mix(mix(0.85, 0.24, uRoot), 1.0, smoothstep(0.0, 0.75, t)) * vAux.x;
  vec3 col = alb * (uSunColor * dif * sh * mix(mix(0.95, 0.55, uRoot), 1.0, t)) + trans * uSunColor * sh * 0.33;
  col += alb * mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * ao;
  // glossy sheen that rides the gust fronts
  vec3 H = normalize(uSunDir + V);
  float spec = pow(saturate(dot(N, H)), 26.0) * (0.10 + 0.34 * vInfo.z) * smoothstep(0.15, 0.7, t);
  col += uSunColor * spec * sh * 0.22;
  col = applyAtmosphere(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;

const FLOWER_VERT = /* glsl */`
precision highp float;
uniform float uTime;
uniform vec4 uShell;    // candidates per m2 in this shell; fade-in start, fade-in end; hand-over distance
uniform vec2 uField;    // candidates per m2 near the eye, distance at which thinning starts
${NOISE}
${NOISE_TEX}
${TERRAIN_LOOKUP}
${WIND}
${MEADOW}
${PLACE}
${TOWN_SHADOW_V}
${TOWN_MASK_V}
${STRIP}
uniform vec3 uCamPos;
uniform vec3 uSunDir;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vInfo;     // part, random, baked sun, ao
varying vec3 vPetal;
varying vec3 vShape;    // petal count, eye size, eye darkness
varying vec3 vDisc;     // head disc coords, and how far the head has simplified to a plain disc
varying vec3 vStrip;    // how hard the wake has raked this spot, this flower's own luck, how bare it is

void main(){
  vec4 rnd;
  vec2 xz = placeInstance(rnd);
  vec2 uv = worldUV(xz);
  float y = terrainH(xz);
  vec4 splat = textureLod(uSplatTex, uv, 0.0);
  vec4 light = textureLod(uLightTex, uv, 0.0);
  vec3 root = vec3(xz.x, y, xz.y);
  // in a town nothing grows on the paving, and the houses' shadows fall on what does grow
  splat.a *= 1.0 - smoothstep(0.08, 0.5, townMaskV(xz).a);
  light.r *= townShadowV(root + vec3(0.0, 0.35, 0.0));
  float d = distance(root, uCamPos);
  // flowers gather in drifts: denser splat -> more of the candidates bloom
  vec4 r2 = hash42(xz * 3.7 + 1.9);
  float dens = splat.r * splat.a;
  float keep = step(r2.x, dens * 1.08) * step(0.03, dens);
  // ---- one continuous field across the shells. Each flower has a rank; the fraction of this
  // shell's candidates that should show falls with distance, and a flower shrinks into the ground
  // as the threshold reaches its rank rather than popping. Where two shells overlap, one's share
  // falls as the other's rises.
  float rank = hash12(xz * 7.31 + 4.7);
  float dn = max(d, uField.y) / uField.y;
  float want = min(uField.x * pow(dn, -1.5) / uShell.x, 1.0);
  float share = smoothstep(uShell.y, uShell.z, d) * (1.0 - smoothstep(uShell.w * 0.85, uShell.w, d));
  float thr = want * share;
  float fade = smoothstep(0.0, 0.3 * thr + 1e-5, thr - rank) * keep;
  // most candidates do not bloom at any one moment: skip the rest of the work for those
  if (fade <= 0.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // those that remain grow with distance, so the cover - and the colour - holds
  float uSize = 1.15 * pow(dn, 0.75);
  float farK = pow(clamp((d - 6.0) / 110.0, 0.0, 1.0), 0.7);
  // species is an ordinal: look it up unfiltered, from a jittered spot so drifts interleave at
  // their borders instead of meeting along a line
  vec2 sres = vec2(textureSize(uSplatTex, 0));
  vec2 juv = worldUV(xz + (r2.zw - 0.5) * 26.0);
  float species = textureLod(uSplatTex, (floor(juv * sres) + 0.5) / sres, 0.0).g;
  // a few strays from the next drift over
  species = clamp(species + (r2.y > 0.93 ? (r2.y - 0.965) * 9.0 : 0.0), 0.0, 1.0);

  vec3 petal = flowerPetal(species, rnd.z);
  // species silhouettes
  vec4 shp = flowerShape(species);
  float count = shp.x, eye = shp.y;
  float eyeDark = (species >= SP4 && rnd.z < 0.66) ? 1.0 : 0.0;
  float headR = uSize * mix(0.052, 0.080, rnd.w) * shp.z;
  float stemH = mix(0.58, 1.04, rnd.x) * shp.w * (0.7 + 0.3 * splat.a);
  // ---- the wake has been here: the map says what share of the petals it took. They come off one
  // at a time as that share climbs (in the fragment shader) - a flower at the edge of a track, or
  // in the middle of a slow one, loses one or two; in the middle of a fast one only the eye is
  // left on its stem. Far off, where one head stands in for a clump, a stripped head shrinks away.
  float strip = strippedAt(uv);
  float bare = smoothstep(0.0, 0.25, strip - (0.10 + 0.62 * r2.y));
  headR *= 1.0 - bare * farK;
  vStrip = vec3(strip, r2.y, bare);

  // ---- wind + wake: stems sway, heads nod
  float gust = windGust(xz, uTime);
  vec2 wdir = uWind.xy;
  float sway = sin(uTime * (2.3 + rnd.y * 1.9) + rnd.x * 6.2831) * (0.05 + 0.11 * gust);
  float ang = rnd.y * 6.2831853;
  vec2 lean = vec2(cos(ang), sin(ang)) * 0.13 + wdir * (0.05 + 0.42 * gust) * uWind.z + vec2(-wdir.y, wdir.x) * sway;
  vec4 wk = wakeAt(xz);
  float whip = sin(uTime * 19.0 + rnd.y * 40.0) * 0.45 * min(wk.z, 1.0);
  lean += wk.xy * 0.85 * (1.0 + whip) + vec2(-wk.y, wk.x) * whip * 0.3;
  float ll = length(lean);
  float tilt = min(ll, 1.25);
  vec2 ldir = lean / max(ll, 1e-4);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 l3 = vec3(ldir.x, 0.0, ldir.y);
  vec3 p2 = up * (stemH * cos(tilt)) + l3 * (stemH * sin(tilt));
  vec3 p1 = up * (stemH * 0.62) + l3 * (stemH * sin(tilt) * 0.12);

  vec3 P, n;
  float part = position.z;
  if (part < 0.5){
    float t = position.y, it = 1.0 - t;
    vec3 c = p1 * (2.0 * it * t) + p2 * (t * t);
    vec3 tg = normalize(p1 * (2.0 * it - 2.0 * t) + p2 * (2.0 * t));
    vec3 toCam = normalize(uCamPos - (root + c));
    vec3 side = normalize(cross(tg, toCam));
    P = root + c * fade + side * (position.x * 0.0048 * uSize * fade);
    n = normalize(toCam + up * 0.5);
    vDisc = vec3(0.0, 0.0, farK);
  } else {
    // head: a shallow cup turned to the sky, the sun, and along its stem
    vec3 tipTan = normalize(p2 - p1);
    vec3 hn = normalize(tipTan * 0.55 + up * 0.55 + uSunDir * 0.30 + vec3(rnd.x - 0.5, 0.0, rnd.z - 0.5) * 0.7);
    // with distance a head stands in for a whole clump: it turns to face the eye, as a clump
    // seen from the side still shows its colour
    hn = normalize(mix(hn, normalize(uCamPos - root), 0.16 + 0.50 * farK));
    vec3 tx = normalize(cross(hn, vec3(0.31, 0.2, 0.93)));
    vec3 ty = cross(hn, tx);
    float r = length(position.xy);
    P = root + p2 * fade + (tx * position.x + ty * position.y) * headR * fade + hn * (r * r * headR * 0.34 * fade);
    n = normalize(hn + (tx * position.x + ty * position.y) * -0.35);
    vDisc = vec3(position.xy, farK);
  }
  vWorld = P;
  vNormal = n;
  vInfo = vec4(part, rnd.w, light.r, light.g);
  vPetal = petal;
  vShape = vec3(count, eye, eyeDark);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;

const FLOWER_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vInfo;
varying vec3 vPetal;
varying vec3 vShape;
varying vec3 vDisc;
varying vec3 vStrip;
${NOISE}
${ATMOSPHERE}
${CLOUD_SHADOW}
${SHADOW_FN}
void main(){
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);
  float sh = vInfo.z * cloudShadow(vWorld.xz, uTime) * riderShadow(vWorld);
  vec3 alb;
  float alpha = 1.0;
  float glow = 0.0;
  if (vInfo.x < 0.5){
    alb = vec3(0.10, 0.22, 0.045);
  } else {
    float r = length(vDisc.xy);
    float a = atan(vDisc.y, vDisc.x);
    float k = vShape.x;
    // distance from the petal's centre line (0) to the gap between petals (1)
    float pa = abs(fract(a * k / 6.2831853 + 0.5) - 0.5) * 2.0;
    // petal outline: broad blade, pinched at the gaps, little notches at the tip
    float outline = mix(1.0, 0.36, pow(pa, k > 10.0 ? 1.1 : 2.4));
    outline *= 1.0 - 0.07 * cos(pa * 9.0) * step(k, 9.0);
    float fw = max(fwidth(r) * 1.5, 0.02);
    // torn off by the wake: every petal has its own breaking point, so a flower at the edge of
    // the track keeps a few and one in the middle of it is left with only its eye
    float bareR = vShape.y * 0.78;
    float pid = mod(floor(a * k / 6.2831853 + 0.5), k);
    float hold = 0.08 + 0.80 * hash12(vec2(pid * 1.37 + 0.5, vStrip.y * 53.0 + 1.7));
    outline = mix(outline, bareR, smoothstep(hold - 0.03, hold + 0.03, vStrip.x));
    // far off the petals merge into a plain disc
    outline = mix(outline, mix(0.90, bareR, vStrip.z), vDisc.z);
    alpha = smoothstep(outline, outline - max(fw, 0.18 * vDisc.z), r);
    float eye = smoothstep(vShape.y, vShape.y - 0.06, r);
    vec3 pc = vPetal * mix(0.72, 1.08, smoothstep(vShape.y, 0.95, r));
    pc *= 1.0 - 0.14 * pow(pa, 3.0);                               // shadow in the gaps
    pc *= 0.94 + 0.10 * sin(a * k * 3.0) * smoothstep(0.3, 0.9, r); // veins
    vec3 eyeC = mix(vec3(0.95, 0.66, 0.06), vec3(0.05, 0.035, 0.05), vShape.z);
    eyeC *= 0.75 + 0.5 * hash12(floor(vDisc.xy * 22.0));
    eyeC = mix(eyeC, vec3(0.17, 0.23, 0.06), 0.8 * vStrip.z);       // a bare head is mostly calyx
    alb = mix(pc, eyeC, eye);
    glow = (1.0 - eye);
    if (alpha < 0.02) discard;
  }
  if (dot(N, V) < 0.0) N = -N;
  float ndl = dot(N, uSunDir);
  float dif = saturate(ndl * 0.5 + 0.5);
  // petals are thin: they light up from behind
  float back = pow(saturate(dot(V, -uSunDir) * 0.5 + 0.5), 3.0) * glow;
  vec3 col = alb * uSunColor * (dif + back * 0.9) * sh;
  col += alb * mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * (0.55 + 0.45 * vInfo.w) * mix(0.8, 1.25, glow);
  col = applyAtmosphere(col, vWorld);
  gl_FragColor = vec4(col, alpha);
}
`;

// ----------------------------------------------------------------------------------------
class Shell {
  constructor(meadow, def, kind) {
    this.def = def;
    this.kind = kind;
    this.n = Math.max(2, Math.round(Math.sqrt(def.per * def.cell * def.cell)));
    this.geo = kind === 'grass' ? bladeGeometry(def.segs) : flowerGeometry(def.lod);
    this.geo.instanceCount = this.n * this.n;
    this.pool = [];
    this.meadow = meadow;
    this.active = 0;
  }
  material() {
    const def = this.def;
    const uniforms = {
      ...shared(...SHARED),
      uCell: { value: new THREE.Vector4() },
      uFade: { value: new THREE.Vector4(...(def.fade || [0, 0, 1e9, 1e9])) },
      uGridN: { value: this.n },
      uCamPos2: { value: new THREE.Vector3() },
    };
    if (this.kind === 'grass') {
      Object.assign(uniforms, { uSegs: { value: def.segs }, uBlade: { value: new THREE.Vector2(def.width, def.height) }, uLeanK: { value: def.lean }, uRoot: { value: def.root } });
      return new THREE.ShaderMaterial({ uniforms, vertexShader: GRASS_VERT, fragmentShader: GRASS_FRAG, side: THREE.DoubleSide });
    }
    uniforms.uShell = { value: new THREE.Vector4(def.per, def.near, def.full, def.far) };
    uniforms.uField = { value: new THREE.Vector2(def.n0, FLOWER_D0) };
    return new THREE.ShaderMaterial({ uniforms, vertexShader: FLOWER_VERT, fragmentShader: FLOWER_FRAG, side: THREE.DoubleSide, alphaToCoverage: true });
  }
  mesh(i) {
    while (this.pool.length <= i) {
      const m = new THREE.Mesh(this.geo, this.material());
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.visible = false;
      this.meadow.group.add(m);
      this.pool.push(m);
    }
    return this.pool[i];
  }
}

export class Meadow {
  constructor(terrain, quality = 'high') {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this._buildCoverGrid();
    this.setQuality(quality);
    this._fr = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._list = [];
    this.stats = { cells: 0, blades: 0, flowers: 0 };
  }

  setQuality(name) {
    const q = QUALITY[name] || QUALITY.high;
    if (this.shells) for (const s of this.shells) { for (const m of s.pool) { this.group.remove(m); m.material.dispose(); } s.geo.dispose(); }
    this.shells = [
      ...grassShells(q.grass).map((d) => new Shell(this, d, 'grass')),
      ...flowerShells(q.flowers).map((d) => new Shell(this, d, 'flower')),
    ];
    this.quality = name;
  }

  /** Coarse max-pooled masks so empty cells (sea, rock, bare meadow) cost nothing. */
  _buildCoverGrid() {
    const S = this.terrain.splatN, px = this.terrain.splat;
    const G = (this.G = 384);
    const k = S / G;
    const grass = (this.coverGrass = new Uint8Array(G * G));
    const flower = (this.coverFlower = new Uint8Array(G * G));
    for (let gz = 0; gz < G; gz++) for (let gx = 0; gx < G; gx++) {
      let mg = 0, mf = 0;
      const z0 = Math.floor(gz * k), z1 = Math.min(S, Math.ceil((gz + 1) * k));
      const x0 = Math.floor(gx * k), x1 = Math.min(S, Math.ceil((gx + 1) * k));
      for (let z = z0; z < z1; z += 2) for (let x = x0; x < x1; x += 2) {
        const i = (z * S + x) * 4;
        const a = px[i + 3];
        if (a > mg) mg = a;
        const f = (px[i] * a) >> 8;
        if (f > mf) mf = f;
      }
      grass[gz * G + gx] = mg; flower[gz * G + gx] = mf;
    }
  }
  _covered(grid, x0, z0, size) {
    const G = this.G, s = G / World.size;
    const gx0 = Math.max(0, Math.floor((x0 + World.half) * s)), gx1 = Math.min(G - 1, Math.floor((x0 + size + World.half) * s));
    const gz0 = Math.max(0, Math.floor((z0 + World.half) * s)), gz1 = Math.min(G - 1, Math.floor((z0 + size + World.half) * s));
    for (let z = gz0; z <= gz1; z++) for (let x = gx0; x <= gx1; x++) if (grid[z * G + x] > 6) return true;
    return false;
  }

  update(camera) {
    const cam = camera.position, T = this.terrain;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._fr.setFromProjectionMatrix(this._m, camera.coordinateSystem, camera.reversedDepth);
    const box = this._box;
    let cells = 0, blades = 0, flowers = 0;
    for (const sh of this.shells) {
      const { cell, fade } = sh.def;
      // reach of this shell, and (for the flower shells) the radius inside which a nearer one has it covered
      const R = fade ? fade[3] : sh.def.far, Rin = fade ? 0 : Math.max(0, sh.def.near - cell * 1.5 - 3);
      const grid = sh.kind === 'grass' ? this.coverGrass : this.coverFlower;
      const list = this._list;
      list.length = 0;
      // the camera can be far above the ground: nothing to draw then
      const ground = Math.max(T.heightAt(cam.x, cam.z), 0);
      if (cam.y - ground < R + 30 && !(this.hide && this.hide[sh.kind])) {
        const cx0 = Math.floor((cam.x - R) / cell), cx1 = Math.floor((cam.x + R) / cell);
        const cz0 = Math.floor((cam.z - R) / cell), cz1 = Math.floor((cam.z + R) / cell);
        for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
          const x0 = cx * cell, z0 = cz * cell;
          const nx = Math.max(x0, Math.min(cam.x, x0 + cell)), nz = Math.max(z0, Math.min(cam.z, z0 + cell));
          const mx = x0 + cell * 0.5, mz = z0 + cell * 0.5;
          const h = T.heightAt(mx, mz);
          const dy = cam.y - h;
          const d2 = (nx - cam.x) ** 2 + (nz - cam.z) ** 2;
          if (d2 + Math.max(0, Math.abs(dy) - cell) ** 2 > R * R) continue;
          if (Rin > 0 && (mx - cam.x) ** 2 + (mz - cam.z) ** 2 + dy * dy < Rin * Rin) continue;
          if (!this._covered(grid, x0, z0, cell)) continue;
          const slack = cell * 0.9 + 2;
          box.min.set(x0 - 0.5, h - slack, z0 - 0.5);
          box.max.set(x0 + cell + 0.5, h + slack + 1.5, z0 + cell + 0.5);
          if (!this._fr.intersectsBox(box)) continue;
          list.push({ x0, z0, d2, seed: ((cx * 73856093) ^ (cz * 19349663)) & 0xffff });
        }
        list.sort((a, b) => a.d2 - b.d2);
      }
      for (let i = 0; i < list.length; i++) {
        const c = list[i], m = sh.mesh(i);
        m.material.uniforms.uCell.value.set(c.x0, c.z0, cell, c.seed * 0.0137);
        m.renderOrder = (sh.kind === 'grass' ? 100 : 60) + Math.min(i, 399) * 0.1;
        m.visible = true;
      }
      for (let i = list.length; i < sh.active; i++) sh.pool[i].visible = false;
      sh.active = list.length;
      cells += list.length;
      if (sh.kind === 'grass') blades += list.length * sh.n * sh.n; else flowers += list.length * sh.n * sh.n;
    }
    this.stats.cells = cells; this.stats.blades = blades; this.stats.flowers = flowers;
  }
}
