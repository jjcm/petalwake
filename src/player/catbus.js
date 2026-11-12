// Rideable Catbus: asset loader (keyed to walk / sprint / fly / takeoff / land), mount & dismount,
// ground locomotion blending walk-to-sprint by speed, takeoff -> fly -> land state machine,
// terrain & town collision, secondary motion (brass lantern, roof rail & bells), and fur updates.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { U, World, shared } from '../core/ctx.js';
import { SPEEDS } from './flight.js';
import { buildPlaceholderCatbus, prepareCatbusAsset, CLIP_NAMES } from './catbus_model.js';
import { probeLandingSurface, findLandingSpot } from '../game/surface.js';
import { puff, dustRing, twinkle, GOLD, PALE } from '../game/sparks.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const turnAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const CATBUS = {
  MOUNT_RANGE: 18,      // m: direct mount range when near the catbus
  WALK_SPEED: 11.5,     // m/s (~41 km/h)
  SPRINT_SPEED: 26.5,   // m/s (~95 km/h)
  REVERSE_SPEED: 4.2,   // m/s
  BODY_R: 1.32,         // m: horizontal collision radius against walls & props
  STEP_UP: 0.92,        // m: max ledge/step height climbed smoothly on ground/roofs
  FLY_CLEAR: 1.45,      // m: low-skim paw clearance when flying without landing
  TAKEOFF_DUR: 0.66,    // s: crouch-and-leap transition from ground to fly
};

const RING12 = (() => {
  const a = [];
  for (let i = 0; i < 12; i++) a.push(Math.sin((i * Math.PI) / 6), -Math.cos((i * Math.PI) / 6));
  return a;
})();

export class Catbus {
  /**
   * Load `./assets/models/catbus.glb` (+ optional `catbus.json` sidecar) if present;
   * otherwise build the rigged procedural ginger-tabby stagecoach placeholder with the same
   * walk / sprint / fly / takeoff / land AnimationClips so the final GLB drops straight in.
   */
  static async load(renderer, base = './assets/models', name = 'catbus') {
    const params = new URLSearchParams(location.search);
    const customUrl = params.get('catbus');
    const glbUrl = customUrl || `${base}/${name}.glb`;
    const jsonUrl = customUrl ? customUrl.replace(/\.glb$/i, '.json') : `${base}/${name}.json`;

    let gltf = null;
    let info = {};
    let isPlaceholder = false;

    try {
      let exists = true;
      if (!customUrl && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
        const list = await fetch(`${base}/`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        if (list && !list.includes(`${name}.glb`)) exists = false;
      } else if (!customUrl) {
        const head = await fetch(glbUrl, { method: 'HEAD' }).catch(() => null);
        if (!head || !head.ok) exists = false;
      }
      if (exists) {
        const loader = new GLTFLoader();
        if (MeshoptDecoder) loader.setMeshoptDecoder(MeshoptDecoder);
        [gltf, info] = await Promise.all([
          loader.loadAsync(glbUrl),
          fetch(jsonUrl).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ]);
      }
    } catch (e) {
      console.warn('catbus: falling back to placeholder rig', e);
      gltf = null;
    }

    if (!gltf) {
      gltf = buildPlaceholderCatbus();
      isPlaceholder = true;
    }

    return new Catbus(renderer, gltf, info, isPlaceholder);
  }

  constructor(renderer, gltf, info = {}, isPlaceholder = false) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'Catbus';
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);

    // State machine: 'ground' | 'takeoff' | 'fly' | 'land'
    this.state = 'ground';
    this.mounted = false;
    this.stateT = 0;

    // Kinematics
    this.pos = new THREE.Vector3(0, 20, 0);
    this.vel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
    this.accel = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.turnRate = 0;
    this.pitchRate = 0;
    this.groundSpeed = 0;
    this.airSpeed = SPEEDS.CRUISE;
    this.vy = 0;
    this.grounded = true;
    this.boosting = 0;
    this.flare = 0;
    this.bob = 0;
    this.bobV = 0;
    this.bump = 0;
    this.touchdown = 0;
    this.holdAgl = -1;
    this.sunVis = 1;
    this.gaitPhase = 0;
    this._pawDustAcc = 0;

    // Secondary motion state (lantern 2-axis pendulum + roof bells)
    this.lantern = { ax: 0, az: 0, vx: 0, vz: 0 };
    this.bellEnergy = 0;

    // Landing / summoning helpers
    this.landData = null;
    this.summon = null;
    this.pendingDismount = false;
    this._n = new THREE.Vector3();
    this._wn = new THREE.Vector3();
    this._sn = new THREE.Vector3();

    // Flight.auto hook: while mounted, Flight delegates pos/vel/angles to Catbus
    this.autoHook = {
      step: (dt, time, flight) => this._syncToFlight(dt, time, flight),
      quiet: false,
      keepBoost: true,
    };

    // Subtle warm beacon glint over the parked catbus so the player can spot it from the air
    this._buildParkedMarker();
    // Soft contact ground shadow disc underneath the paws when parked away from the witch
    this._buildContactShadow();

    this._installAsset(gltf, info, isPlaceholder);
  }

  _installAsset(gltf, info = {}, isPlaceholder = false) {
    if (this.rig) {
      this.rig.fur?.dispose();
      this.tilt.remove(this.rig.root);
    }
    this.mixer?.stopAllAction();

    const rig = prepareCatbusAsset(gltf, info, isPlaceholder);
    this.rig = rig;
    this.isPlaceholder = isPlaceholder;
    this.tilt.add(rig.root);

    this.mixer = new THREE.AnimationMixer(rig.model);
    this.actions = {};
    for (const name of CLIP_NAMES) {
      const clip = rig.clips[name];
      if (!clip) continue;
      const act = this.mixer.clipAction(clip);
      if (name === 'takeoff' || name === 'land') {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      } else {
        act.setLoop(THREE.LoopRepeat, Infinity);
      }
      this.actions[name] = act;
    }

    // Optional idle clip if present in an external GLB
    const idleClip = (gltf.animations || []).find((c) => /^idle\b/i.test(c.name));
    if (idleClip) {
      const act = this.mixer.clipAction(idleClip);
      act.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.idle = act;
    }

    // Start walk & sprint ready for continuous weight blending on the ground
    if (this.actions.walk) { this.actions.walk.enabled = true; this.actions.walk.setEffectiveWeight(0); this.actions.walk.play(); }
    if (this.actions.sprint && this.actions.sprint !== this.actions.walk) {
      this.actions.sprint.enabled = true; this.actions.sprint.setEffectiveWeight(0); this.actions.sprint.play();
    }
    if (this.actions.idle) { this.actions.idle.enabled = true; this.actions.idle.setEffectiveWeight(1); this.actions.idle.play(); }
    this._activeAirAction = null;
  }

  /** Hot-swap a new rigged GLB at runtime (e.g. from console or follow-up asset drop). */
  async loadGLB(url, info = {}) {
    const loader = new GLTFLoader();
    if (MeshoptDecoder) loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    this._installAsset(gltf, info, false);
    if (this.state === 'fly') this._enterFlyAnim(0.1);
    return { clips: Object.keys(this.actions), size: this.rig.size.toArray().map((v) => +v.toFixed(2)) };
  }

  _buildParkedMarker() {
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    this.uBeacon = { value: new THREE.Vector4(0, 0, 0, 1) };
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...shared('uTime', 'uCamPos'), uBeacon: this.uBeacon },
      vertexShader: /* glsl */`
        precision highp float;
        uniform vec4 uBeacon;
        uniform float uTime;
        varying vec2 vUv;
        varying float vShow;
        void main() {
          vec3 c = uBeacon.xyz + vec3(0.0, 3.6 + 0.25 * sin(uTime * 2.1), 0.0);
          vec4 mv = viewMatrix * vec4(c, 1.0);
          float d = -mv.z;
          mv.xy += position.xy * 0.72 * (1.0 + min(d, 600.0) * 0.008);
          vUv = position.xy;
          vShow = uBeacon.w * smoothstep(12.0, 34.0, d) * (1.0 - smoothstep(280.0, 520.0, d));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying float vShow;
        void main() {
          float r = length(vUv);
          float v = (exp(-r * r * 36.0) * 1.8 + exp(-r * r * 5.5) * 0.35) * vShow * (1.0 - smoothstep(0.75, 1.0, r));
          vec3 col = vec3(1.0, 0.72, 0.28);
          gl_FragColor = vec4(col * v, v * 0.5);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.beaconMesh = new THREE.Mesh(g, mat);
    this.beaconMesh.frustumCulled = false;
    this.beaconMesh.renderOrder = 49;
  }

  _buildContactShadow() {
    const g = new THREE.PlaneGeometry(3.2, 5.6);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.42 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform float uOpacity;
        void main() {
          float d = length(vUv * vec2(1.05, 0.92));
          float a = smoothstep(1.0, 0.22, d) * uOpacity;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.contactShadow = new THREE.Mesh(g, mat);
    this.contactShadow.position.y = 0.04;
    this.contactShadow.renderOrder = 20;
    this.group.add(this.contactShadow);
  }

  /** Place the catbus at a flat dry spot near (x, z), searching outward if needed. */
  placeInitial(game, hintX, hintZ, yawDeg = 140) {
    this.game = game;
    let spot = probeLandingSurface(game, hintX, hintZ, { radius: 1.5, maxGroundSlope: 0.35 });
    if (!spot) {
      for (let r = 8; r <= 180 && !spot; r += 10) {
        for (let k = 0; k < 16 && !spot; k++) {
          const a = (k / 16) * Math.PI * 2;
          const s = probeLandingSurface(game, hintX + Math.cos(a) * r, hintZ + Math.sin(a) * r, { radius: 1.5, maxGroundSlope: 0.35 });
          if (s && s.kind === 'ground') spot = s;
        }
      }
    }
    const x = spot ? spot.x : hintX;
    const z = spot ? spot.z : hintZ;
    const y = spot ? spot.y : Math.max(game.terrain.heightAt(x, z), 0.5);
    this.pos.set(x, y, z);
    this.yaw = (yawDeg * Math.PI) / 180;
    this.pitch = 0;
    this.roll = 0;
    this.groundSpeed = 0;
    this.vel.set(0, 0, 0);
    this.state = 'ground';
    this.grounded = true;
    this._updateFwd();
    this._syncGroup(0);
  }

  distanceTo(p) {
    return this.pos.distanceTo(p);
  }

  // ---------------------------------------------------------------------------------------------
  // Mount, Summon, and Dismount
  // ---------------------------------------------------------------------------------------------
  mount(game = this.game) {
    if (this.mounted) return true;
    const f = game.flight, L = game.gameplay?.landing;
    const oldPos = _tmpOld.copy(f.pos);
    if (L && L.busy) L.abort();
    if (game.gameplay?.trick?.active) game.gameplay.trick.t = -1;

    this.summon = null;
    this.pendingDismount = false;
    this.mounted = true;
    this.mountHopT = 0;
    this.mountHopFrom = oldPos.clone();
    this.dismountHop = null;
    this.bellEnergy = Math.min(1.5, this.bellEnergy + 0.9);

    // Sync Flight onto the catbus while preserving smooth camera continuity via chase._tOff!
    const newPos = _tmpNew.set(this.pos.x, this.pos.y + 1.35, this.pos.z);
    if (game.chase && oldPos.distanceTo(newPos) < 25) {
      game.chase._tOff.add(oldPos).sub(newPos);
      game.chase.targetOffset.set(0, 0, 0);
    }
    f.pos.copy(newPos);
    f.vel.copy(this.vel);
    f.yaw = this.yaw;
    f.pitch = this.pitch;
    f.roll = this.roll;
    f.speed = this.vel.length();
    f.auto = this.autoHook;

    // Show the witch hopping aboard over 0.30s before tucking inside the stagecoach cabin!
    game.rider.group.visible = true;
    game.chase.vehicleScale = 1.48;
    game.chase.release(0.75);

    const sun = game.fx.sunTint(this.sunVis);
    puff(game.fx, this.pos.x, this.pos.y + 1.4, this.pos.z, 16, sun, 0.7, 2.0);
    twinkle(game.fx, this.pos.x, this.pos.y + 1.6, this.pos.z, 14, GOLD, 2.8, 0, 0.6, 0, 0.8);
    this._jingle(game, 0.85);
    return true;
  }

  /** Summon the catbus to bound up right beside the witch; `autoMount` hops her aboard on arrival. */
  callToPlayer(game = this.game, autoMount = false) {
    if (this.mounted) return false;
    const f = game.flight;
    const spot = findLandingSpot(game, f.pos, new THREE.Vector3(Math.sin(f.yaw) * 4, 0, -Math.cos(f.yaw) * 4), f.yaw, {
      radius: 1.35,
      maxAgl: 22,
      maxClimb: 7,
      minLead: 2.8,
      maxLead: 5.5,
      searchRadius: 10,
    });
    if (!spot) {
      game.toast?.('need a little more flat room for the catbus');
      return false;
    }
    const back = 15;
    const approachYaw = f.yaw;
    const sx = spot.x - Math.sin(approachYaw) * back;
    const sz = spot.z + Math.cos(approachYaw) * back;
    const sy = this._supportAt(game, sx, sz, spot.y + 4);
    this.summon = {
      t: 0,
      dur: 0.72,
      x0: sx, y0: sy, z0: sz,
      x1: spot.x, y1: spot.y, z1: spot.z,
      yaw: approachYaw,
      kind: spot.kind,
      autoMount,
    };
    this.state = 'ground';
    this._jingle(game, 0.7);
    return true;
  }

  /** Dismount onto the ground/roof beside the cabin door, or land first if skimming low. */
  dismount(game = this.game) {
    if (!this.mounted) return false;
    if (this.state === 'fly' || this.state === 'takeoff') {
      const cover = this._supportAt(game, this.pos.x, this.pos.z, this.pos.y);
      if (this.pos.y - cover < 9.5) {
        if (this.tryBeginLand(game)) {
          this.pendingDismount = true;
          return true;
        }
      }
      game.toast?.('land first (Space twice) to step off');
      return false;
    }
    if (this.state === 'land') {
      this.pendingDismount = true;
      return true;
    }

    // Dismount right beside the stagecoach's left or right cabin doorway
    const oldAnchor = _tmpOld.set(this.pos.x, this.pos.y + 1.35, this.pos.z);
    this.mounted = false;
    this.mountHopT = -1;
    this.pendingDismount = false;
    this.groundSpeed *= 0.25;
    this.bellEnergy = Math.min(1.5, this.bellEnergy + 0.7);

    const f = game.flight;
    if (f.auto === this.autoHook) f.auto = null;
    game.rider.group.visible = true;
    game.chase.vehicleScale = 1.0;

    // Pick whichever side of the cabin has solid flat footing
    const rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
    let outSpot = null;
    for (const side of [-1, 1]) {
      const cand = probeLandingSurface(game, this.pos.x + rx * side * 2.1, this.pos.z + rz * side * 2.1, { radius: 0.75 });
      if (cand && Math.abs(cand.y - this.pos.y) < 1.8) { outSpot = cand; break; }
    }
    const dx = outSpot ? outSpot.x : this.pos.x + rx * -1.8;
    const dz = outSpot ? outSpot.z : this.pos.z + rz * -1.8;
    const dy = outSpot ? outSpot.y : this.pos.y;

    const L = game.gameplay?.landing;
    if (L) {
      L.placeLanded(dx, dy, dz, this.yaw, outSpot?.kind || 'ground');
    } else {
      f.place(dx, dz, 1.2, (this.yaw * 180) / Math.PI);
    }
    this.dismountHop = {
      t: 0,
      dur: 0.36,
      from: oldAnchor.clone(),
      to: f.pos.clone(),
    };
    if (game.chase) {
      game.chase._tOff.add(oldAnchor).sub(f.pos);
      game.chase.targetOffset.set(0, 0, 0);
    }

    const sun = game.fx.sunTint(this.sunVis);
    puff(game.fx, dx, dy + 1.1, dz, 12, sun, 0.45, 1.6);
    dustRing(game.fx, dx, dy, dz, 0.35, 14, sun);
    this._jingle(game, 0.65);
    return true;
  }

  _jingle(game, amp = 0.7) {
    const snd = game?.sound;
    if (!snd || !snd.ctx || snd.muted) return;
    const t0 = snd.ctx.currentTime + 0.01;
    snd._bell?.(1318.5, t0, 0.045 * amp, 0.45);
    snd._bell?.(1568.0, t0 + 0.055, 0.038 * amp, 0.55);
    snd._bell?.(1975.5, t0 + 0.11, 0.028 * amp, 0.45);
  }

  // ---------------------------------------------------------------------------------------------
  // Animation state transitions
  // ---------------------------------------------------------------------------------------------
  _fadeToAirAction(name, fadeSec = 0.18) {
    const next = this.actions[name];
    if (!next) return;
    if (this._activeAirAction && this._activeAirAction !== next) {
      this._activeAirAction.fadeOut(fadeSec);
    }
    if (this.actions.walk && name !== 'walk') this.actions.walk.setEffectiveWeight(0);
    if (this.actions.sprint && this.actions.sprint !== this.actions.walk && name !== 'sprint') this.actions.sprint.setEffectiveWeight(0);
    if (this.actions.idle) this.actions.idle.setEffectiveWeight(0);

    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.fadeIn(fadeSec);
    next.play();
    this._activeAirAction = next;
  }

  _enterFlyAnim(fadeSec = 0.24) {
    this._fadeToAirAction('fly', fadeSec);
  }

  _returnToGroundAnims(fadeSec = 0.20) {
    if (this._activeAirAction) {
      this._activeAirAction.fadeOut(fadeSec);
      this._activeAirAction = null;
    }
    if (this.actions.walk) { this.actions.walk.enabled = true; this.actions.walk.play(); }
    if (this.actions.sprint && this.actions.sprint !== this.actions.walk) {
      this.actions.sprint.enabled = true; this.actions.sprint.play();
    }
    if (this.actions.idle) { this.actions.idle.enabled = true; this.actions.idle.play(); }
  }

  // ---------------------------------------------------------------------------------------------
  // State transitions: takeoff, fly, land
  // ---------------------------------------------------------------------------------------------
  beginTakeoff(game = this.game) {
    if (this.state !== 'ground') return false;
    this.state = 'takeoff';
    this.stateT = 0;
    this._takeoffLeapt = false;
    this.bellEnergy = Math.min(1.6, this.bellEnergy + 1.1);
    this._fadeToAirAction('takeoff', 0.12);
    return true;
  }

  tryBeginLand(game = this.game) {
    if (this.state !== 'fly' && this.state !== 'takeoff') return false;
    const spot = findLandingSpot(game, this.pos, this.vel, this.yaw, {
      radius: 1.32,
      maxAgl: 28,
      maxClimb: 6.0,
      leadTime: 0.36,
      maxLead: 10.5,
      searchRadius: 7.5,
    });
    if (!spot) {
      const th = game.terrain.heightAt(this.pos.x, this.pos.z);
      if (th < 0.4) game.toast?.('only open water below');
      else if (this.pos.y - th > 28) game.toast?.('come lower to set down');
      else game.toast?.('nowhere flat enough for the catbus here');
      return false;
    }

    const dx = spot.x - this.pos.x, dz = spot.z - this.pos.z;
    const hd = Math.hypot(dx, dz);
    const vd = Math.abs(spot.y - this.pos.y);
    const dist = Math.hypot(hd, vd);
    const dur = clamp(0.42 + dist * 0.028, 0.44, 1.05);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    const along = hd > 0.2 ? (this.vel.x * dx + this.vel.z * dz) / hd : hs;
    const tanMag = clamp(Math.max(0, along) * dur * 0.55, 0, Math.min(hd * 1.15, 13));
    const tx = hs > 0.5 ? (this.vel.x / hs) * 0.6 + (hd > 0.2 ? (dx / hd) * 0.4 : 0) : Math.sin(this.yaw);
    const tz = hs > 0.5 ? (this.vel.z / hs) * 0.6 + (hd > 0.2 ? (dz / hd) * 0.4 : 0) : -Math.cos(this.yaw);
    const tl = Math.hypot(tx, tz) || 1;

    this.landData = {
      spot,
      dur,
      x0: this.pos.x, y0: this.pos.y, z0: this.pos.z,
      tanX: (tx / tl) * tanMag,
      tanZ: (tz / tl) * tanMag,
      vy0: clamp(this.vel.y, -14, 8),
      yaw0: this.yaw,
      entrySpeed: hs,
      landAnimStarted: false,
    };
    this.state = 'land';
    this.stateT = 0;
    game.sound?.whoosh?.(0.45);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Surface & Collision Helpers
  // ---------------------------------------------------------------------------------------------
  _supportAt(game, x, z, refY) {
    const T = game.terrain, f = game.flight;
    let h = T.heightAt(x, z);
    if (f?.river) {
      const r = f.river.levelAt(x, z);
      if (r > h) h = r;
    }
    const S = f?.solid || game.town;
    if (S) {
      const sh = S.heightAt(x, z);
      if (sh > -1e8 && sh <= refY + CATBUS.STEP_UP) {
        if (sh > h) h = sh;
      }
    }
    return h;
  }

  _collideGround(game, dt) {
    const T = game.terrain, f = game.flight, S = f?.solid || game.town;
    const p = this.pos, R = CATBUS.BODY_R;

    // 1. Building walls taller than STEP_UP above our feet
    if (S) {
      const yWall = p.y + CATBUS.STEP_UP;
      let sx = 0, sz = 0, touch = 0;
      for (let i = 0; i < 12; i++) {
        const cx = RING12[i * 2], cz = RING12[i * 2 + 1];
        if (S.heightAt(p.x + cx * R, p.z + cz * R) > yWall) { sx -= cx; sz -= cz; touch++; }
      }
      if (touch) {
        const l = Math.hypot(sx, sz) || 1;
        sx /= l; sz /= l;
        for (let k = 0; k < 40; k++) {
          p.x += sx * 0.08; p.z += sz * 0.08;
          let clear = S.heightAt(p.x, p.z) <= yWall;
          for (let i = 0; i < 12 && clear; i++) {
            if (S.heightAt(p.x + RING12[i * 2] * R, p.z + RING12[i * 2 + 1] * R) > yWall) clear = false;
          }
          if (clear) break;
        }
        this._slideWall(sx, sz, dt);
      }
    }

    // 2. Steep natural cliff walls
    const onRoof = S && S.heightAt(p.x, p.z) > T.heightAt(p.x, p.z) + 0.25 && S.heightAt(p.x, p.z) <= p.y + CATBUS.STEP_UP;
    if (!onRoof) {
      const n = T.normalAt(p.x, p.z, this._n, 2.2);
      if (n.y < 0.62 && T.heightAt(p.x, p.z) > 0.4) {
        const nl = Math.hypot(n.x, n.z) || 1;
        const nx = n.x / nl, nz = n.z / nl;
        p.x += nx * 6 * dt; p.z += nz * 6 * dt;
        this._slideWall(nx, nz, dt);
      }
    }

    // 3. Props (trees, boulders, standing stones, hidden places)
    if (f?.props) {
      const testPos = this._wn.set(p.x, p.y + 1.0, p.z);
      if (f.props.collide(testPos, R, this._sn)) {
        p.x = testPos.x; p.z = testPos.z;
        this._slideWall(this._sn.x, this._sn.z, dt);
      }
    }

    // 4. Deep water shoreline guard while running on ground (unless on a quay/bridge roof)
    if (!onRoof) {
      const rw = f?.river ? f.river.levelAt(p.x, p.z) : -1e9;
      const th = T.heightAt(p.x, p.z);
      if (th < -0.25 || rw > th + 0.45) {
        // Step back toward higher ground
        const n = T.normalAt(p.x, p.z, this._n, 3.0);
        const nl = Math.hypot(-n.x, -n.z) || 1;
        p.x += (-n.x / nl) * Math.max(4, Math.abs(this.groundSpeed)) * dt;
        p.z += (-n.z / nl) * Math.max(4, Math.abs(this.groundSpeed)) * dt;
        this.groundSpeed *= Math.exp(-dt * 8);
      }
    }
  }

  _slideWall(nx, nz, dt) {
    const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const d = fx * nx + fz * nz;
    if (d < 0) {
      const rx = fx - 1.3 * d * nx, rz = fz - 1.3 * d * nz;
      const dy = turnAngle(Math.atan2(rx, -rz) - this.yaw);
      this.yaw += dy * Math.min(1, dt * 12);
      this.groundSpeed *= 1 - 0.25 * (-d) * Math.min(1, dt * 10);
      this.bump = Math.max(this.bump, -d * 0.4);
    }
  }

  _updateFwd() {
    const cp = Math.cos(this.pitch);
    this.fwd.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  // ---------------------------------------------------------------------------------------------
  // Per-frame Simulation Update
  // ---------------------------------------------------------------------------------------------
  update(dt, time, game, ctl, taps = {}) {
    this.game = game;
    this.stateT += dt;
    this.prevVel.copy(this.vel);

    // Handle summon bound-in animation when called from afar
    if (this.summon) {
      this._stepSummon(dt, game);
      this._stepVisuals(dt, time, game);
      return;
    }

    if (this.mounted && game.state === 'play') {
      if (this.state === 'ground' && taps.tapSpace) {
        this.beginTakeoff(game);
      } else if ((this.state === 'fly' || (this.state === 'takeoff' && this.stateT > 0.35)) && taps.tapLand) {
        this.tryBeginLand(game);
      }
    }

    switch (this.state) {
      case 'ground': this._stepGround(dt, time, game, this.mounted ? ctl : null); break;
      case 'takeoff': this._stepTakeoff(dt, time, game, ctl); break;
      case 'fly': this._stepFly(dt, time, game, ctl); break;
      case 'land': this._stepLand(dt, time, game, ctl); break;
    }

    this.accel.copy(this.vel).sub(this.prevVel).multiplyScalar(1 / Math.max(dt, 1e-4));
    this._stepVisuals(dt, time, game);
  }

  _stepSummon(dt, game) {
    const s = this.summon;
    s.t += dt;
    const u = clamp(s.t / s.dur, 0, 1);
    const e = 1 - Math.pow(1 - u, 2.4);
    const x = lerp(s.x0, s.x1, e);
    const z = lerp(s.z0, s.z1, e);
    const groundHere = this._supportAt(game, x, z, Math.max(s.y0, s.y1) + 2);
    const y = Math.max(lerp(s.y0, s.y1, e), groundHere) + Math.abs(Math.sin(u * Math.PI * 2)) * 0.24 * (1 - u);
    const inv = 1 / Math.max(dt, 1e-4);
    this.vel.set((x - this.pos.x) * inv, (y - this.pos.y) * inv, (z - this.pos.z) * inv);
    this.pos.set(x, y, z);
    this.yaw = s.yaw;
    this.pitch = clamp(-Math.atan2(this.vel.y, Math.hypot(this.vel.x, this.vel.z) + 1) * 0.4, -0.3, 0.3);
    this.roll = 0;
    this._updateFwd();

    if (this.actions.sprint) {
      this.actions.sprint.setEffectiveWeight(1 - u * 0.7);
      this.actions.sprint.setEffectiveTimeScale(1.2);
    }
    if (u >= 1) {
      const shouldMount = !!s.autoMount;
      this.pos.set(s.x1, s.y1, s.z1);
      this.vel.set(0, 0, 0);
      this.groundSpeed = 0;
      this.pitch = 0;
      this.summon = null;
      this.bellEnergy = 1.2;
      const sun = game.fx.sunTint(this.sunVis);
      dustRing(game.fx, s.x1, s.y1, s.z1, 0.65, 20, sun);
      puff(game.fx, s.x1, s.y1 + 0.9, s.z1, 14, sun, 0.6, 1.8);
      game.sound?.thump?.(0.75);
      this._jingle(game, 0.9);
      if (shouldMount) this.mount(game);
    }
  }

  _groundThrottle(game, ctl) {
    if (!ctl) return 0;
    const k = game.input?.keys;
    let th = 0;
    if (k) {
      if (k.has('KeyW') || k.has('ArrowUp')) th += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) th -= 1;
    }
    // Gamepad / mouse fallback when keyboard W/S aren't pressed
    if (th === 0 && Math.abs(ctl.pitch) > 0.15 && !game.input?.locked) {
      th = game.input?.invert ? ctl.pitch : -ctl.pitch;
    }
    return clamp(th, -1, 1);
  }

  _stepGround(dt, time, game, ctl) {
    const prevPos = _tmpPrev.copy(this.pos);
    const throttle = this._groundThrottle(game, ctl);
    const sprinting = !!(ctl && ctl.boost && throttle > 0.1);
    const braking = !!(ctl && ctl.brake);

    let wantSpeed = 0;
    if (throttle > 0.05) {
      wantSpeed = throttle * (sprinting ? CATBUS.SPRINT_SPEED : CATBUS.WALK_SPEED);
    } else if (throttle < -0.05 && !braking) {
      wantSpeed = throttle * CATBUS.REVERSE_SPEED;
    }
    if (braking) wantSpeed = 0;

    const accelRate = Math.abs(wantSpeed) > Math.abs(this.groundSpeed) ? (sprinting ? 4.8 : 6.0) : (braking ? 11.0 : 7.5);
    this.groundSpeed = damp(this.groundSpeed, wantSpeed, accelRate, dt);
    if (Math.abs(this.groundSpeed) < 0.04 && wantSpeed === 0) this.groundSpeed = 0;

    this.boosting = damp(this.boosting, sprinting && this.groundSpeed > CATBUS.WALK_SPEED * 1.15 ? 1 : 0, 5, dt);

    // Steering: smooth yaw turn, slightly tighter at walk speed than at full gallop
    const turnIn = ctl ? ctl.turn : 0;
    const speedFrac = clamp(Math.abs(this.groundSpeed) / CATBUS.SPRINT_SPEED, 0, 1);
    const maxYawRate = lerp(1.85, 1.22, speedFrac);
    const revSign = this.groundSpeed < -0.3 ? -1 : 1;
    this.turnRate = damp(this.turnRate, turnIn * maxYawRate * revSign, 7.5, dt);
    this.yaw += this.turnRate * dt;

    // Horizontal step
    const hx = Math.sin(this.yaw), hz = -Math.cos(this.yaw);
    this.pos.x += hx * this.groundSpeed * dt;
    this.pos.z += hz * this.groundSpeed * dt;

    this._collideGround(game, dt);

    // Support height & ledge drops
    const floor = this._supportAt(game, this.pos.x, this.pos.z, this.pos.y);
    const gap = this.pos.y - floor;

    if (gap <= 0.28 && this.vy <= 0.5) {
      this.pos.y = damp(this.pos.y, floor, 24, dt);
      if (Math.abs(this.pos.y - floor) < 0.03) this.pos.y = floor;
      this.vy = 0;
      this.grounded = true;
    } else {
      // Airborne over a drop / roof edge
      this.grounded = false;
      this.vy -= 23.0 * dt;
      this.pos.y += this.vy * dt;
      // Bounding fast off a high cliff catches the wind into flight automatically!
      if (this.mounted && this.pos.y - floor > 5.8 && this.groundSpeed > 11 && this.vy < -3) {
        this.airSpeed = Math.max(this.groundSpeed, 22);
        this.pitch = -0.12;
        this.state = 'fly';
        this.stateT = 0;
        this._enterFlyAnim(0.22);
        this._jingle(game, 0.6);
        return;
      }
      if (this.pos.y <= floor) {
        const impact = clamp(-this.vy * 0.14, 0, 3.5);
        this.pos.y = floor;
        this.vy = 0;
        this.grounded = true;
        if (impact > 0.35) {
          this.bobV -= impact * 1.4;
          this.bellEnergy = Math.min(1.5, this.bellEnergy + impact * 0.5);
          dustRing(game.fx, this.pos.x, floor, this.pos.z, 0.55, 14, game.fx.sunTint(this.sunVis));
          game.sound?.thump?.(clamp(impact * 0.4, 0.25, 0.8));
        }
      }
    }

    // Align stagecoach body pitch & roll to the terrain/roof wheelbase underfoot
    const wheel = 1.65, track = 0.78;
    const rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const hf = clamp(this._supportAt(game, this.pos.x + hx * wheel, this.pos.z + hz * wheel, this.pos.y + 0.4), floor - 1.1, floor + 1.1);
    const hb = clamp(this._supportAt(game, this.pos.x - hx * wheel, this.pos.z - hz * wheel, this.pos.y + 0.4), floor - 1.1, floor + 1.1);
    const hl = clamp(this._supportAt(game, this.pos.x - rx * track, this.pos.z - rz * track, this.pos.y + 0.4), floor - 0.7, floor + 0.7);
    const hr = clamp(this._supportAt(game, this.pos.x + rx * track, this.pos.z + rz * track, this.pos.y + 0.4), floor - 0.7, floor + 0.7);

    const targetPitch = this.grounded ? Math.atan2(hf - hb, wheel * 2) : clamp(this.vy * 0.03, -0.35, 0.35);
    const crossRoll = this.grounded ? Math.atan2(hl - hr, track * 2) : 0;
    const bankLean = clamp(this.turnRate * this.groundSpeed * 0.0085, -0.18, 0.18);
    this.pitch = damp(this.pitch, targetPitch, 10, dt);
    this.roll = damp(this.roll, crossRoll * 0.75 + bankLean, 9, dt);
    this._updateFwd();

    const inv = 1 / Math.max(dt, 1e-4);
    this.vel.set((this.pos.x - prevPos.x) * inv, (this.pos.y - prevPos.y) * inv, (this.pos.z - prevPos.z) * inv);

    // ---- Blend walk <-> sprint animations smoothly by ground speed
    const absSpd = Math.abs(this.groundSpeed);
    const moveW = smooth01((absSpd - 0.12) / 1.9);
    const sprintK = smooth01((absSpd - CATBUS.WALK_SPEED * 0.78) / (CATBUS.SPRINT_SPEED * 0.85 - CATBUS.WALK_SPEED * 0.78));
    const dirSign = this.groundSpeed < -0.15 ? -1 : 1;

    if (this.actions.walk && this.actions.sprint && this.actions.sprint !== this.actions.walk) {
      this.actions.walk.setEffectiveWeight(moveW * (1 - sprintK));
      this.actions.walk.setEffectiveTimeScale(clamp(absSpd / 8.2, 0.42, 1.55) * dirSign);
      this.actions.sprint.setEffectiveWeight(moveW * sprintK);
      this.actions.sprint.setEffectiveTimeScale(clamp(absSpd / 19.5, 0.72, 1.45));
    } else if (this.actions.walk) {
      this.actions.walk.setEffectiveWeight(moveW);
      this.actions.walk.setEffectiveTimeScale(clamp(absSpd / 9.0, 0.42, 2.2) * dirSign);
    }
    if (this.actions.idle) {
      this.actions.idle.setEffectiveWeight(1 - moveW);
    }

    // Gait phase drives subtle bell jingles & paw-step dust/petal puffs at a gallop
    const prevGait = this.gaitPhase;
    this.gaitPhase += dt * absSpd * 0.55;
    if (Math.floor(this.gaitPhase) !== Math.floor(prevGait)) {
      this.bellEnergy = Math.min(1.2, this.bellEnergy + 0.08 + 0.16 * sprintK);
    }
    if (absSpd > 6 && this.grounded) {
      this._pawDustAcc += dt * absSpd * (0.45 + 0.75 * sprintK);
      while (this._pawDustAcc >= 1) {
        this._pawDustAcc -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const back = (Math.random() - 0.5) * 3.0;
        const px = this.pos.x + rx * side * 0.82 + hx * back;
        const pz = this.pos.z + rz * side * 0.82 + hz * back;
        const sun = game.fx.sunTint(this.sunVis);
        puff(game.fx, px, this.pos.y + 0.18, pz, 1, sun, 0.18, 0.9 + sprintK * 1.1);
      }
    }

    // Running across meadows builds up gust energy for flight!
    if (this.mounted) {
      game.flight.gust = Math.min(1, game.flight.gust + dt * (0.04 + 0.10 * sprintK));
    }
    this.bump = Math.max(0, this.bump - dt * 2.5);
  }

  _stepTakeoff(dt, time, game, ctl) {
    const u = clamp(this.stateT / CATBUS.TAKEOFF_DUR, 0, 1);
    const turnIn = ctl ? ctl.turn : 0;
    this.turnRate = damp(this.turnRate, turnIn * 1.25, 6, dt);
    this.yaw += this.turnRate * dt;

    if (u < 0.24) {
      // Brief muscular coil before push-off
      const hx = Math.sin(this.yaw), hz = -Math.cos(this.yaw);
      const fwdSpd = Math.max(this.groundSpeed, 6);
      this.pos.x += hx * fwdSpd * dt;
      this.pos.z += hz * fwdSpd * dt;
      const floor = this._supportAt(game, this.pos.x, this.pos.z, this.pos.y);
      this.pos.y = floor;
      this.vel.set(hx * fwdSpd, 0, hz * fwdSpd);
    } else {
      if (!this._takeoffLeapt) {
        this._takeoffLeapt = true;
        this.airSpeed = Math.max(this.groundSpeed * 1.12, 22);
        this.vy = 11.8;
        const sun = game.fx.sunTint(this.sunVis);
        dustRing(game.fx, this.pos.x, this.pos.y, this.pos.z, 0.75, 22, sun);
        game.fx.burst(this.pos.x, this.pos.y + 0.6, this.pos.z, 18, 0.25, 0.3 + 0.7 * this.sunVis, 4.2);
        game.sound?.whoosh?.(0.85, true);
        this._jingle(game, 0.95);
      }
      this.airSpeed = damp(this.airSpeed, SPEEDS.CRUISE, 2.8, dt);
      const climbK = (u - 0.24) / 0.76;
      this.pitch = damp(this.pitch, lerp(0.34, 0.18, climbK), 9, dt);
      this.roll = damp(this.roll, clamp(this.turnRate / 1.3, -1, 1) * 0.5, 5, dt);
      this._updateFwd();

      const upExtra = lerp(8.5, 0.5, climbK);
      this.vel.set(
        this.fwd.x * this.airSpeed,
        this.fwd.y * this.airSpeed + upExtra,
        this.fwd.z * this.airSpeed,
      );
      this.pos.addScaledVector(this.vel, dt);
    }

    if (u >= 1) {
      this.airSpeed = this.vel.length();
      this.pitch = Math.asin(clamp(this.vel.y / Math.max(this.airSpeed, 1), -0.6, 0.6));
      this._updateFwd();
      this.state = 'fly';
      this.stateT = 0;
      this.holdAgl = -1;
      this._enterFlyAnim(0.24);
    }
  }

  _stepFly(dt, time, game, ctl) {
    const f = game.flight, T = game.terrain, S = f.solid;
    const CRUISE = 34, BOOST = 64, SLOW = 14, VMIN = 9, VMAX = 92;

    const speedK = clamp((this.airSpeed - VMIN) / (CRUISE - VMIN), 0.35, 1.6);
    const maxTurn = 1.22 / Math.pow(speedK, 0.42);
    let turnIn = ctl ? ctl.turn : 0;
    const pitchIn = ctl ? ctl.pitch : 0;

    // Gentle wind homing at the far edge of the sea
    const r = Math.hypot(this.pos.x, this.pos.z);
    const homeK = clamp((r - World.half * 0.90) / 260, 0, 1);
    if (homeK > 0) {
      const d = turnAngle(Math.atan2(-this.pos.x, this.pos.z) - this.yaw);
      turnIn = clamp(turnIn * (1 - homeK) + clamp(d * 1.4, -1, 1) * homeK, -1, 1);
    }

    this.turnRate = damp(this.turnRate, turnIn * maxTurn, 5.2, dt);
    this.yaw += this.turnRate * dt;

    // Pitch + automatic dive pull-out over ground & roofs
    let wantRate = pitchIn * 1.30;
    const pull = this._pullOut(game, time);
    const flaring = pull > 0.02 && pull > wantRate;
    if (flaring) wantRate = pull;
    this.pitchRate = damp(this.pitchRate, wantRate, flaring ? 12 : 6.2, dt);
    this.flare = damp(this.flare, flaring ? 1 : 0, 8, dt);
    this.pitch += this.pitchRate * dt;

    // Hands-off terrain contour following when skimming low
    const surfHere = f.surfaceAt(this.pos.x, this.pos.z, time);
    const agl = (this.pos.y + 1.1) - surfHere;
    if (Math.abs(pitchIn) < 0.05) {
      if (this.holdAgl < 0) this.holdAgl = Math.max(agl, CATBUS.FLY_CLEAR + 0.3);
      const look = Math.max(this.airSpeed * 0.55, 9);
      const hx = Math.sin(this.yaw), hz = -Math.cos(this.yaw);
      const sAhead = f.surfaceAt(this.pos.x + hx * look, this.pos.z + hz * look, time);
      const follow = clamp(1 - (agl - 10) / 10, 0, 1);
      const slope = Math.atan2(sAhead - surfHere, look);
      const corr = clamp((this.holdAgl - agl) * 0.06, -0.22, 0.22);
      this.pitch = damp(this.pitch, (slope + corr) * follow, 0.8 + 2.3 * follow, dt);
    } else {
      this.holdAgl = -1;
    }

    const ceil = clamp((this.pos.y - 820) / 160, 0, 1);
    if (ceil > 0 && this.pitch > 0) this.pitch = damp(this.pitch, 0, 3 * ceil, dt);
    this.pitch = clamp(this.pitch, -1.35, 1.10);
    this.roll = damp(this.roll, clamp(this.turnRate / maxTurn, -1, 1) * 0.78, 4.4, dt);

    // Airspeed & gust boost
    const wantBoost = !!(ctl && ctl.boost && f.gust > 0.02);
    this.boosting = damp(this.boosting, wantBoost ? 1 : 0, wantBoost ? 5 : 2.2, dt);
    let targetSpd = CRUISE + (BOOST - CRUISE) * this.boosting;
    if (ctl && ctl.brake) targetSpd = SLOW;
    const grav = -Math.sin(this.pitch) * 16.5;
    this.airSpeed += ((targetSpd - this.airSpeed) * (ctl && ctl.brake ? 1.35 : 0.55) + grav) * dt;
    this.airSpeed = clamp(this.airSpeed, VMIN, VMAX);
    if (wantBoost) f.gust = Math.max(0, f.gust - dt * 0.15);

    this._updateFwd();
    this.vel.copy(this.fwd).multiplyScalar(this.airSpeed);
    this.pos.addScaledVector(this.vel, dt);

    // Skim cushion over ground & roofs (never crash!)
    const ground = f.surfaceAt(this.pos.x, this.pos.z, time);
    const roof = S ? S.heightAt(this.pos.x, this.pos.z) : -1e9;
    const deck = roof > -1e8 && this.pos.y >= roof - CATBUS.STEP_UP ? Math.max(ground, roof) : ground;
    const h = this.pos.y - deck;
    this.touchdown = 0;

    if (h < CATBUS.FLY_CLEAR + 1.2) {
      const k = 1 - clamp((h - CATBUS.FLY_CLEAR * 0.5) / 1.8, 0, 1);
      if (this.pitch < 0) this.pitch = damp(this.pitch, 0, 12 * k, dt);
      if (h < CATBUS.FLY_CLEAR * 0.55) {
        if (-this.vel.y > 6) {
          this.touchdown = roof > ground ? 0 : clamp((-this.vel.y - 5) * 0.2, 0, 5);
          this.bellEnergy = Math.min(1.4, this.bellEnergy + 0.6);
        }
        this.pos.y = damp(this.pos.y, deck + CATBUS.FLY_CLEAR * 0.55, 18, dt);
        if (this.pos.y < deck + 0.25) this.pos.y = deck + 0.25;
      }
    }

    // Slide around building walls, cliffs, and props while flying
    this._collideGround(game, dt);
    this.bump = Math.max(0, this.bump - dt * 2.4);

    // Skimming low refills the gust meter
    const near = clamp(1 - (h - 0.6) / 8.0, 0, 1);
    if (!wantBoost) f.gust = Math.min(1, f.gust + dt * (0.035 + 0.17 * near * near));

    // Modulate fly animation playback speed subtly with airspeed & boost
    if (this.actions.fly) {
      this.actions.fly.setEffectiveTimeScale(0.85 + 0.40 * clamp((this.airSpeed - 18) / 42, 0, 1.2) + 0.22 * this.boosting);
    }
  }

  _pullOut(game, time) {
    const g0 = this.pitch;
    if (g0 > -0.12) return 0;
    const V = this.airSpeed, f = game.flight, T = game.terrain, S = f.solid;
    const dx = Math.sin(this.yaw), dz = -Math.cos(this.yaw);
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
    const sg = Math.sin(g0), cg = Math.cos(g0);
    const margin = CATBUS.FLY_CLEAR + 0.35;

    const clears = (w) => {
      const R = V / w;
      for (let i = 1; i <= 6; i++) {
        const g = g0 * (1 - i / 6);
        const dist = R * (Math.sin(g) - sg), y = py - R * (Math.cos(g) - cg);
        const sx = px + dx * dist, sz = pz + dz * dist;
        if (S) {
          const top = S.heightAt(sx, sz);
          if (top > -1e8 && y - top < margin && py >= top - 1.0) return false;
        }
        if (y - f.surfaceAt(sx, sz, time) < margin) {
          if (T.heightAt(sx, sz) > 0.4 && T.normalAt(sx, sz, this._n, 2.0).y < 0.62) continue;
          return false;
        }
      }
      return true;
    };
    let lo = 0.3, hi = 4.0;
    if (clears(lo)) return 0;
    if (!clears(hi)) return hi;
    for (let i = 0; i < 6; i++) { const mid = 0.5 * (lo + hi); if (clears(mid)) hi = mid; else lo = mid; }
    const pull = hi * smooth01((hi - 0.7) / 0.75);
    return Math.min(pull, Math.max(-this.pitch, 0) * 7 + 0.15);
  }

  _stepLand(dt, time, game, ctl) {
    const L = this.landData;
    const u = clamp(this.stateT / L.dur, 0, 1);

    // Start the 'land' clip timed so paw touchdown aligns cleanly with u = 1
    const landClipDur = this.actions.land?.getClip()?.duration || 0.52;
    if (!L.landAnimStarted && (1 - u) * L.dur <= landClipDur * 0.72) {
      L.landAnimStarted = true;
      this._fadeToAirAction('land', 0.14);
    }

    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const x = h00 * L.x0 + h10 * L.tanX + h01 * L.spot.x;
    const z = h00 * L.z0 + h10 * L.tanZ + h01 * L.spot.z;
    const floorHere = this._supportAt(game, x, z, Math.max(this.pos.y, L.spot.y) + 1.0);
    const arcY = lerp(L.y0, L.spot.y, smooth01(u))
      + L.vy0 * L.dur * 0.18 * u * (1 - u) * (1 - u)
      + Math.sin(u * Math.PI) * 0.35;
    const y = Math.max(arcY, floorHere * smooth01(u * 1.15));

    const inv = 1 / Math.max(dt, 1e-4);
    this.vel.set((x - this.pos.x) * inv, (y - this.pos.y) * inv, (z - this.pos.z) * inv);
    this.pos.set(x, y, z);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 1.5) {
      this.yaw = L.yaw0 + turnAngle(Math.atan2(this.vel.x, -this.vel.z) - L.yaw0) * smooth01(u * 1.4);
    }
    const flarePitch = 0.24 * Math.sin(u * Math.PI);
    this.pitch = damp(this.pitch, flarePitch, 10, dt);
    this.roll = damp(this.roll, 0, 10, dt);
    this.boosting = damp(this.boosting, 0, 6, dt);
    this._updateFwd();

    if (u >= 1) {
      this.pos.set(L.spot.x, L.spot.y, L.spot.z);
      this.grounded = true;
      this.vy = 0;

      // Carry forward into walk/sprint seamlessly if the player is holding W!
      const throttle = this._groundThrottle(game, ctl);
      const sprinting = !!(ctl && ctl.boost);
      if (throttle > 0.1 && !this.pendingDismount) {
        this.groundSpeed = clamp(L.entrySpeed * 0.65, CATBUS.WALK_SPEED, sprinting ? CATBUS.SPRINT_SPEED : CATBUS.WALK_SPEED + 3);
      } else {
        this.groundSpeed = Math.min(L.entrySpeed * 0.18, 3.5);
      }

      this.bobV -= 1.6;
      this.bellEnergy = 1.3;
      this.state = 'ground';
      this.stateT = 0;
      this._returnToGroundAnims(0.24);

      const sun = game.fx.sunTint(this.sunVis);
      dustRing(game.fx, L.spot.x, L.spot.y, L.spot.z, 0.85, 22, sun);
      if (L.spot.kind === 'ground') {
        game.fx.burst(L.spot.x, L.spot.y + 0.5, L.spot.z, 14, 0.2, 0.3 + 0.7 * this.sunVis, 3.2);
      }
      game.sound?.thump?.(0.8);
      this._jingle(game, 0.85);

      // Deliver courier parcel if we touched down on a designated perch!
      const openPads = game.gameplay?.open || [];
      for (const pad of openPads) {
        if (Math.hypot(pad.pos.x - L.spot.x, pad.pos.z - L.spot.z) < pad.radius + 3.5 && Math.abs(pad.pos.y - L.spot.y) < 2.5) {
          game.gameplay.courier.arrive(pad);
          break;
        }
      }

      if (this.pendingDismount) {
        this.dismount(game);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sync Flight state while mounted
  // ---------------------------------------------------------------------------------------------
  _syncToFlight(_dt, _time, f) {
    // Anchor Flight's centre at cabin window height (~1.35m above paws) so ChaseCamera, Wake,
    // Seeds, and WindFX sit right around the stagecoach body
    const anchorY = this.pos.y + 1.35;
    f.pos.set(this.pos.x, anchorY, this.pos.z);
    f.vel.copy(this.vel);
    f.speed = this.vel.length();
    f.yaw = this.yaw;
    f.pitch = this.pitch;
    f.roll = this.roll;
    f.boosting = this.boosting;
    f.bump = Math.max(f.bump, this.bump);
    f.touchdown = this.touchdown;
    this.touchdown = 0;
    this.autoHook.quiet = this.state === 'ground' && Math.abs(this.groundSpeed) < 2.0;
  }

  // ---------------------------------------------------------------------------------------------
  // Visuals: AnimationMixer, Secondary Motion (Lantern, Roof Rail, Bells), Sun Shadow, Fur LOD
  // ---------------------------------------------------------------------------------------------
  _stepVisuals(dt, time, game) {
    // Landing/step spring bob
    const wb = 8.5, zb = 0.28;
    this.bobV += (-wb * wb * this.bob - 2 * zb * wb * this.bobV) * dt;
    this.bob += this.bobV * dt;

    this._syncGroup(time);
    this.mixer?.update(dt);

    // Subtle procedural idle breathing & tail/ear life when standing still without an explicit idle clip
    if (this.state === 'ground' && !this.actions.idle) {
      const still = 1 - smooth01(Math.abs(this.groundSpeed) / 1.5);
      if (still > 0.01) {
        this.tilt.scale.y = 1 + 0.008 * Math.sin(time * 2.1) * still;
        this.tilt.scale.x = this.tilt.scale.z = 1 - 0.004 * Math.sin(time * 2.1) * still;
      } else {
        this.tilt.scale.set(1, 1, 1);
      }
    } else {
      this.tilt.scale.set(1, 1, 1);
    }

    // ---- Secondary motion 1: Hanging brass lantern 2-axis physical pendulum
    const L = this.lantern;
    const ax = this.accel;
    const fwdA = ax.x * this.fwd.x + ax.y * this.fwd.y + ax.z * this.fwd.z;
    const rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const spd = this.vel.length();
    const latA = ax.x * rx + ax.z * rz + this.turnRate * spd * 0.28;
    const drag = spd * 0.011;
    const gx = 9.8 * Math.sin(this.pitch) + fwdA * 0.22 - drag * 9.8;
    const gz = 9.8 * Math.sin(this.roll) * 0.65 - latA * 0.14;
    const penLen = 0.24;
    L.vx += (-(9.8 / penLen) * Math.sin(L.ax) * 0.28 + gx * 1.5 - L.vx * 2.8) * dt;
    L.vz += (-(9.8 / penLen) * Math.sin(L.az) * 0.28 + gz * 1.5 - L.vz * 2.8) * dt;
    L.ax = clamp(L.ax + L.vx * dt, -1.05, 1.05);
    L.az = clamp(L.az + L.vz * dt, -0.85, 0.85);

    if (this.rig.lanternPivot) {
      this.rig.lanternPivot.rotation.x = L.ax + Math.sin(time * 3.2) * 0.035;
      this.rig.lanternPivot.rotation.z = L.az + Math.cos(time * 2.5) * 0.03;
    }

    // ---- Secondary motion 2: Roof rail flex & hanging brass bells jingle
    this.bellEnergy = Math.max(0, this.bellEnergy - dt * 1.4);
    const jingleAmp = 0.05 + 0.22 * clamp(spd / 32, 0, 1.3) + 0.32 * this.bellEnergy;
    if (this.rig.railGroup) {
      this.rig.railGroup.rotation.z = clamp(-L.az * 0.08, -0.05, 0.05);
      this.rig.railGroup.position.y = 0.89 + clamp(this.bob * 0.18, -0.04, 0.04);
    }
    for (let i = 0; i < this.rig.bellPivots.length; i++) {
      const b = this.rig.bellPivots[i];
      const ph = b.phase;
      b.group.rotation.z = L.az * 0.65 + Math.sin(time * 13.5 + ph) * jingleAmp;
      b.group.rotation.x = L.ax * 0.55 + Math.cos(time * 11.2 + ph * 1.3) * jingleAmp * 0.8;
    }

    // ---- Shader-driven secondary motion on the GLB's dual lanterns & roof rail/bells
    if (this.rig.secUniforms) {
      const su = this.rig.secUniforms;
      su.uCatTime.value = time;
      su.uLanternRotL.value.set(L.ax + Math.sin(time * 3.2) * 0.035, L.az + Math.cos(time * 2.5) * 0.03);
      su.uLanternRotR.value.set(L.ax + Math.sin(time * 2.9 + 1.1) * 0.035, L.az + Math.cos(time * 2.3 + 0.8) * 0.03);
      su.uRailSway.value.set(
        clamp(L.az * 0.045, -0.035, 0.035),
        clamp(L.ax * 0.035, -0.030, 0.030),
        jingleAmp,
      );
    }

    // ---- Distance LOD for body mesh & fur shells
    const camDist = this.pos.distanceTo(game.camera.position);
    this.rig.updateLOD?.(camDist);

    // ---- Sun visibility & coat/fur uniforms
    const s = U.uSunDir.value;
    const hit = game.terrain.raycast(this.pos.x, this.pos.y + 1.4, this.pos.z, s.x, s.y, s.z, 900, 5);
    this.sunVis += ((hit < 0 ? 1 : 0.08) - this.sunVis) * Math.min(1, dt * 6);
    if (this.rig.sunVisUniform) this.rig.sunVisUniform.value = this.sunVis;

    const inFlight = this.state === 'fly' || this.state === 'takeoff' || this.state === 'land' ? 1 : 0;
    this.rig.fur?.update(this.pos, this.vel, this.fwd, inFlight, this.boosting, this.sunVis, game.camera.position);

    // Contact shadow shows when parked near ground; when mounted, Rider.renderShadow casts crisp world shadow!
    const groundY = game.terrain.heightAt(this.pos.x, this.pos.z);
    const hGround = this.pos.y - groundY;
    this.contactShadow.visible = !this.mounted && hGround < 3.5;
    if (this.contactShadow.visible) {
      this.contactShadow.material.uniforms.uOpacity.value = 0.38 * (1 - clamp(hGround / 3.5, 0, 1));
    }

    // Parked lantern beacon glint
    this.uBeacon.value.set(this.pos.x, this.pos.y, this.pos.z, this.mounted ? 0 : 1);
  }

  /** Called right after rider.update() in main.js so hop-aboard and hop-out arcs aren't overwritten! */
  syncRiderHop(dt, rider) {
    if (this.mounted) {
      if (this.mountHopT >= 0 && this.mountHopFrom) {
        this.mountHopT += dt;
        const u = clamp(this.mountHopT / 0.36, 0, 1);
        if (u < 1) {
          const door = _tmpNew.set(this.pos.x, this.pos.y + 1.35, this.pos.z);
          rider.group.visible = true;
          rider.group.position.lerpVectors(this.mountHopFrom, door, smooth01(u));
          rider.group.position.y += Math.sin(u * Math.PI) * 0.85;
          rider.group.scale.setScalar(1.0 - 0.65 * smooth01((u - 0.5) / 0.5));
        } else {
          this.mountHopT = -1;
          rider.group.visible = false;
          rider.group.scale.setScalar(1);
        }
      } else {
        rider.group.visible = false;
      }
    } else if (this.dismountHop) {
      this.dismountHop.t += dt;
      const u = clamp(this.dismountHop.t / this.dismountHop.dur, 0, 1);
      rider.group.visible = true;
      if (u < 1) {
        rider.group.position.lerpVectors(this.dismountHop.from, this.dismountHop.to, smooth01(u));
        rider.group.position.y += Math.sin(u * Math.PI) * 0.80;
        rider.group.scale.setScalar(0.45 + 0.55 * smooth01(u / 0.45));
      } else {
        rider.group.scale.setScalar(1);
        this.dismountHop = null;
      }
    }
  }

  _syncGroup(_time) {
    this.group.position.copy(this.pos);
    this.group.rotation.order = 'YXZ';
    this.group.rotation.set(this.pitch, -this.yaw, -this.roll);
    this.tilt.position.y = this.bob * 0.45;
  }
}

const _tmpPrev = new THREE.Vector3();
const _tmpOld = new THREE.Vector3();
const _tmpNew = new THREE.Vector3();
