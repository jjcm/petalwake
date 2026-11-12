// The rider: Meshy model with wind-driven secondary motion (cape, bristles, hat, swinging lantern),
// lit by the sun + sky, casting a crisp shadow onto the world through its own small shadow map.
//
// Two poses beyond plain riding, both driven from outside (game/landing.js, game/tricks.js):
//   seat - the seated model lifted, squashed or rolled about the broom (hops, the kickflip);
//   off  - dismounted: a second model of her standing (rider_stand.glb, optional) takes its place.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { U } from '../core/ctx.js';

const SCALE = 1.28;
const SHADOW_SIZE = 1024;
const SHADOW_EXTENT = 3.4; // half-width of the shadow box in metres
const STAND_HEIGHT = 2.05; // boots to hat tip, if the standing model does not say how big it is

export class Rider {
  static async load(renderer, base = './assets/models') {
    const [gltf, info] = await Promise.all([
      new GLTFLoader().loadAsync(`${base}/rider.glb`),
      fetch(`${base}/rider.json`).then((r) => r.json()),
    ]);
    return new Rider(renderer, gltf.scene, info);
  }

  constructor(renderer, model, info) {
    this.renderer = renderer;
    this.group = new THREE.Group();      // world pose
    this.tilt = new THREE.Group();       // local bob / lean
    this.group.add(this.tilt);
    this.tilt.add(model);
    model.scale.setScalar(SCALE);
    this.model = model;
    this.uniforms = {
      uRiderTime: { value: 0 },
      uRiderWind: { value: 1 },
      uLanternPivot: { value: new THREE.Vector3().fromArray(info.lanternPivot) },
      uLantern: { value: new THREE.Vector2() },
    };
    this.lantern = { ax: 0, az: 0, vx: 0, vz: 0 };
    // seated model: lift (m), squash (1 = none), roll about the broom (rad), calm (1 stills the hover bob)
    this.seat = { hop: 0, sy: 1, flip: 0, calm: 0 };
    // dismounted: show the standing model with its feet at y (m, in the rider's frame), squashed by sy
    this.off = { on: false, y: 0, sy: 1 };
    this.standing = null;                // { root, model, height } once the standing model is in
    this.meshes = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      this.meshes.push(o);
      o.frustumCulled = false;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      m.envMapIntensity = 1.0;
      m.normalScale?.set(1, 1);
      if (m.map) m.map.anisotropy = 8;
      this._patch(m, !!o.geometry.attributes._wind);
    });
    this._outline = this._measure(model);

    // ---- lights for the sharp layer (three's units: irradiance, so pi x our radiance-style sun)
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.012;
    const sc = this.sun.shadow.camera;
    sc.left = -3.4; sc.right = 3.4; sc.top = 3.4; sc.bottom = -3.4; sc.near = 0.5; sc.far = 18;
    this.fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.lights = new THREE.Group();
    this.lights.add(this.sun, this.sun.target, this.fill);
    this.sunVis = 1;

    // ---- shadow map for the world shaders (depth from the sun's point of view)
    const depth = new THREE.DepthTexture(SHADOW_SIZE, SHADOW_SIZE, THREE.FloatType);
    depth.minFilter = depth.magFilter = THREE.LinearFilter;
    this.shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { depthTexture: depth, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.shadowCam = new THREE.OrthographicCamera(-SHADOW_EXTENT, SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, 1, 60);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.shadowScene = new THREE.Scene();
    U.uShadowTex.value = depth;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  _patch(mat, hasWind, u = this.uniforms) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      if (!hasWind) return;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`#include <common>
          attribute vec4 _wind;       // cape, bristles, hat, lantern
          uniform float uRiderTime;
          uniform float uRiderWind;
          uniform vec3 uLanternPivot;
          uniform vec2 uLantern;
        `)
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          {
            float t = uRiderTime, sp = uRiderWind;
            // cape: ripples run down the cloth and the hem lifts into the slipstream
            float ph = position.z * 10.0 + position.x * 6.0 - t * 15.0;
            transformed += vec3(sin(ph * 0.83 + 1.3) * 0.022, sin(ph) * 0.034 + 0.030, 0.030 + 0.020 * sin(ph * 0.5)) * _wind.r * sp;
            // bristles: a fine shiver plus a slow sway of the whole head
            float bp = position.x * 43.0 + position.y * 37.0 - t * 33.0;
            transformed.xy += vec2(sin(bp), cos(bp * 1.31)) * 0.011 * _wind.g * sp;
            transformed.y += sin(t * 8.3 + position.z * 5.0) * 0.016 * _wind.g * sp;
            transformed.x += sin(t * 6.1 + position.z * 4.0) * 0.012 * _wind.g * sp;
            // hat: the crown is pushed back and its tip whips; the brim flutters
            transformed.z += (0.040 + sin(t * 11.0 + position.x * 9.0) * 0.012) * _wind.b * sp;
            transformed.x += sin(t * 7.3 + position.y * 6.0) * 0.018 * _wind.b * sp;
            transformed.y += sin(t * 13.0 + position.x * 14.0 + position.z * 9.0) * 0.010 * _wind.b * sp;
            // lantern: rigid pendulum on its hook
            vec3 lp = transformed - uLanternPivot;
            float cx = cos(uLantern.x), sx = sin(uLantern.x), cz = cos(uLantern.y), sz = sin(uLantern.y);
            lp = vec3(lp.x * cz - lp.y * sz, lp.x * sz + lp.y * cz, lp.z);
            lp = vec3(lp.x, lp.y * cx - lp.z * sx, lp.y * sx + lp.z * cx);
            transformed = mix(transformed, uLanternPivot + lp, _wind.a);
          }
        `);
    };
    mat.customProgramCacheKey = () => `rider-${hasWind}`;
    mat.needsUpdate = true;
  }

  /** A thinned-out copy of the model's points (y, z in the rider's frame), for restHeight(). */
  _measure(model) {
    model.updateMatrixWorld(true);
    const out = [], v = new THREE.Vector3();
    model.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 24000));
      for (let i = 0; i < p.count; i += step) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        out.push(v.y, v.z);
      }
    });
    return new Float32Array(out);
  }

  /**
   * How high the middle of the broom is when it has been set down nose-up at `pitch` radians:
   * the height that puts the lowest part of rider and broom (boots, bristles) on the floor.
   */
  restHeight(pitch) {
    const c = Math.cos(pitch), s = Math.sin(pitch), a = this._outline;
    let min = Infinity;
    for (let i = 0; i < a.length; i += 2) { const y = a[i] * c - a[i + 1] * s; if (y < min) min = y; }
    return -min;
  }

  /**
   * The same character on her feet, for when she has landed. Optional: without it she stays on
   * the broom and sets it down. Same conventions as rider.glb (one mesh, _wind weights, facing
   * -z) except that the origin is on the floor between her boots.
   */
  async loadStand(base = './assets/models', name = 'rider_stand') {
    const [gltf, info] = await Promise.all([
      new GLTFLoader().loadAsync(`${base}/${name}.glb`),
      fetch(`${base}/${name}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    return this.setStand(gltf.scene, info);
  }

  setStand(model, info = {}) {
    if (this.standing) this.group.remove(this.standing.root);
    const root = new THREE.Group();
    // (rider_stand.json keeps the seated model's units, and its "scale" is a record of how it got them)
    model.scale.setScalar(typeof info.scale === 'number' ? info.scale : SCALE);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    let height = box.max.y - box.min.y;
    // a model that did not keep to the seated one's scale is brought to a sensible height
    if (!(height > 1.3 && height < 2.9)) {
      model.scale.multiplyScalar(STAND_HEIGHT / height);
      model.updateMatrixWorld(true);
      box.setFromObject(model);
      height = box.max.y - box.min.y;
    }
    model.position.y -= box.min.y;        // boots on the floor, wherever the origin was left
    root.add(model);
    root.visible = false;
    const u = {
      uRiderTime: this.uniforms.uRiderTime,
      uRiderWind: { value: 0.5 },
      uLanternPivot: { value: new THREE.Vector3().fromArray(info.lanternPivot || [0, 1e3, 0]) },
      uLantern: { value: new THREE.Vector2() },
    };
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      m.envMapIntensity = 1.0;
      m.normalScale?.set(1, 1);
      if (m.map) m.map.anisotropy = 8;
      this._patch(m, !!o.geometry.attributes._wind, u);
    });
    this.group.add(root);
    this.standing = { root, model, height, uniforms: u };
    return this.standing;
  }

  /** @param flight Flight state. */
  update(dt, time, flight, terrain) {
    const g = this.group;
    g.position.copy(flight.pos);
    g.rotation.order = 'YXZ';
    g.rotation.set(flight.pitch, -flight.yaw, -flight.roll);
    // hover: a slow bob and a breath of sway, more nervous at speed
    const sk = Math.min(flight.speed / 33, 2);
    const st = this.seat, live = 1 - st.calm;
    this.tilt.position.y = (Math.sin(time * 1.9) * 0.05 + Math.sin(time * 5.3) * 0.012 * sk) * live + st.hop;
    this.tilt.rotation.z = (Math.sin(time * 1.3) * 0.022 + Math.sin(time * 7.1) * 0.006 * sk) * live + st.flip;
    // (and a nod with the landing bounce: nose down as she sinks into it, up as she springs back)
    this.tilt.rotation.x = Math.sin(time * 1.1 + 1) * 0.016 * live - flight.pitchRate * 0.05 + Math.max(-0.12, Math.min(0.12, flight.bobV * 0.035));
    this.tilt.rotation.y = -flight.turnRate * 0.07;
    // squash and stretch keep her volume: what she loses in height she gains in girth
    const wide = st.sy === 1 ? 1 : 1 / Math.sqrt(st.sy);
    this.tilt.scale.set(wide, st.sy, wide);

    // on her feet: the standing model takes the seated one's place
    const S = this.standing, o = this.off;
    if (S) {
      const on = o.on;
      S.root.visible = on;
      this.tilt.visible = !on;
      if (on) {
        // a little life while she waits: breathing, and a slow shift of her weight
        const sy = o.sy * (1 + 0.006 * Math.sin(time * 1.7)), w = 1 / Math.sqrt(sy);
        S.root.position.set(0, o.y, 0);
        S.root.scale.set(w, sy, w);
        S.root.rotation.set(Math.sin(time * 0.53 + 0.4) * 0.008, 0, Math.sin(time * 0.71) * 0.012);
        S.uniforms.uRiderWind.value = 0.42 + 0.22 * Math.sin(time * 0.6) * Math.sin(time * 0.23 + 1.0);
        S.uniforms.uLantern.value.set(Math.sin(time * 1.3) * 0.05, Math.sin(time * 1.1 + 0.7) * 0.04);
      }
    } else this.tilt.visible = true;

    this.uniforms.uRiderTime.value = time;
    this.uniforms.uRiderWind.value = 0.35 + 0.65 * sk + flight.boosting * 0.6;

    // ---- lantern pendulum in the rider's frame: gravity + inertial forces
    const L = this.lantern;
    const ax = flight.accel;
    // local accelerations (forward / right) felt by the lantern
    const fwdA = (ax.x * flight.fwd.x + ax.y * flight.fwd.y + ax.z * flight.fwd.z);
    const rightX = Math.cos(flight.yaw), rightZ = Math.sin(flight.yaw);
    const latA = ax.x * rightX + ax.z * rightZ + flight.turnRate * flight.speed * 0.25;
    const drag = flight.speed * 0.010; // the slipstream pushes it back
    const gx = 9.8 * Math.sin(flight.pitch) + fwdA * 0.25 - drag * 9.8;
    const gz = 9.8 * Math.sin(flight.roll) * 0.6 - latA * 0.12;
    const len = 0.22;
    L.vx += (-(9.8 / len) * Math.sin(L.ax) * 0.25 + gx * 1.6 - L.vx * 2.6) * dt;
    L.vz += (-(9.8 / len) * Math.sin(L.az) * 0.25 + gz * 1.6 - L.vz * 2.6) * dt;
    L.ax = THREE.MathUtils.clamp(L.ax + L.vx * dt, -1.1, 1.1);
    L.az = THREE.MathUtils.clamp(L.az + L.vz * dt, -0.9, 0.9);
    this.uniforms.uLantern.value.set(L.ax + Math.sin(time * 3.1) * 0.03, L.az + Math.sin(time * 2.3) * 0.03);

    // ---- sun: is the rider in the shade of the land?
    const s = U.uSunDir.value;
    const hit = terrain.raycast(flight.pos.x, flight.pos.y + 0.5, flight.pos.z, s.x, s.y, s.z, 900, 5);
    this.sunVis += ((hit < 0 ? 1 : 0.06) - this.sunVis) * Math.min(1, dt * 6);
    const sc = U.uSunColor.value;
    this.sun.color.setRGB(sc.x, sc.y, sc.z);
    this.sun.intensity = Math.PI * this.sunVis;
    this.sun.position.copy(flight.pos).addScaledVector(s, 7);
    this.sun.target.position.copy(flight.pos);
    const sky = U.uAmbSky.value, gr = U.uAmbGround.value;
    this.fill.color.setRGB(sky.x, sky.y, sky.z);
    this.fill.groundColor.setRGB(gr.x * 1.6, gr.y * 1.6, gr.z * 1.6);
    this.fill.intensity = Math.PI * 0.55;
  }

  /** Render the active rider/mount's depth from the sun and publish the matrix the world shaders use. */
  renderShadow(reversed, subject = this.group, extent = SHADOW_EXTENT, onBefore, onAfter) {
    const cam = this.shadowCam, s = U.uSunDir.value, p = subject.position;
    if (cam.right !== extent) {
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }
    cam.position.copy(p).addScaledVector(s, 30);
    cam.up.set(0, 1, 0);
    cam.lookAt(p);
    cam.updateMatrixWorld();
    const r = this.renderer;
    const parent = subject.parent;
    const wasVis = subject.visible;
    subject.visible = true;
    onBefore?.();
    this.shadowScene.add(subject);
    this.shadowScene.overrideMaterial = this.depthMat;
    const prev = r.shadowMap.enabled;
    r.shadowMap.enabled = false;
    r.setRenderTarget(this.shadowRT);
    r.render(this.shadowScene, cam);
    r.setRenderTarget(null);
    r.shadowMap.enabled = prev;
    this.shadowScene.overrideMaterial = null;
    onAfter?.();
    subject.visible = wasVis;
    if (parent) parent.add(subject);
    // world -> shadow uv + standard depth (0 near .. 1 far), independent of the depth convention
    const view = cam.matrixWorldInverse;
    const e = extent, n = cam.near, f = cam.far;
    const proj = this._m.set(
      0.5 / e, 0, 0, 0.5,
      0, 0.5 / e, 0, 0.5,
      0, 0, -1 / (f - n), -n / (f - n),
      0, 0, 0, 1,
    );
    U.uShadowMat.value.multiplyMatrices(proj, view);
    U.uShadowOn.value = reversed ? 2 : 1;
  }
}
