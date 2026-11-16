// Frame pipeline:
//   world (HDR, MSAA, depth) -> camera motion blur -> rider + particles drawn sharp on top
//   -> bloom pyramid -> god rays -> lens (distortion, fringe, vignette) + grade + tonemap.
import * as THREE from 'three';
import { U } from './ctx.js';
import { TONEMAP } from '../shaders/common.js';

const tri = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
})();
const FSV = /* glsl */`varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function pass(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: FSV, fragmentShader, depthTest: false, depthWrite: false });
}

export class Pipeline {
  constructor(renderer, graphics = {}) {
    this.renderer = renderer;
    this.reversed = renderer.capabilities.reversedDepthBuffer === true;
    this.scale = 1;
    this.samples = Math.min(graphics.samples ?? 4, renderer.capabilities.maxSamples ?? 4);
    this.bloomEnabled = graphics.bloom !== false;
    this.raysEnabled = graphics.rays !== false;
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
    this.quad = new THREE.Mesh(tri, null);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new THREE.Vector2(1, 1);

    this.prevViewProj = new THREE.Matrix4();
    this.viewProj = new THREE.Matrix4();
    this.invViewProj = new THREE.Matrix4();
    this.hasPrev = false;

    this.params = {
      exposure: 1.0,
      blur: 1.0,          // motion blur strength
      bloom: 0.085,
      distortion: 0.10,   // lens barrel
      fringe: 0.0016,     // chromatic aberration at the edges
      vignette: 0.26,
      rays: 0.55,
      saturation: 1.12,
      contrast: 1.04,
      speed: 0,           // 0..1, drives the speed-dependent lens effects
    };
    if (graphics.blur === false) this.params.blur = 0;
    if (!this.bloomEnabled) this.params.bloom = 0;
    if (!this.raysEnabled) this.params.rays = 0;

    const depthU = { value: null };
    this.uDepth = depthU;
    this.uScene = { value: null };

    this.blurMat = pass(BLUR_FRAG, {
      tColor: this.uScene,
      tDepth: depthU,
      uInvViewProj: { value: this.invViewProj },
      uPrevViewProj: { value: this.prevViewProj },
      uStrength: { value: 0 },
      uRes: { value: this.size },
      uTime: U.uTime,
    });
    // The blur quad opens the sharp layer: it writes the blurred world AND the world's depth, so the
    // rider and particles that follow are depth-tested against the scene by the hardware.
    this.blurMat.depthTest = true;
    this.blurMat.depthFunc = THREE.AlwaysDepth;
    this.blurMat.depthWrite = true;
    if (this.reversed) this.blurMat.defines = { REVERSED: '' };
    this.overlay = new THREE.Scene();
    this.blurQuad = new THREE.Mesh(tri, this.blurMat);
    this.blurQuad.frustumCulled = false;
    this.blurQuad.renderOrder = -10000;
    this.overlay.add(this.blurQuad);
    this.copyMat = pass(/* glsl */`varying vec2 vUv; uniform sampler2D tColor; void main(){ gl_FragColor = texture(tColor, vUv); }`, { tColor: { value: null } });
    this.downMat = pass(DOWN_FRAG, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.upMat = pass(UP_FRAG, { tColor: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
    this.raysMat = pass(RAYS_FRAG, {
      tColor: { value: null }, tDepth: depthU, uSun: { value: new THREE.Vector3() }, uAspect: { value: 1 }, uFar: { value: this.reversed ? 0 : 1 }, uTime: U.uTime,
    });
    this.finalMat = pass(FINAL_FRAG, {
      tColor: { value: null }, tBloom: { value: null }, tRays: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0.08 }, uDistort: { value: 0.1 }, uFringe: { value: 0.002 }, uVignette: { value: 0.3 },
      uRays: { value: 0.5 }, uSunColor: U.uSunColor, uSat: { value: 1.1 }, uContrast: { value: 1.05 }, uRes: { value: this.size }, uTime: U.uTime,
      uSpeed: { value: 0 }, uFade: { value: 1 },
    });
    this.fade = 1;
  }

  setSize(w, h, pixelRatio) {
    const W = Math.max(8, Math.round(w * pixelRatio * this.scale));
    const H = Math.max(8, Math.round(h * pixelRatio * this.scale));
    if (W === this.size.x && H === this.size.y) return;
    this.size.set(W, H);
    this.dispose();
    const depth = new THREE.DepthTexture(W, H, THREE.FloatType);
    depth.format = THREE.DepthFormat;
    this.sceneRT = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples: this.samples, depthBuffer: true, depthTexture: depth,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    // second target: blurred world + sharp rider/particles (own depth buffer for the rider's self-occlusion)
    this.compRT = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples: this.samples, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.bloom = [];
    let bw = W >> 1, bh = H >> 1;
    for (let i = 0; this.bloomEnabled && i < 7 && bw > 4 && bh > 4; i++) {
      this.bloom.push(new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
      bw >>= 1; bh >>= 1;
    }
    this.bloomUp = this.bloom.slice(0, -1).map((rt) => rt.clone());
    this.raysRT = this.raysEnabled ? new THREE.WebGLRenderTarget(W >> 1, H >> 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }) : null;
    this.uDepth.value = depth;
    this.uScene.value = this.sceneRT.texture;
  }

  dispose() {
    for (const rt of [this.sceneRT, this.compRT, this.raysRT, ...(this.bloom || []), ...(this.bloomUp || [])]) rt?.dispose();
  }

  _blit(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /**
   * @param world scene with everything that should motion-blur. Whatever is in this.overlay
   *              (rider, particles) is drawn sharp on top afterwards.
   */
  render(world, camera, dt) {
    const r = this.renderer, p = this.params;
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invViewProj.copy(this.viewProj).invert();

    // 1. world
    r.setRenderTarget(this.sceneRT);
    r.render(world, camera);

    // 2 + 3. motion-blurred world, then the sharp layer, in one pass
    const shutter = dt > 0 ? Math.min((1 / 60) / dt, 2.0) : 1.0; // constant apparent streak length regardless of frame rate
    this.blurMat.uniforms.uStrength.value = this.hasPrev ? p.blur * 0.62 * shutter : 0;
    r.setRenderTarget(this.compRT);
    r.render(this.overlay, camera);

    // 4. bloom
    let src = this.black;
    if (this.bloomEnabled && p.bloom > 0) {
      src = this.compRT.texture;
      for (let i = 0; i < this.bloom.length; i++) {
        const rt = this.bloom[i];
        this.downMat.uniforms.tColor.value = src;
        this.downMat.uniforms.uTexel.value.set(1 / (rt.width * 2), 1 / (rt.height * 2));
        this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
        this._blit(this.downMat, rt);
        src = rt.texture;
      }
      for (let i = this.bloom.length - 2; i >= 0; i--) {
        const rt = this.bloomUp[i];
        this.upMat.uniforms.tColor.value = src;
        this.upMat.uniforms.tAdd.value = this.bloom[i].texture;
        this.upMat.uniforms.uTexel.value.set(1 / rt.width, 1 / rt.height);
        this._blit(this.upMat, rt);
        src = rt.texture;
      }
    }

    // 5. god rays from the sun's screen position
    if (this.raysEnabled && p.rays > 0) {
      const sun = this._sun || (this._sun = new THREE.Vector3());
      sun.copy(U.uSunDir.value).multiplyScalar(1e5).add(camera.position).project(camera);
      const camDir = camera.getWorldDirection(this._cd || (this._cd = new THREE.Vector3()));
      const facing = camDir.dot(U.uSunDir.value);
      this.raysMat.uniforms.tColor.value = this.compRT.texture;
      this.raysMat.uniforms.uSun.value.set(sun.x * 0.5 + 0.5, sun.y * 0.5 + 0.5, Math.max(0, (facing - 0.15) / 0.85));
      this.raysMat.uniforms.uAspect.value = this.size.x / this.size.y;
      this._blit(this.raysMat, this.raysRT);
    }

    // 6. lens + grade
    const f = this.finalMat.uniforms;
    f.tColor.value = this.compRT.texture;
    f.tBloom.value = src;
    f.tRays.value = this.raysRT?.texture || this.black;
    f.uExposure.value = p.exposure;
    f.uBloom.value = p.bloom;
    f.uDistort.value = p.distortion;
    f.uFringe.value = p.fringe;
    f.uVignette.value = p.vignette;
    f.uRays.value = p.rays;
    f.uSat.value = p.saturation;
    f.uContrast.value = p.contrast;
    f.uSpeed.value = p.speed;
    f.uFade.value = this.fade;
    this._blit(this.finalMat, null);

    this.prevViewProj.copy(this.viewProj);
    this.hasPrev = true;
  }
}

// ---------------------------------------------------------------------------------------
const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uStrength;
uniform vec2 uRes;
uniform float uTime;
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 safe(vec3 c){ return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : max(c, vec3(0.0)); }
void main(){
  vec4 c0 = texture(tColor, vUv);
  c0.rgb = safe(c0.rgb);
  float z = texture(tDepth, vUv).r;
  gl_FragDepth = z;
  if (uStrength <= 0.0){ gl_FragColor = c0; return; }
  vec4 clip = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  #ifdef REVERSED
  clip.z = z;
  #endif
  vec4 wp = uInvViewProj * clip;
  wp /= wp.w;
  vec4 pc = uPrevViewProj * vec4(wp.xyz, 1.0);
  vec2 prevUv = pc.xy / pc.w * 0.5 + 0.5;
  vec2 vel = (vUv - prevUv) * uStrength;
  if (pc.w <= 0.0) vel = vec2(0.0);
  // clamp the streak so near-ground pixels do not smear across the whole frame
  float len = length(vel * uRes);
  float maxLen = 0.085 * uRes.y;
  if (len > maxLen) vel *= maxLen / len;
  if (len < 0.6){ gl_FragColor = c0; return; }
  const int TAPS = 13;
  float j = ign(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++){
    float t = (float(i) + j) / float(TAPS - 1) - 0.5;
    vec2 uv = vUv + vel * t;
    vec3 s = safe(texture(tColor, clamp(uv, 0.001, 0.999)).rgb);
    // highlights streak further (keeps sparkles on water and petals lively)
    float w = 1.0 + dot(s, vec3(0.2126, 0.7152, 0.0722)) * 0.35;
    acc += s * w; wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uFirst;
vec3 pre(vec3 c){
  if (uFirst < 0.5) return c;
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  c = max(c, vec3(0.0));
  // soft knee threshold so only the genuinely bright parts glow, plus firefly clamp
  c = min(c, vec3(60.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(l - 0.85, 0.0);
  float soft = k * k / (k + 0.9);
  return c * (soft / max(l, 1e-4)) + c * 0.04;
}
void main(){
  // 13-tap filter (Jimenez, Call of Duty: Advanced Warfare)
  vec2 t = uTexel;
  vec3 a = pre(texture(tColor, vUv + t * vec2(-2.0,  2.0)).rgb);
  vec3 b = pre(texture(tColor, vUv + t * vec2( 0.0,  2.0)).rgb);
  vec3 c = pre(texture(tColor, vUv + t * vec2( 2.0,  2.0)).rgb);
  vec3 d = pre(texture(tColor, vUv + t * vec2(-2.0,  0.0)).rgb);
  vec3 e = pre(texture(tColor, vUv).rgb);
  vec3 f = pre(texture(tColor, vUv + t * vec2( 2.0,  0.0)).rgb);
  vec3 g = pre(texture(tColor, vUv + t * vec2(-2.0, -2.0)).rgb);
  vec3 h = pre(texture(tColor, vUv + t * vec2( 0.0, -2.0)).rgb);
  vec3 i = pre(texture(tColor, vUv + t * vec2( 2.0, -2.0)).rgb);
  vec3 j = pre(texture(tColor, vUv + t * vec2(-1.0,  1.0)).rgb);
  vec3 k = pre(texture(tColor, vUv + t * vec2( 1.0,  1.0)).rgb);
  vec3 l = pre(texture(tColor, vUv + t * vec2(-1.0, -1.0)).rgb);
  vec3 m = pre(texture(tColor, vUv + t * vec2( 1.0, -1.0)).rgb);
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}
`;

const UP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tAdd;
uniform vec2 uTexel;
void main(){
  // 3x3 tent on the coarser level, added to this level
  vec2 t = uTexel * 2.0;
  vec3 s = texture(tColor, vUv).rgb * 4.0;
  s += (texture(tColor, vUv + vec2(t.x, 0.0)).rgb + texture(tColor, vUv - vec2(t.x, 0.0)).rgb + texture(tColor, vUv + vec2(0.0, t.y)).rgb + texture(tColor, vUv - vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(tColor, vUv + t).rgb + texture(tColor, vUv - t).rgb + texture(tColor, vUv + vec2(t.x, -t.y)).rgb + texture(tColor, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(s / 16.0 * 0.92 + texture(tAdd, vUv).rgb, 1.0);
}
`;

const RAYS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec3 uSun;       // uv.xy, facing
uniform float uAspect;
uniform float uFar;
uniform float uTime;
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  if (uSun.z <= 0.0){ gl_FragColor = vec4(0.0); return; }
  vec2 d = uSun.xy - vUv;
  vec2 da = d; da.x *= uAspect;
  float dist = length(da);
  const int N = 28;
  vec2 stepv = d / float(N) * 0.85;
  float j = ign(gl_FragCoord.xy + fract(uTime * 0.37) * 37.0);
  vec2 uv = vUv + stepv * j;
  float acc = 0.0;
  float decay = 1.0;
  for (int i = 0; i < N; i++){
    vec2 q = clamp(uv, 0.0, 1.0);
    float z = texture(tDepth, q).r;
    // only unobstructed sky feeds the shafts
    float sky = step(abs(z - uFar), 1e-6);
    vec3 c = texture(tColor, q).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    acc += sky * min(l, 6.0) * decay;
    decay *= 0.955;
    uv += stepv;
  }
  acc /= float(N);
  float fall = exp(-dist * 1.6);
  gl_FragColor = vec4(vec3(acc * fall * uSun.z), 1.0);
}
`;

const FINAL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform float uExposure, uBloom, uDistort, uFringe, uVignette, uRays, uSat, uContrast, uSpeed, uFade;
uniform vec3 uSunColor;
uniform vec2 uRes;
uniform float uTime;
${TONEMAP}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 lens(vec2 uv, float k){
  // barrel distortion, normalised to the frame diagonal so corners stay put at any aspect ratio
  vec2 c = uv - 0.5;
  float asp = uRes.x / uRes.y;
  vec2 q = c * vec2(asp, 1.0) / (0.5 * sqrt(asp * asp + 1.0));
  float r2 = dot(q, q);
  return 0.5 + c * (1.0 + k * r2) / (1.0 + k);
}
void main(){
  float k = uDistort * (1.0 + 0.6 * uSpeed);
  vec2 uv = lens(vUv, k);
  vec2 c = vUv - 0.5;
  float r = length(c * vec2(uRes.x / uRes.y, 1.0)) / (0.5 * length(vec2(uRes.x / uRes.y, 1.0)));
  // chromatic fringe grows toward the edges and with speed
  vec2 dir = c * uFringe * (0.5 + 1.6 * uSpeed) * (0.25 + r * r * 3.0);
  vec3 col;
  col.r = texture(tColor, lens(vUv + dir, k)).r;
  col.g = texture(tColor, uv).g;
  col.b = texture(tColor, lens(vUv - dir, k)).b;
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  if (uBloom > 0.0) col += texture(tBloom, uv).rgb * uBloom;
  if (uRays > 0.0) col += texture(tRays, uv).rgb * uRays * uSunColor * 0.085;
  col *= uExposure;
  // vignette (natural cos^4-ish falloff)
  float v = 1.0 - uVignette * smoothstep(0.25, 1.15, r) * (0.75 + 0.25 * r);
  col *= v;
  col = acesFilm(col * 0.92);
  // grade: gentle contrast + saturation lift, slightly cool shadows and warm highlights
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  col += (l - 0.5) * vec3(0.012, 0.004, -0.016);
  col = clamp(col, 0.0, 1.0);
  col = toSRGB(col);
  col += (ign(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) / 255.0;   // dither away banding in the sky
  gl_FragColor = vec4(col * uFade, 1.0);
}
`;
