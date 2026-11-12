// Wind-blown shell fur for the catbus.
//
// Renders a compact stack of concentric SkinnedMesh / Mesh shells sharing a watertight fur-hull
// geometry and the creature's skeleton (zero extra bone skinning CPU work). Driven by the game's
// shared wind gusts (uWind + uNoiseTex), wake field (uWakeTex), and the catbus's own velocity
// and flight state. Hardware 4x MSAA alpha-to-coverage gives soft tapered tufts without sorting.
import * as THREE from 'three';
import { shared } from '../core/ctx.js';
import { NOISE, NOISE_TEX, CLOUD_SHADOW, WIND } from '../shaders/common.js';
import { SKY_UNIFORMS } from '../world/sky.js';

const MAX_SHELLS = 5;
const LOD_FULL = 16;   // m: all 5 shells inside this camera distance
const LOD_MID = 32;    // m: 3 shells inside this distance
const LOD_FAR = 58;    // m: 1 shell out to here; 0 shells beyond

// Procedural coat fallback used only when running with the procedural placeholder rig.
export const TABBY_COAT_GLSL = /* glsl */`
vec3 catbusCoatColor(vec3 rp, vec3 rn, out float furMaskOut){
  vec3 ginger = vec3(0.58, 0.20, 0.042);
  vec3 gingerBright = vec3(0.74, 0.30, 0.068);
  vec3 stripeDark = vec3(0.20, 0.058, 0.012);
  vec3 cream = vec3(0.88, 0.78, 0.60);
  vec3 nosePink = vec3(0.72, 0.32, 0.28);

  float dorsal = smoothstep(0.55, 2.05, rp.y);
  vec3 coat = mix(gingerBright, ginger, dorsal * 0.75);

  float warp = sin(rp.y * 4.2 + rp.x * 2.3) * 0.22 + sin(rp.z * 2.1 - rp.y * 3.1) * 0.12;
  float band = sin((rp.z + warp) * 10.5);
  float legBand = sin(rp.y * 19.0 + rp.z * 3.0) * smoothstep(0.85, 0.25, rp.y);
  float tailMask = smoothstep(1.85, 2.45, rp.z);
  float tailRing = sin(rp.z * 16.0 + rp.y * 4.0);
  float headFore = smoothstep(-1.55, -2.15, rp.z);
  float browStripe = sin(rp.x * 16.0) * smoothstep(1.35, 1.85, rp.y) * headFore;

  float stripe = smoothstep(0.32, 0.78, mix(band, tailRing, tailMask) + legBand * 0.45 + browStripe * 0.35);
  stripe *= smoothstep(0.45, 1.05, rp.y) * 0.85 + 0.15 * tailMask;
  coat = mix(coat, stripeDark, stripe * 0.78);

  float muzzle = smoothstep(0.72, 0.22, length((rp - vec3(0.0, 1.16, -2.42)) * vec3(1.05, 1.35, 1.15)));
  float chest = smoothstep(0.95, 0.30, length((rp - vec3(0.0, 0.82, -1.78)) * vec3(1.15, 1.1, 1.1)));
  float belly = smoothstep(0.82, 0.42, rp.y) * smoothstep(0.95, 0.35, abs(rp.x)) * (1.0 - tailMask * 0.8);
  float paws = smoothstep(0.28, 0.08, rp.y) * (1.0 - tailMask);
  float tailTip = smoothstep(3.15, 3.65, rp.z);
  float earInner = smoothstep(2.02, 2.32, rp.y) * headFore * smoothstep(0.22, 0.02, -rn.z);
  float creamAmt = saturate(max(max(muzzle * 0.96, chest * 0.88), max(belly * 0.85, max(paws * 0.92, max(tailTip * 0.75, earInner * 0.7)))));
  coat = mix(coat, cream, creamAmt);

  float atFront = smoothstep(-2.22, -2.48, rp.z) * smoothstep(0.1, 0.5, -rn.z);
  float noseY = rp.y - 1.26;
  float noseW = max(0.0, 0.085 + noseY * 0.55);
  float nose = (1.0 - smoothstep(noseW - 0.015, noseW + 0.015, abs(rp.x)))
             * smoothstep(1.17, 1.20, rp.y) * (1.0 - smoothstep(1.29, 1.32, rp.y)) * atFront;
  coat = mix(coat, nosePink, nose);

  float smileCurve = 1.07 + 0.26 * rp.x * rp.x - 0.035 * cos(clamp(rp.x * 11.0, -3.14159, 3.14159));
  float smileDist = abs(rp.y - smileCurve);
  float philtrum = (1.0 - smoothstep(0.010, 0.022, abs(rp.x))) * smoothstep(1.06, 1.09, rp.y) * (1.0 - smoothstep(1.18, 1.20, rp.y));
  float smileLine = (1.0 - smoothstep(0.013, 0.028, smileDist)) * (1.0 - smoothstep(0.34, 0.42, abs(rp.x)));
  float mouth = saturate(max(smileLine, philtrum)) * atFront;
  coat = mix(coat, vec3(0.11, 0.045, 0.025), mouth * 0.92);

  furMaskOut = 1.0 - max(nose * 0.85, mouth * 0.85);
  return coat;
}
`;

export class FurCoat {
  /**
   * Attach wind-blown fur shells to one or more furry meshes on the catbus.
   * @param targets Array of Mesh or SkinnedMesh objects that supply the fur hull geometry
   * @param opts    { length, density, restScale, proceduralCoat, materialSource }
   */
  constructor(targets, opts = {}) {
    this.shells = [];
    this.length = opts.length ?? 0.082;
    this.density = opts.density ?? 48.0;
    this.restScale = opts.restScale ?? 1.0;
    this.proceduralCoat = !!opts.proceduralCoat;
    this.materialSource = opts.materialSource || null;

    this.sharedUniforms = {
      uFurLen: { value: this.length },
      uFurDensity: { value: this.density },
      uRestScale: { value: this.restScale },
      uSunVis: { value: 1.0 },
      uCatVel: { value: new THREE.Vector3() },
      uCatBack: { value: new THREE.Vector3(0, 0, 1) },
      uCatFlight: { value: 0 },
      uCatBoost: { value: 0 },
      uShellActive: { value: MAX_SHELLS },
      uLodFade: { value: 1.0 },
    };

    for (const src of targets) {
      this._attachToMesh(src);
    }
  }

  _attachToMesh(src) {
    const geo = src.geometry;
    const rawMat = this.materialSource || src.material;
    const sm = Array.isArray(rawMat) ? rawMat[0] : rawMat;
    const hasCatAttr = !!geo.attributes._cat;
    const hasFurAttr = !!geo.attributes.aFur;
    const hasMap = !!(sm && sm.map) && !this.proceduralCoat;
    const hasRoughMap = !!(sm && sm.roughnessMap) && !this.proceduralCoat;
    const hasVColor = !!geo.attributes.color;
    const baseColor = sm && sm.color ? new THREE.Vector3(sm.color.r, sm.color.g, sm.color.b) : new THREE.Vector3(1, 1, 1);

    const defines = {};
    if (hasCatAttr) defines.HAS_CAT_ATTR = '';
    else if (hasFurAttr) defines.HAS_FUR_ATTR = '';
    if (!this.proceduralCoat) {
      defines.HAS_MAP = '';
      if (hasRoughMap || hasCatAttr) defines.HAS_ROUGHMAP = '';
    }
    if (this.proceduralCoat) defines.PROC_COAT = '';
    if (hasVColor) defines.HAS_VCOLOR = '';

    for (let i = 0; i < MAX_SHELLS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...shared(...SKY_UNIFORMS, 'uTime', 'uNoiseTex', 'uWind', 'uWakeTex', 'uWake'),
          ...this.sharedUniforms,
          uShellIndex: { value: (i + 1) / MAX_SHELLS },
          tMap: { value: hasMap ? sm.map : null },
          tRough: { value: hasRoughMap ? sm.roughnessMap : null },
          uBaseColor: { value: baseColor },
        },
        defines: { ...defines },
        vertexShader: FUR_VERT,
        fragmentShader: FUR_FRAG,
        alphaToCoverage: true,
        depthTest: true,
        depthWrite: true,
        side: THREE.FrontSide,
      });

      let shell;
      if (src.isSkinnedMesh) {
        shell = new THREE.SkinnedMesh(geo, mat);
        shell.bind(src.skeleton, src.bindMatrix);
      } else {
        shell = new THREE.Mesh(geo, mat);
      }
      shell.name = `${src.name || 'catbus'}_fur_${i + 1}`;
      shell.frustumCulled = false;
      shell.castShadow = false;
      shell.receiveShadow = false;
      shell.renderOrder = (src.renderOrder || 0) + 1 + i;

      shell.position.copy(src.position);
      shell.quaternion.copy(src.quaternion);
      shell.scale.copy(src.scale);
      if (src.parent) src.parent.add(shell);

      this.shells.push({ mesh: shell, layer: i + 1, src });
    }
  }

  /**
   * Per-frame update: adjusts shell count LOD by camera distance and updates wind/motion uniforms.
   */
  update(worldPos, vel, fwd, inFlight, boosting, sunVis, camPos) {
    const u = this.sharedUniforms;
    const dist = worldPos.distanceTo(camPos);

    let active = 0;
    if (dist < LOD_FULL) active = 5;
    else if (dist < LOD_MID) active = 3;
    else if (dist < LOD_FAR) active = 1;

    const fade = 1 - THREE.MathUtils.smoothstep(dist, LOD_FAR - 12, LOD_FAR);
    u.uShellActive.value = Math.max(active, 1);
    u.uLodFade.value = fade;
    u.uSunVis.value = sunVis;
    u.uCatVel.value.copy(vel);
    u.uCatBack.value.set(-fwd.x, -fwd.y, -fwd.z);
    u.uCatFlight.value = inFlight;
    u.uCatBoost.value = boosting;

    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      let show = false;
      let shellFrac = 1;
      if (active === 5) {
        show = true;
        shellFrac = s.layer / 5;
      } else if (active === 3) {
        show = s.layer <= 3;
        shellFrac = s.layer / 3;
      } else if (active === 1) {
        show = s.layer === 1;
        shellFrac = 0.65;
      }
      // Note: if s.src is a dedicated hidden fur-hull template (userData.templateHull), ignore s.src.visible
      const hostVisible = s.src.userData.templateHull ? true : s.src.visible;
      s.mesh.visible = show && hostVisible && fade > 0.02;
      if (s.mesh.visible) {
        const mapSrc = this.materialSource || s.src.material;
        if (mapSrc?.map && !s.mesh.material.uniforms.tMap.value) {
          s.mesh.material.uniforms.tMap.value = mapSrc.map;
        }
        if (mapSrc?.roughnessMap && !s.mesh.material.uniforms.tRough.value) {
          s.mesh.material.uniforms.tRough.value = mapSrc.roughnessMap;
        }
        s.mesh.material.uniforms.uShellIndex.value = shellFrac;
      }
    }
    this.activeShells = active;
  }

  dispose() {
    for (const s of this.shells) {
      s.mesh.parent?.remove(s.mesh);
      s.mesh.material.dispose();
    }
    this.shells.length = 0;
  }
}

const FUR_VERT = /* glsl */`
precision highp float;
#ifdef HAS_CAT_ATTR
attribute vec4 _cat;
#endif
#ifdef HAS_FUR_ATTR
attribute float aFur;
#endif
#ifdef HAS_MAP
varying vec2 vUv;
#endif
#ifdef HAS_VCOLOR
varying vec3 vVColor;
#endif

uniform float uTime;
uniform float uShellIndex;
uniform float uFurLen;
uniform float uRestScale;
uniform float uLodFade;
uniform vec3 uCatVel;
uniform vec3 uCatBack;
uniform float uCatFlight;
uniform float uCatBoost;

#include <skinning_pars_vertex>
${NOISE_TEX}
${WIND}

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vRestPos;
varying vec3 vRestN;
varying vec3 vFurInfo;       // shell h (0..1), furMask, gustRipple

void main() {
  #ifdef HAS_MAP
    vUv = uv;
  #endif
  #ifdef HAS_VCOLOR
    vVColor = color;
  #endif

  float furMask = 1.0;
  #ifdef HAS_CAT_ATTR
    furMask = _cat.r;
  #endif
  #ifdef HAS_FUR_ATTR
    furMask = aFur;
  #endif

  vRestPos = position * uRestScale;
  vRestN = normalize(normal);

  float h = uShellIndex;
  if (furMask <= 0.02) {
    // Collapse non-furry vertices onto the base skin rather than off-screen clip space,
    // otherwise triangles straddling a fur/non-fur boundary stretch across the sky!
    h = 0.0;
    furMask = 0.0;
  }

  vec3 objectNormal = normal;
  vec3 transformed = position;

  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>

  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * objectNormal);

  // ---- Sample Petalwake's shared wind gusts & wake field
  float gust = windGust(wp.xz, uTime);
  vec4 wk = wakeAt(wp.xz);

  vec3 ambWind = vec3(uWind.x, 0.08 * gust, uWind.y) * (1.8 + 5.6 * gust) * uWind.z;
  vec3 wakePush = vec3(wk.x * 6.5, -wk.z * 1.1, wk.y * 6.5);
  vec3 slip = -uCatVel * (0.28 + 0.14 * uCatFlight);
  vec3 rawFlow = ambWind + wakePush + slip + uCatBack * 1.4 + vec3(0.0, -0.8, 0.0);

  // Project airflow onto surface tangent plane so fur combs sleekly along the body
  float into = min(0.0, dot(rawFlow, wn));
  vec3 tangFlow = rawFlow - wn * (dot(rawFlow, wn) * 0.84 + into * 0.16);
  float flowMag = length(tangFlow);
  vec3 flowDir = tangFlow / max(flowMag, 1e-4);

  // Travelling wind-ripple waves racing down the coat with gusts, speed, and flight
  float speed01 = clamp(length(uCatVel) / 48.0, 0.0, 1.3);
  float waveFreq = 5.2;
  float waveRate = 6.5 + flowMag * 0.48 + uCatBoost * 9.0 + uCatFlight * 3.5;
  float streamCoord = dot(vRestPos, vec3(0.35, 0.45, 1.0)) * waveFreq;
  float w1 = sin(streamCoord - uTime * waveRate);
  float w2 = sin(streamCoord * 1.85 + vRestPos.x * 7.3 - uTime * waveRate * 1.37 + 1.4);
  float ripple = (w1 * 0.64 + w2 * 0.36) * (0.25 + 0.45 * gust + 0.55 * speed01 + 0.35 * min(wk.z, 1.0));

  float sleek = mix(1.0, 0.70, clamp(flowMag / 34.0, 0.0, 1.0));
  float len = uFurLen * furMask * uLodFade;
  float bendAmt = clamp(flowMag * 0.044, 0.0, 1.18) * len;
  vec3 crossDir = normalize(cross(wn, flowDir) + vec3(1e-4));

  float h2 = h * h;
  wp.xyz += wn * (len * h * sleek * (1.0 + 0.16 * ripple))
          + flowDir * (bendAmt * h2 * (1.0 + 0.28 * w1))
          + crossDir * (len * 0.14 * h2 * w2 * (0.3 + 0.7 * speed01));

  vNormalW = normalize(wn + flowDir * (0.32 * h * clamp(flowMag / 18.0, 0.0, 1.0)) + wn * (0.08 * ripple));
  vWorld = wp.xyz;
  vFurInfo = vec3(h, furMask, 0.5 + 0.5 * ripple);

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FUR_FRAG = /* glsl */`
precision highp float;
#ifdef HAS_MAP
uniform sampler2D tMap;
varying vec2 vUv;
#endif
#ifdef HAS_ROUGHMAP
uniform sampler2D tRough;
#endif
#ifdef HAS_VCOLOR
varying vec3 vVColor;
#endif

uniform vec3 uBaseColor;
uniform float uTime;
uniform float uFurDensity;
uniform float uSunVis;
uniform float uLodFade;

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vRestPos;
varying vec3 vRestN;
varying vec3 vFurInfo;

${NOISE}
${CLOUD_SHADOW}
#ifdef PROC_COAT
${TABBY_COAT_GLSL}
#endif

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uCamPos;

vec2 furPlane(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  vec4 rnd = hash42(cell);
  vec2 off = (rnd.xy - 0.5) * 0.56;
  float r = length(f - off);
  float rad = mix(0.46, 0.68, rnd.z);
  float tipH = mix(0.38, 1.06, rnd.w);
  float cone = tipH * (1.0 - clamp(r / rad, 0.0, 1.25));
  return vec2(cone, rnd.z);
}

void main() {
  float h = clamp(vFurInfo.x, 0.0, 1.0);
  float furMask = vFurInfo.y;
  if (furMask <= 0.02) discard;

  // Pixel-level window/eye mask from ORM roughness map so edges around wooden cross frames stay razor-sharp
  #if defined(HAS_MAP) && defined(HAS_ROUGHMAP)
    float rough = texture(tRough, vUv).g;
    if (rough < 0.52) discard;
  #endif

  vec3 bw = pow(abs(normalize(vRestN)), vec3(4.0));
  bw /= max(bw.x + bw.y + bw.z, 1e-4);
  // Higher tuft density & wider tapered cones so the 5 shells form a plush, cohesive ginger tabby coat
  vec3 sp = vRestPos * vec3(uFurDensity * 1.45, uFurDensity * 1.45, uFurDensity * 0.95);
  vec2 fx = furPlane(sp.zy + vec2(13.7, 5.1));
  vec2 fy = furPlane(sp.xz + vec2(3.3, 29.9));
  vec2 fz = furPlane(sp.xy + vec2(41.2, 17.4));
  vec2 tuft = fx * bw.x + fy * bw.y + fz * bw.z;

  float aa = max(fwidth(tuft.x) * 1.15, 0.10);
  float alpha = smoothstep(h * 0.88 - aa, h * 0.88 + aa, tuft.x) * uLodFade;
  if (alpha < 0.06) discard;

  vec3 alb = uBaseColor;
  #ifdef PROC_COAT
    float procMask = 1.0;
    alb = catbusCoatColor(vRestPos, normalize(vRestN), procMask);
    if (procMask < 0.25) discard;
  #endif
  #ifdef HAS_MAP
    vec3 texCol = texture(tMap, vUv).rgb;
    // GLB baseColorTexture is sRGB; ShaderMaterial reads raw sRGB unless converted if colorSpace wasn't decoded,
    // wait: three.js WebGL2 decodes SRGBColorSpace textures in hardware!
    alb *= texCol;
  #endif
  #ifdef HAS_VCOLOR
    alb *= vVColor;
  #endif

  alb *= mix(0.88, 1.12, tuft.y);
  vec3 rootTint = alb * vec3(0.56, 0.48, 0.44);
  vec3 tipTint = alb * vec3(1.16, 1.10, 1.02) + vec3(0.030, 0.015, 0.003) * h;
  alb = mix(rootTint, tipTint, pow(h, 0.82));

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(uCamPos - vWorld);
  float sh = uSunVis * cloudShadow(vWorld.xz, uTime);
  float ndl = dot(N, uSunDir);
  float dif = clamp(ndl * 0.58 + 0.42, 0.0, 1.0);
  float ao = mix(0.50, 1.06, pow(h, 0.75));

  vec3 amb = mix(uAmbGround * 1.35, uAmbSky, N.y * 0.5 + 0.5) * ao * 0.94;
  vec3 col = alb * (uSunColor * dif * sh * mix(0.76, 1.05, h) + amb);

  float rim = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 2.3);
  float back = pow(clamp(dot(V, -uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  col += alb * uSunColor * (0.13 * rim + 0.32 * back * rim) * h * (0.35 + 0.65 * sh);

  vec3 H = normalize(uSunDir + V);
  float sheen = pow(clamp(dot(N, H), 0.0, 1.0), 14.0) * vFurInfo.z * h;
  col += uSunColor * sheen * sh * 0.10;

  gl_FragColor = vec4(col, alpha);
}
`;
