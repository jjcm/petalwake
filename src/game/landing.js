// Smooth, snappy witch landing and takeoff — on designated tower pads, rooftops, and open ground.
//
// No circling or approach circuit: from wherever the broom is flying, it flares directly toward
// the landing mark, transitions smoothly in mid-air from the flying pose to the standing landing
// pose, touches down cleanly on the surface, and settles with a crisp cushioned compression.
import * as THREE from 'three';
import { APPROACH } from './approach.js';
import { SPEEDS } from '../player/flight.js';
import { hasClearGlide } from './surface.js';
import { puff, dustRing, twinkle, PALE } from './sparks.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const smooth = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeIn = (t) => t * t;
const turn = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const LAND = {
  RANGE: 26,        // m: proximity within which a designated pad lights up as the landing zone
  NOSE: 1.45,       // m: broom clearance ahead of centre near a wall
  TAIL: 1.45,       // m: broom clearance behind centre near a wall
  WALL: 0.9,        // m above floor: taller than this beside a pad counts as a wall
  SIT: 0.44,        // rad: resting nose-up angle if no standing model is loaded
  FLARE: 0.40,      // rad: aerodynamic braking flare pitch before mid-air dismount
  U_SWAP: 0.45,     // fraction through descent where flying pose transitions in mid-air to landing pose
  T_SETTLE: 0.26,   // s: crisp post-touchdown knee compression & recovery
  T_MOUNT: 0.28,    // s: quick hop back onto the broom
  T_LAUNCH: 0.56,   // s: brisk push-off into player flight
  IN_SLOPE: 0.8,
  OUT_SLOPE: 0.5,
  ORBIT: { dist: 6.4, height: 1.85, spin: 0.085, fov: 56 },
};

const SWEEP = [0, 25, -25, 50, -50, 75, -75, 105, -105, 135, -135, 165, -165, 180].map((d) => (d * Math.PI) / 180);

export class Landing {
  /**
   * @param game  the game object (flight, rider, chase, fx, sound, terrain)
   * @param on    { touch(pad), leave(pad), broke() }
   */
  constructor(game, on = {}) {
    this.game = game;
    this.on = on;
    this.state = 'fly';
    this.pad = null;
    this.t = 0;
    this.dur = 0.75;
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.startPos = new THREE.Vector3();
    this.tanXZ = new THREE.Vector2();
    this.startVy = 0;
    this.startYaw = 0;
    this.landYaw = 0;
    this.arcLift = 0;
    this.spot = new THREE.Vector3();
    this.away = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.rest = APPROACH.HOVER;
    this.since = 1e9;
    this.settleT = 1e9;
    this.cam = false;
    this.stand = false;
    this.fired = {};
    this.dep = null;
    this.out = 0;
    this.path = { len: 0, final: 0, lift: 0, bad: 0 };
    this._ways = new WeakMap();
    this.script = { step: (dt, time, f) => this._step(dt, time, f), quiet: false };
  }

  get busy() { return this.state !== 'fly'; }
  get landed() { return this.state === 'landed'; }

  /** Top of land, water, or building at (x, z), respecting a designated pad's true floor. */
  _floor(pad, x, z) {
    const g = this.game, f = g.flight;
    let h = Math.max(g.terrain.heightAt(x, z), 0);
    if (f.river) { const r = f.river.levelAt(x, z); if (r > h) h = r; }
    if (f.solid) {
      if (pad && !pad.adhoc && (x - pad.pos.x) ** 2 + (z - pad.pos.z) ** 2 < (pad.radius + 0.6) ** 2) {
        h = Math.max(h, pad.pos.y);
      } else {
        const s = f.solid.heightAt(x, z);
        if (s > h) h = s;
      }
    }
    return h;
  }

  floorAt(x, z) { return this._floor(this.pad, x, z); }

  /** Open approach and departure headings for a designated pad. */
  way(pad) {
    if (pad.adhoc) {
      return { approach: pad.yaw, short: 0, depart: pad.yaw, back: 0, own: true };
    }
    if (this._ways.has(pad)) return this._ways.get(pad);
    let w = null;
    const inn = this._firstClear(pad.approach, (a) => this._clearIn(pad, a));
    const out = inn && this._firstClear(pad.yaw, (a) => this._clearOut(pad, a));
    if (out) w = { approach: inn.a, short: inn.v, depart: out.a, back: out.v, own: inn.i === 0 && out.i === 0 };
    this._ways.set(pad, w);
    return w;
  }

  forget() { this._ways = new WeakMap(); }

  _firstClear(a0, test) {
    for (let i = 0; i < SWEEP.length; i++) { const v = test(a0 + SWEEP[i]); if (v >= 0) return { a: a0 + SWEEP[i], v, i }; }
    return null;
  }

  _clearIn(pad, a) {
    const A = APPROACH, L = LAND;
    const short = this._standoff(pad, a, L.NOSE);
    const dx = Math.sin(a), dz = -Math.cos(a), rx = -dz, rz = dx;
    const hx = pad.pos.x - dx * short, hz = pad.pos.z - dz * short, y0 = pad.pos.y + A.HOVER + A.SETTLE - A.BOOT + 0.2;
    for (let d = 0.5; d <= 13; d += 0.5) {
      const x = hx - dx * d, z = hz - dz * d, y = y0 + d * L.IN_SLOPE;
      if (this._floor(pad, x, z) > y || this._floor(pad, x + rx * 0.7, z + rz * 0.7) > y || this._floor(pad, x - rx * 0.7, z - rz * 0.7) > y) return -1;
    }
    return short;
  }

  _clearOut(pad, a) {
    const A = APPROACH, L = LAND;
    const back = this._standoff(pad, a + Math.PI, L.TAIL);
    const dx = Math.sin(a), dz = -Math.cos(a), rx = -dz, rz = dx;
    const wx = pad.pos.x + dx * back, wz = pad.pos.z + dz * back, y0 = pad.pos.y + A.HOVER - A.BOOT + 0.4;
    for (let d = 0.5; d <= 14; d += 0.5) {
      const x = wx + dx * d, z = wz + dz * d, y = y0 + d * L.OUT_SLOPE;
      if (this._floor(pad, x, z) > y || this._floor(pad, x + rx * 0.7, z + rz * 0.7) > y || this._floor(pad, x - rx * 0.7, z - rz * 0.7) > y) return -1;
    }
    return back;
  }

  _standoff(pad, dir, reach) {
    const S = this.game.flight.solid;
    if (!S) return 0;
    const dx = Math.sin(dir), dz = -Math.cos(dir);
    for (let d = 0; d <= reach; d += 0.25) {
      if (S.heightAt(pad.pos.x + dx * d, pad.pos.z + dz * d) > pad.pos.y + LAND.WALL) return clamp(reach - d + 0.25, 0, reach + 0.25);
    }
    return 0;
  }

  _openArc(pad, dist, height) {
    const S = this.game.flight.solid, T = this.game.terrain;
    if (!S) return null;
    const N = 36, open = [], F = this.focus;
    let all = true;
    for (let k = 0; k < N; k++) {
      const az = (k / N) * TAU, sx = Math.sin(az), sz = -Math.cos(az);
      let ok = true;
      for (let j = 3; j <= 10 && ok; j++) {
        const u = j / 10, x = F.x + sx * dist * u, z = F.z + sz * dist * u, y = F.y + 0.2 + (height - 0.2) * u;
        if (Math.max(S.heightAt(x, z), T.heightAt(x, z)) > y - 0.5) ok = false;
      }
      open.push(ok);
      if (!ok) all = false;
    }
    if (all) return null;
    let best = 0, at = 0;
    for (let k = 0; k < N; k++) {
      if (!open[k] || open[(k + N - 1) % N]) continue;
      let n = 0;
      while (n < N && open[(k + n) % N]) n++;
      if (n > best) { best = n; at = k; }
    }
    if (best < 3) return { mid: pad.yaw, half: 0.2 };
    const step = TAU / N;
    return { mid: (at + (best - 1) / 2) * step, half: Math.max(0.2, ((best - 1) / 2) * step - 0.26) };
  }

  _set(state) { this.state = state; this.t = 0; this.fired = {}; }
  _once(key) { if (this.fired[key]) return false; this.fired[key] = true; return true; }

  /**
   * Begin a direct, smooth, snappy landing onto `pad` (either a designated tower pad or an
   * ad-hoc ground/roof surface). No approach pattern or circling.
   */
  begin(pad, opts = {}) {
    if (this.busy) return false;
    const w = this.way(pad);
    if (!w) return false;
    const g = this.game, f = g.flight, A = APPROACH, L = LAND;

    // Unless forced by debug hook, ensure a tower wall isn't standing taller than both ends between us
    if (!opts.force && !pad.adhoc && !hasClearGlide(g, f.pos.x, f.pos.y + 1.2, f.pos.z, pad.pos.x, pad.pos.y + 1.0, pad.pos.z, 0.9)) {
      // Allow hopping up over a parapet lip when close to the pad
      const hd = Math.hypot(pad.pos.x - f.pos.x, pad.pos.z - f.pos.z);
      if (hd > 18 || f.pos.y < pad.pos.y - 6) return false;
    }

    this.pad = pad;
    this.stand = !!g.rider.standing;
    this.rest = this.stand ? A.HOVER : Math.max(g.rider.restHeight(L.SIT) - 0.02, 0.3);
    this.out = pad.adhoc ? f.yaw : w.depart;
    this.landYaw = pad.adhoc ? f.yaw : pad.yaw;

    this.spot.set(pad.pos.x, pad.pos.y, pad.pos.z);
    this.away.set(
      pad.pos.x + Math.sin(this.out) * w.back,
      pad.pos.y + A.HOVER,
      pad.pos.z - Math.cos(this.out) * w.back,
    );
    this.focus.set(pad.pos.x, pad.pos.y + 1.15, pad.pos.z);

    this.startPos.copy(f.pos);
    this.startYaw = f.yaw;
    this.yaw = f.yaw;
    this.pitch = f.pitch;
    this.roll = f.roll;

    const dx = this.spot.x - f.pos.x;
    const dz = this.spot.z - f.pos.z;
    const horizDist = Math.hypot(dx, dz);
    const vertDist = Math.abs((pad.pos.y + this.rest) - f.pos.y);
    const totalDist = Math.hypot(horizDist, vertDist);

    // Snappy direct duration: ~0.52s when skimming close, up to ~1.12s from medium range
    this.dur = clamp(0.46 + totalDist * 0.029, 0.50, 1.15);

    // Initial horizontal Hermite tangent preserves velocity direction without overshooting the mark
    const hs = Math.hypot(f.vel.x, f.vel.z);
    const along = horizDist > 0.2 ? (f.vel.x * dx + f.vel.z * dz) / horizDist : hs;
    const tanMag = clamp(Math.max(0, along) * this.dur * 0.55, 0, Math.min(horizDist * 1.15, 12));
    if (hs > 0.5 && tanMag > 0.05) {
      // Blend initial velocity direction slightly toward target so off-axis taps curve cleanly straight in
      const vx = f.vel.x / hs, vz = f.vel.z / hs;
      const tx = horizDist > 0.2 ? dx / horizDist : vx;
      const tz = horizDist > 0.2 ? dz / horizDist : vz;
      const mx = vx * 0.55 + tx * 0.45, mz = vz * 0.55 + tz * 0.45;
      const ml = Math.hypot(mx, mz) || 1;
      this.tanXZ.set((mx / ml) * tanMag, (mz / ml) * tanMag);
    } else {
      this.tanXZ.set(0, 0);
    }
    this.startVy = clamp(f.vel.y, -14, 10);

    // Compute minimal arc clearance over any intervening parapet/roof edge along the straight chord
    let maxObs = -1e9;
    const samples = Math.max(4, Math.min(24, Math.ceil(horizDist / 0.9)));
    for (let i = 1; i < samples; i++) {
      const u = i / samples;
      const sx = f.pos.x + dx * u, sz = f.pos.z + dz * u;
      const fl = this._floor(pad, sx, sz) + 0.78;
      const lineY = lerp(f.pos.y, pad.pos.y + this.rest, u);
      if (fl - lineY > maxObs) maxObs = fl - lineY;
    }
    this.arcLift = clamp(Math.max(0.28, maxObs), 0.28, 4.5);

    this.path = { len: horizDist, final: horizDist, lift: this.arcLift, bad: 0 };
    this.cam = false;
    this.since = 1e9;
    this.settleT = 1e9;
    this.script.quiet = false;
    this._boost = !!(g.input && g.input.boost);
    f.auto = this.script;
    this._set('descent');
    g.sound?.whoosh?.(0.45);
    return true;
  }

  /** Place the witch directly in the landed state at (x, y, z) (used e.g. when dismounting the catbus). */
  placeLanded(x, y, z, yaw = 0, kind = 'ground') {
    const g = this.game, f = g.flight;
    this.stand = !!g.rider.standing;
    this.rest = this.stand ? APPROACH.HOVER : Math.max(g.rider.restHeight(LAND.SIT) - 0.02, 0.3);
    this.pad = {
      id: null, name: null, adhoc: true, kind,
      pos: new THREE.Vector3(x, y, z), radius: 1.4, yaw, approach: yaw,
    };
    this.spot.set(x, y, z);
    this.away.set(x, y + APPROACH.HOVER, z);
    this.focus.set(x, y + 1.15, z);
    this.out = yaw;
    this.landYaw = yaw;
    this.yaw = yaw; this.pitch = this.stand ? 0 : LAND.SIT; this.roll = 0;
    f.pos.set(x, y + this.rest, z);
    f.vel.set(0, 0, 0);
    f.speed = 0;
    f.yaw = yaw; f.pitch = this.pitch; f.roll = 0;
    this.script.quiet = true;
    f.auto = this.script;
    this.settleT = 0;
    this.since = 1e9;
    this.cam = true;
    g.chase.circle(this.focus, {
      ...LAND.ORBIT, seconds: 0.9, skip: 1.8,
      arc: this._openArc(this.pad, LAND.ORBIT.dist + 0.6, LAND.ORBIT.height + 0.4),
    });
    this._set('landed');
    this._pose();
  }

  /** Hop back on the broom and launch. */
  takeoff() {
    if (this.state !== 'landed') return false;
    // On open ground/roofs, let the player take off toward where the camera is looking if desired,
    // or along her current facing
    if (this.pad && this.pad.adhoc) {
      const w = this._firstClear(this.yaw, (a) => this._clearOut(this.pad, a));
      this.out = w ? w.a : this.yaw;
    }
    this._set('mount');
    return true;
  }

  /** Release control of the broom immediately. */
  abort() {
    const g = this.game, f = g.flight, r = g.rider;
    if (f.auto === this.script) {
      f.auto = null;
      f.speed = Math.max(f.speed, SPEEDS.VMIN);
      if (this.state !== 'descent') { f.pitch = 0; f.roll = 0; }
    }
    r.seat.hop = 0; r.seat.sy = 1; r.seat.calm = 0;
    r.off.on = false; r.off.y = 0; r.off.sy = 1;
    if (this.cam) g.chase.release(0.55);
    this.cam = false;
    this.pad = null; this.dep = null;
    this.since = 1e9;
    this.settleT = 1e9;
    this._set('fly');
  }

  update(dt, ctl) {
    if (!this.busy) return;
    const f = this.game.flight;
    if (f.auto !== this.script) { this.abort(); return; }
    if (this.state === 'descent') {
      // Pressing boost early in descent cancels the landing cleanly back into flight
      const boost = !!(ctl && ctl.boost);
      if (boost && !this._boost && this.t < this.dur * LAND.U_SWAP) {
        this.abort();
        this.on.broke?.();
        return;
      }
      this._boost = boost;
    }
  }

  // ------------------------------------------------------------------------------- script steps
  _step(dt, time, f) {
    this.t += dt;
    this.since += dt;
    if (this.state === 'landed') this.settleT += dt;
    switch (this.state) {
      case 'descent': this._descent(dt, f); break;
      case 'landed': this._wait(dt, f); break;
      case 'mount': this._mount(dt, f); break;
      case 'launch': this._launch(dt, f); break;
      default: f.auto = null;
    }
    this._pose();
  }

  _move(f, x, y, z, dt) {
    const inv = 1 / Math.max(dt, 1e-4);
    f.vel.set((x - f.pos.x) * inv, (y - f.pos.y) * inv, (z - f.pos.z) * inv);
    f.pos.set(x, y, z);
    f.speed = f.vel.length();
  }

  _descent(dt, f) {
    const L = LAND, g = this.game, pad = this.pad;
    const u = clamp(this.t / this.dur, 0, 1);

    // Cubic Hermite horizontal curve: smooth deceleration straight to the landing mark, zero circling
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const x = h00 * this.startPos.x + h10 * this.tanXZ.x + h01 * this.spot.x;
    const z = h00 * this.startPos.z + h10 * this.tanXZ.y + h01 * this.spot.z;

    // Vertical curve: clean flare-and-settle onto pad.pos.y + this.rest, clearing any lip
    const endY = pad.pos.y + this.rest;
    const baseY = lerp(this.startPos.y, endY, smooth(u));
    const velArc = this.startVy * this.dur * 0.22 * u * (1 - u) * (1 - u);
    const clearArc = Math.sin(u * Math.PI) * this.arcLift * (1 - 0.35 * u);
    const minFloor = this._floor(pad, x, z) + lerp(0.72, this.rest - 0.02, smooth(seg(u, 0.55, 1.0)));
    const y = Math.max(baseY + velArc + clearArc, minFloor);

    this._move(f, x, y, z, dt);

    // Heading: track travel vector initially, then smoothly align to landYaw through the mid-air swap
    const travelSpeed = Math.hypot(f.vel.x, f.vel.z);
    const travelYaw = travelSpeed > 1.2 ? Math.atan2(f.vel.x, -f.vel.z) : this.yaw;
    const alignK = smooth(seg(u, 0.22, 0.92));
    const baseYaw = this.startYaw + turn(travelYaw - this.startYaw) * smooth(seg(u, 0, 0.35));
    this.yaw = baseYaw + turn(this.landYaw - baseYaw) * alignK;

    // Pitch: crisp braking flare before U_SWAP, then level (for standing model) or resting tilt
    const stand = this.stand && !!g.rider.standing;
    if (u < L.U_SWAP) {
      const fk = smooth(u / L.U_SWAP);
      this.pitch = damp(this.pitch, L.FLARE * fk, 12, dt);
    } else {
      const targetPitch = stand ? 0 : L.SIT;
      this.pitch = damp(this.pitch, targetPitch, 11, dt);
    }
    this.roll = damp(this.roll, 0, 10, dt);
    f.yaw = this.yaw; f.pitch = this.pitch; f.roll = this.roll;

    this.script.quiet = u > 0.55;

    // Start blending the landed camera in smoothly during the second half of the descent
    if (!this.cam && u > 0.38) {
      this.cam = true;
      g.chase.circle(this.focus, {
        ...L.ORBIT,
        seconds: 1.05,
        skip: Math.max(pad.radius + 0.9, 1.8),
        arc: this._openArc(pad, L.ORBIT.dist + 0.8, L.ORBIT.height + 0.5),
      });
    }

    // Mid-air transition from flying pose to landing pose!
    if (u >= L.U_SWAP && this._once('swap')) {
      const sun = g.fx.sunTint(g.rider.sunVis);
      puff(g.fx, f.pos.x, f.pos.y + 0.25, f.pos.z, stand ? 12 : 8, sun, 0.42, 1.5);
      twinkle(g.fx, f.pos.x, f.pos.y + 0.3, f.pos.z, 8, PALE, 2.2, f.vel.x * 0.25, 0.4, f.vel.z * 0.25, 0.65);
      g.sound?.whoosh?.(0.28);
    }

    // Clean touchdown!
    if (u >= 1) {
      this._move(f, this.spot.x, endY, this.spot.z, dt);
      f.vel.set(0, 0, 0);
      f.speed = 0;
      f.yaw = this.yaw = this.landYaw;
      f.pitch = this.pitch = stand ? 0 : L.SIT;
      f.roll = this.roll = 0;
      this.script.quiet = true;
      this.settleT = 0;

      const sun = g.fx.sunTint(g.rider.sunVis);
      dustRing(g.fx, this.spot.x, pad.pos.y, this.spot.z, 0.32, 16, sun);
      if (pad.kind !== 'roof' && pad.adhoc) {
        g.fx.burst(this.spot.x, pad.pos.y + 0.5, this.spot.z, 8, 0.2, 0.3 + 0.7 * g.rider.sunVis, 2.2);
      }
      g.sound?.thump?.(0.65);
      this.on.touch?.(pad);
      this._set('landed');
    }
  }

  _wait(dt, f) {
    const stand = this.stand && !!this.game.rider.standing;
    this._move(f, this.spot.x, this.pad.pos.y + this.rest, this.spot.z, dt);
    f.vel.set(0, 0, 0);
    f.speed = 0;
    f.yaw = this.yaw = this.landYaw;
    f.roll = this.roll = 0;
    f.pitch = this.pitch = stand ? 0 : LAND.SIT;
  }

  _mount(dt, f) {
    const L = LAND, g = this.game, pad = this.pad, t = this.t, S = this.spot, W = this.away;
    const stand = this.stand && !!g.rider.standing;
    const u = clamp(t / L.T_MOUNT, 0, 1);
    const go = smooth(seg(u, 0.2, 1.0));
    const up = stand ? 1 : smooth(seg(u, 0.15, 0.9));
    this._move(f, lerp(S.x, W.x, go), pad.pos.y + lerp(this.rest, APPROACH.HOVER, up), lerp(S.z, W.z, go), dt);
    this.pitch = stand ? 0 : L.SIT * (1 - smooth(seg(u, 0.1, 0.9)));
    f.yaw = this.yaw = this.landYaw + turn(this.out - this.landYaw) * smooth(seg(u, 0.15, 0.95));
    f.pitch = this.pitch; f.roll = this.roll = 0;

    if (u >= 0.55 && this._once('puff')) {
      const sun = g.fx.sunTint(g.rider.sunVis);
      puff(g.fx, f.pos.x, pad.pos.y + 1.15, f.pos.z, stand ? 12 : 8, sun, 0.42, 1.5);
      dustRing(g.fx, S.x, pad.pos.y, S.z, 0.3, 12, sun);
      g.sound?.whoosh?.(0.32);
      this.since = 0;
    }
    this.focus.lerp(f.pos, 1 - Math.exp(-dt * 6));
    if (t >= L.T_MOUNT) this._depart();
  }

  _depart() {
    const pad = this.pad, A = APPROACH, W = this.away, g = this.game;
    const dx = Math.sin(this.out), dz = -Math.cos(this.out), rx = -dz, rz = dx;
    const base = pad.pos.y + A.HOVER, N = 24;
    const fl = new Float64Array(N), ys = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const x = W.x + dx * i, z = W.z + dz * i;
      fl[i] = Math.max(this.floorAt(x, z), this.floorAt(x + rx * 0.65, z + rz * 0.65), this.floorAt(x - rx * 0.65, z - rz * 0.65));
    }
    let lift = 0.55;
    const check = Math.min(N, Math.ceil((pad.radius || 1.4) + 3));
    for (let i = 0; i < check; i++) lift = Math.max(lift, fl[i] + A.BOOT - base);
    for (let i = 0; i < N; i++) {
      const climb = lift * smooth(seg(i, 0, 3.5)) + 0.12 * Math.max(0, i - 3.5);
      ys[i] = Math.max(base + climb, fl[i] + (i < check ? A.BOOT : 1.35));
    }
    ys[0] = base;
    this.dep = { x: W.x, z: W.z, dx, dz, ys, d: 0 };
    this.v = 3;
    if (this.cam) { this.cam = false; g.chase.release(0.65); }
    this.on.leave?.(pad);
    g.sound?.whoosh?.(0.75, true);
    dustRing(g.fx, this.spot.x, pad.pos.y, this.spot.z, 0.45, 14, g.fx.sunTint(g.rider.sunVis));
    this._set('launch');
  }

  _launch(dt, f) {
    const L = LAND, D = this.dep, t = this.t;
    const u = clamp(t / L.T_LAUNCH, 0, 1);
    this.v = lerp(5, SPEEDS.CRUISE * 0.88, easeOut(u));
    D.d += this.v * dt;
    const n = D.ys.length, fi = clamp(D.d, 0, n - 1.001), i = Math.floor(fi), frac = fi - i;
    const y = lerp(D.ys[i], D.ys[i + 1], frac);
    this._move(f, D.x + D.dx * D.d, y, D.z + D.dz * D.d, dt);
    this.pitch = damp(this.pitch, clamp(Math.atan(D.ys[i + 1] - D.ys[i]), -0.15, 0.35), 7, dt);
    f.yaw = this.yaw = this.out;
    f.pitch = this.pitch;
    f.roll = this.roll = damp(this.roll, 0, 7, dt);
    this.script.quiet = D.d < 3.5;

    if (t >= L.T_LAUNCH || D.d > n - 2) {
      f.auto = null;
      f.speed = Math.max(this.v, SPEEDS.SLOW + 4);
      f.vel.copy(f.fwd).multiplyScalar(f.speed);
      this.pad = null; this.dep = null;
      this._set('fly');
    }
  }

  /** Pose the seated / standing rider cleanly through mid-air transition, touchdown settle, and launch. */
  _pose() {
    const g = this.game, r = g.rider, seat = r.seat, off = r.off, L = LAND, t = this.t;
    const stand = this.stand && !!r.standing;
    seat.hop = 0; seat.sy = 1; seat.calm = 0;
    off.on = false; off.y = 0; off.sy = 1;
    const floorY = this.pad ? this.pad.pos.y - g.flight.pos.y : 0;

    if (this.state === 'descent') {
      const u = clamp(t / this.dur, 0, 1);
      if (stand && u >= L.U_SWAP) {
        // Mid-air landing pose: descending cleanly onto her boots from broom height to the surface
        const w = seg(u, L.U_SWAP, 1.0);
        const drop = (1 - easeIn(w)) * Math.min(0.48, Math.max(0.18, g.flight.pos.y - this.pad.pos.y - 0.35));
        off.on = true;
        off.y = floorY + drop;
        // Slight airborne extension anticipating contact, easing toward 1.0 right at touchdown
        off.sy = lerp(1.10, 0.97, smooth(w));
      } else {
        // Seated flare anticipation before mid-air dismount (or full seated settle if no standing mesh)
        const pre = seg(u, 0, L.U_SWAP);
        seat.hop = stand ? 0.24 * smooth(seg(pre, 0.35, 1.0)) - 0.05 * Math.sin(pre * Math.PI) : 0;
        seat.sy = stand ? lerp(0.94, 1.08, smooth(pre)) : 1 - 0.08 * Math.sin(u * Math.PI);
        seat.calm = smooth(u);
      }
    } else if (this.state === 'landed') {
      // Crisp, clean settle on touchdown: single smooth knee-absorb compression to rest (no rubbery bounce)
      const st = this.settleT;
      let sy = 1;
      if (st < L.T_SETTLE) {
        const w = st / L.T_SETTLE;
        const dip = Math.sin(Math.pow(w, 0.65) * Math.PI) * (1 - w * 0.35);
        sy = 1 - 0.14 * dip;
      }
      if (stand) {
        off.on = true;
        off.y = floorY;
        off.sy = sy;
      } else {
        seat.calm = 1;
        seat.sy = sy;
      }
    } else if (this.state === 'mount') {
      const u = clamp(t / L.T_MOUNT, 0, 1);
      const crouch = smooth(seg(u, 0, 0.35)), rise = easeOut(seg(u, 0.35, 1.0));
      const sy = lerp(lerp(1, 0.85, crouch), 1.12, rise);
      const hop = 0.38 * rise;
      if (u < 0.62 && stand) {
        off.on = true; off.y = floorY + hop; off.sy = sy;
      } else {
        seat.hop = hop * 0.6; seat.sy = sy; seat.calm = 1 - u;
      }
    }

    if (this.since < 0.7 && (this.state === 'mount' || this.state === 'launch')) {
      const env = Math.exp(-this.since * 7.5) * Math.cos(this.since * 12);
      seat.hop -= 0.14 * env;
      seat.sy *= 1 - 0.07 * env;
    }
  }
}
