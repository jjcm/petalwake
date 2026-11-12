// Broom flight: an arcade model tuned for skimming. No fail state - the ground has a soft cushion,
// a dive rounds itself out before it gets there and lands with a bounce, walls shove you off, and
// the wind turns you home if you wander out to sea.
//
// Buildings come in through flight.solid = { heightAt(x, z) } (the top of whatever stands at a
// point, -1e9 where nothing does) and are treated like the land: a roof is ground to skim, a wall
// is a cliff to slide along. flight.auto = { step(dt, time, flight) } lets something else fly the
// broom for a while (the landing sequence); the model then only keeps the books.
import * as THREE from 'three';
import { World } from '../core/ctx.js';
import { waveHeight } from '../world/water.js';

const CRUISE = 33, BOOST = 62, SLOW = 13, VMIN = 8, VMAX = 92;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const CLEAR = 1.15;        // skim height: boots just brushing the flower heads
const FLARE_RATE = 1.5;    // rad/s: how hard the automatic pull-out likes to turn the nose up
// A building top we are above - or no more than STEP below - is a floor like any other: the
// cushion lifts us onto it. Anything that stands taller than that beside us is a wall.
const STEP = 0.6;
const BODY = 0.7;          // how close the broom's centre may come to a wall (m)
const NONE = -1e8;         // solid.heightAt answers -1e9 where nothing is built
// twelve directions round the compass, for feeling out which way a wall faces
const RING = (() => { const a = []; for (let i = 0; i < 12; i++) a.push(Math.sin((i * Math.PI) / 6), -Math.cos((i * Math.PI) / 6)); return a; })();

export class Flight {
  constructor(terrain) {
    this.terrain = terrain;
    this.pos = new THREE.Vector3(0, 120, 0);
    this.vel = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.yaw = 0;      // radians, 0 = north (-z), positive turns east (+x)
    this.pitch = 0;    // radians, positive = nose up
    this.roll = 0;     // visual bank, positive = right wing down
    this.speed = CRUISE;
    this.turnRate = 0;
    this.pitchRate = 0;
    this.gust = 0.35;  // boost meter 0..1
    this.boosting = 0; // 0..1 smoothed
    this.agl = 100;    // height above ground or sea
    this.overWater = false;
    this.surfaceY = 0;
    this.bump = 0;     // impact impulse for camera shake
    this.accel = new THREE.Vector3();
    this.homing = 0;   // 0..1 when the wind is steering us back
    this.time = 0;
    this.holdAgl = -1;
    this.flare = 0;      // 0..1 while the broom is pulling itself out of a dive
    this.bob = 0;        // landing bounce: offset from the riding height (m) and its speed
    this.bobV = 0;
    this.touchdown = 0;  // set for one step when a dive lands: how hard (m/s)
    this.solid = null;   // { heightAt(x, z) }: tops of buildings (world metres), -1e9 where there are none
    this.auto = null;    // { step(dt, time, flight), quiet? }: something else is flying the broom
    this._sink = 0;
    this._air = false;
    this._n = new THREE.Vector3();
    this._wn = new THREE.Vector3();
    this._sn = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();
  }

  place(x, z, agl, yawDeg) {
    this.auto = null;
    this.pos.set(x, this.surfaceAt(x, z, 0) + agl, z);
    this.yaw = (yawDeg * Math.PI) / 180;
    this.pitch = 0; this.roll = 0; this.turnRate = 0; this.pitchRate = 0;
    this.speed = CRUISE;
    this.holdAgl = -1;
    this.agl = agl;
    this.flare = 0; this.bob = 0; this.bobV = 0; this.touchdown = 0; this._sink = 0; this._air = false;
    this._dir();
    this.vel.copy(this.fwd).multiplyScalar(this.speed);
    this._prevVel.copy(this.vel);
  }

  /** Top of whatever is below: terrain or the swell. */
  surfaceAt(x, z, t) {
    const h = this.terrain.heightAt(x, z);
    if (this.river) { const r = this.river.levelAt(x, z); if (r > h) return r; }
    if (h > 0.4) return h;
    const w = waveHeight(x, z, t, 0.8);
    return Math.max(h, w);
  }

  /** The same with buildings counted in: what a camera or a falling petal would come down on. */
  coverAt(x, z, t) {
    const h = this.surfaceAt(x, z, t);
    if (!this.solid) return h;
    const s = this.solid.heightAt(x, z);
    return s > h ? s : h;
  }

  /** The roof at (x, z) if something flying at height y would skim over it; -1e9 if it would not. */
  _roofAt(x, z, y) {
    if (!this.solid) return -1e9;
    const top = this.solid.heightAt(x, z);
    return top > NONE && y >= top - STEP ? top : -1e9;
  }

  /** Turn the heading so it runs along a wall with horizontal normal (nx, nz). */
  _slide(nx, nz, strength, dt) {
    const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    const fx = this.fwd.x / fl, fz = this.fwd.z / fl;
    const d = fx * nx + fz * nz;
    if (d >= 0) return 0;
    const rx = fx - 1.35 * d * nx, rz = fz - 1.35 * d * nz;
    let dy = Math.atan2(rx, -rz) - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * 15 * strength);
    return -d;     // how head-on the approach was: 0 glancing .. 1 square on
  }

  /**
   * How fast the nose must come up (rad/s) for the dive we are in to round out above the ground:
   * the gentlest circular arc, starting now, that stays clear of everything along the heading.
   * 0 when there is room to spare.
   */
  _pullOut(time) {
    const g0 = this.pitch;
    if (g0 > -0.10) return 0;
    const V = this.speed, T = this.terrain, S = this.solid;
    const dx = Math.sin(this.yaw), dz = -Math.cos(this.yaw);
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
    const sg = Math.sin(g0), cg = Math.cos(g0);
    const margin = CLEAR + 0.45;
    // a roof the arc comes down onto has to be cleared like the ground. One it would run into
    // from the side is a wall, and the wall code's business (yBefore: the arc's height just before)
    const ontoRoof = (sx, sz, y, yBefore) => {
      const top = S.heightAt(sx, sz);
      return top > NONE && y - top < margin && yBefore >= top - STEP;
    };
    const clears = (w) => {
      const R = V / w;
      let yPrev = py;
      for (let i = 1; i <= 6; i++) {
        const g = g0 * (1 - i / 6);                         // along the arc, until level
        const x = R * (Math.sin(g) - sg), y = py - R * (Math.cos(g) - cg);
        const sx = px + dx * x, sz = pz + dz * x;
        if (S) {
          // (buildings are small: look half-way between the stations as well)
          const gm = g0 * (1 - (i - 0.5) / 6);
          const xm = R * (Math.sin(gm) - sg), ym = py - R * (Math.cos(gm) - cg);
          if (ontoRoof(px + dx * xm, pz + dz * xm, ym, yPrev) || ontoRoof(sx, sz, y, ym)) return false;
        }
        yPrev = y;
        if (y - this.surfaceAt(sx, sz, time) < margin) {
          // a cliff face in the way is not somewhere to land: the wall code deals with those
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
    return hi;
  }

  _dir() {
    const cp = Math.cos(this.pitch);
    this.fwd.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /**
   * The wall between a free point (x0, z0) and one (x1, z1) inside a building, judged from what
   * stands taller than `yWall` around the place the two are parted. `out` gets the way it faces
   * (horizontal, out of the building), with the height of its top in y.
   * @returns how far along the way from the one to the other the wall stands (0..1), or -1.
   */
  _wallAhead(x0, z0, x1, z1, yWall, out) {
    const S = this.solid;
    let a = 0, b = 1;
    for (let i = 0; i < 6; i++) {
      const m = 0.5 * (a + b);
      if (S.heightAt(x0 + (x1 - x0) * m, z0 + (z1 - z0) * m) > yWall) b = m; else a = m;
    }
    const bx = x0 + (x1 - x0) * b, bz = z0 + (z1 - z0) * b;
    let sx = 0, sz = 0;
    for (let i = 0; i < 12; i++) {
      const cx = RING[i * 2], cz = RING[i * 2 + 1];
      if (S.heightAt(bx + cx * 0.75, bz + cz * 0.75) > yWall) { sx -= cx; sz -= cz; }
      if (S.heightAt(bx + cx * 1.5, bz + cz * 1.5) > yWall) { sx -= cx; sz -= cz; }
    }
    const l = Math.hypot(sx, sz);
    if (l < 0.5) return -1;
    out.set(sx / l, S.heightAt(bx, bz), sz / l);
    return b;
  }

  /** Buildings: steer off their walls early, and if we touch one anyway, slide along it. */
  _solidWalls(dt, hs, hx, hz) {
    const S = this.solid, p = this.pos;
    const yWall = p.y + STEP;
    // ---- touching? Feel round the body for the wall, step back out of it and slide
    let sx = 0, sz = 0, touch = S.heightAt(p.x, p.z) > yWall ? 1 : 0;
    for (let i = 0; i < 12; i++) {
      const cx = RING[i * 2], cz = RING[i * 2 + 1];
      if (S.heightAt(p.x + cx * BODY, p.z + cz * BODY) > yWall) { sx -= cx; sz -= cz; touch++; }
    }
    if (touch) {
      let l = Math.hypot(sx, sz);
      if (l < 0.3) {
        // wall on every side (we are well inside): go back the way we came
        const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
        sx = -this.fwd.x / fl; sz = -this.fwd.z / fl; l = 1;
      }
      sx /= l; sz /= l;
      let free = false;
      for (let k = 0; k < 160 && !free; k++) {
        p.x += sx * 0.05; p.z += sz * 0.05;
        free = S.heightAt(p.x, p.z) <= yWall;
        for (let i = 0; i < 12 && free; i++) free = S.heightAt(p.x + RING[i * 2] * BODY, p.z + RING[i * 2 + 1] * BODY) <= yWall;
      }
      if (!free) {
        // no way out sideways: up through the roof rather than stay inside
        const top = S.heightAt(p.x, p.z);
        if (top > NONE) p.y = top + CLEAR;
      }
      const headOn = this._slide(sx, sz, 1, dt);
      if (headOn > 0.3 && this.bump < 0.2) { this.bump = 0.3 + 0.7 * headOn; this.speed *= 1 - 0.12 * headOn; }
      return;
    }
    if (hs <= 2) return;
    // ---- look a quarter-second down the heading: will there be a wall where we are about to be?
    const t1 = 0.30, t0 = 0.12, vy = this.fwd.y * this.speed;
    const close = S.heightAt(p.x + hx * t0, p.z + hz * t0) > p.y + vy * t0 + STEP;
    const far = close || S.heightAt(p.x + hx * t1, p.z + hz * t1) > p.y + vy * t1 + STEP;
    if (!far) return;
    const t = close ? t0 : t1, n = this._sn;
    const at = this._wallAhead(p.x, p.z, p.x + hx * t, p.z + hz * t, p.y + vy * t + STEP, n);
    // (coming down onto a roof from above its edge is a landing, not a collision: the cushion's job)
    if (at < 0 || p.y + vy * t * at >= n.y - STEP) return;
    const headOn = this._slide(n.x, n.z, close ? 1 : 0.4, dt);
    // square on to a wall there is no room to turn: pull up as well. A glancing pass stays level.
    if (headOn > 0.55) this.pitch = damp(this.pitch, Math.max(this.pitch, 0.55), (close ? 6 : 2.5) * headOn, dt);
  }

  /** What the effects want to know, measured against the real ground (never a rooftop). */
  _book(surf, dt) {
    const ground = this.terrain.heightAt(this.pos.x, this.pos.z);
    const riverY = this.river ? this.river.levelAt(this.pos.x, this.pos.z) : -Infinity;
    this.overWater = ground < 0.25 || riverY > ground;
    this.surfaceY = riverY > ground ? riverY : this.overWater ? Math.max(surf, 0) : ground;
    this.agl = this.pos.y - this.surfaceY;
    this.accel.copy(this.vel).sub(this._prevVel).multiplyScalar(1 / Math.max(dt, 1e-4));
  }

  /** Something else has the broom (see game/landing.js): it places us, we keep the books. */
  _autoStep(dt, time) {
    const a = this.auto, yaw0 = this.yaw, pitch0 = this.pitch;
    this._prevVel.copy(this.vel);
    this.touchdown = 0;
    a.step(dt, time, this);                    // sets pos, vel, speed, yaw, pitch, roll (and may let go)
    this._dir();
    const dy = Math.atan2(Math.sin(this.yaw - yaw0), Math.cos(this.yaw - yaw0));
    const inv = 1 / Math.max(dt, 1e-4);
    this.turnRate = damp(this.turnRate, clamp(dy * inv, -3, 3), 9, dt);
    this.pitchRate = damp(this.pitchRate, clamp((this.pitch - pitch0) * inv, -3, 3), 9, dt);
    if (!a.keepBoost) this.boosting = damp(this.boosting, 0, 2.2, dt);
    this.flare = damp(this.flare, 0, 8, dt);
    this.homing = damp(this.homing, 0, 2, dt);
    this.bump = Math.max(0, this.bump - dt * 2.4);
    this._sink = 0; this._air = false; this.holdAgl = -1;
    // (the landing bounce keeps springing, so a kick from the script rings out the same way)
    const wb = 7.2, zb = 0.19;
    this.bobV += (-wb * wb * this.bob - 2 * zb * wb * this.bobV) * dt;
    this.bob += this.bobV * dt;
    this._book(this.surfaceAt(this.pos.x, this.pos.z, time), dt);
    // standing on a platform is not skimming whatever lies under it: no petals through the floor
    if (a.quiet) this.agl = Math.max(this.agl, 40);
    if (!a.keepBoost) this.gust = Math.min(1, this.gust + dt * 0.035);
  }

  update(dt, input, time) {
    this.time = time;
    if (this.auto) { this._autoStep(dt, time); return; }
    const T = this.terrain;

    // ---- steering
    const speedK = clamp((this.speed - VMIN) / (CRUISE - VMIN), 0.35, 1.6);
    const maxTurn = 1.28 / Math.pow(speedK, 0.42);
    let turnIn = input.turn, pitchIn = input.pitch;

    // the wind turns you home when you stray far out to sea
    const r = Math.hypot(this.pos.x, this.pos.z);
    const edge = World.half * 0.90;
    const homeK = clamp((r - edge) / 260, 0, 1);
    this.homing = damp(this.homing, homeK, 2, dt);
    if (homeK > 0) {
      const toHome = Math.atan2(-this.pos.x, this.pos.z); // yaw that points at the origin
      let d = toHome - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      turnIn = clamp(turnIn * (1 - homeK) + clamp(d * 1.4, -1, 1) * homeK, -1, 1);
    }

    this.turnRate = damp(this.turnRate, turnIn * maxTurn, 5.5, dt);
    this.yaw += this.turnRate * dt;

    const maxPitchRate = 1.35;
    let wantRate = pitchIn * maxPitchRate;
    // ---- dive pull-out. Left alone, a dive is rounded out for you: nothing happens while there is
    // room, then the nose swings up along the gentlest arc that still clears the ground, however
    // the stick is held. (Pull up harder yourself and it never interferes.)
    const need = this._pullOut(time);
    let pull = need * smooth01((need - FLARE_RATE * 0.5) / (FLARE_RATE * 0.5));
    // ease off as the path comes level, so the nose does not swing on past it
    pull = Math.min(pull, Math.max(-this.pitch, 0) * 7 + 0.15);
    const flaring = pull > 0.01 && pull > wantRate;
    if (flaring) wantRate = pull;
    this.pitchRate = damp(this.pitchRate, wantRate, flaring || this.flare > 0.1 ? 13 : 6.5, dt);
    this.flare = damp(this.flare, flaring ? 1 : 0, 8, dt);
    this.pitch += this.pitchRate * dt;
    // hands off the stick: high up the broom levels out; low down it holds its height above
    // the ground and follows the lie of the land, so skimming takes no effort
    if (Math.abs(pitchIn) < 0.05) {
      if (this.holdAgl < 0) this.holdAgl = Math.max(this.agl, 1.25);
      const look = Math.max(this.speed * 0.55, 8);
      const hx = this.fwd.x, hz = this.fwd.z, hl = Math.hypot(hx, hz) || 1;
      const sHere = this.surfaceAt(this.pos.x, this.pos.z, time);
      const sAhead = this.surfaceAt(this.pos.x + (hx / hl) * look, this.pos.z + (hz / hl) * look, time);
      const follow = clamp(1 - (this.agl - 9) / 9, 0, 1);
      const slope = Math.atan2(sAhead - sHere, look);
      const corr = clamp((this.holdAgl - this.agl) * 0.06, -0.22, 0.22);
      this.pitch = damp(this.pitch, (slope + corr) * follow, 0.8 + 2.4 * follow, dt);
    } else {
      this.holdAgl = -1;
    }
    // soft ceiling
    const ceil = clamp((this.pos.y - 820) / 160, 0, 1);
    if (ceil > 0 && this.pitch > 0) this.pitch = damp(this.pitch, 0, 3 * ceil, dt);
    this.pitch = clamp(this.pitch, -1.40, 1.15);

    // bank into the turn
    this.roll = damp(this.roll, clamp(this.turnRate / maxTurn, -1, 1) * 0.92, 4.6, dt);

    // ---- speed
    const wantBoost = input.boost && this.gust > 0.02;
    this.boosting = damp(this.boosting, wantBoost ? 1 : 0, wantBoost ? 5 : 2.2, dt);
    let target = CRUISE + (BOOST - CRUISE) * this.boosting;
    if (input.brake) target = SLOW;
    // gravity trades height for speed
    const grav = -Math.sin(this.pitch) * 17;
    this.speed += ((target - this.speed) * (input.brake ? 1.3 : 0.55) + grav) * dt;
    this.speed = clamp(this.speed, VMIN, VMAX);
    if (wantBoost) this.gust = Math.max(0, this.gust - dt * 0.16);

    // ---- move
    this._dir();
    this._prevVel.copy(this.vel);
    this.vel.copy(this.fwd).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);

    // ---- ground cushion: skim effortlessly, never crash
    const hs = Math.hypot(this.fwd.x, this.fwd.z) * this.speed;       // horizontal speed
    const hx = this.fwd.x * this.speed, hz = this.fwd.z * this.speed;
    const ground = this.surfaceAt(this.pos.x, this.pos.z, time);      // the land or the sea...
    // ...or a roof we are over (or were over a moment ago: a fast sink must not fall through one)
    const roof = this.solid ? this._roofAt(this.pos.x, this.pos.z, Math.max(this.pos.y, this.pos.y - this.vel.y * dt)) : -1e9;
    const surf = roof > ground ? roof : ground;
    const la = 0.22;
    // rising ground ahead lifts the floor early; a wall ahead is not "ground" and is handled below
    const maxRise = hs * la * 1.3 + 0.8;
    let ahead = this.surfaceAt(this.pos.x + hx * la, this.pos.z + hz * la, time);
    let ahead2 = this.surfaceAt(this.pos.x + hx * 0.5, this.pos.z + hz * 0.5, time);
    if (ahead - surf > maxRise) ahead = surf;
    if (ahead2 - surf > maxRise * 2.3) ahead2 = surf;
    // (hard: the level the broom is never allowed under. Roofs are left out of it: the broom is
    // eased up onto those, quickly, rather than snapped there as it crosses the edge)
    const hard = Math.max(ground, ahead - 0.3, ahead2 - Math.max(0, this.pos.y - surf) - 2.0);
    const clear = CLEAR;
    // a roof just ahead that we are high enough to skim lifts the floor early, like rising ground
    const roofA = this.solid ? this._roofAt(this.pos.x + hx * la, this.pos.z + hz * la, this.pos.y) : -1e9;
    const floor = Math.max(surf, hard, roofA - 0.3);
    const slopeRoof = roofA > surf ? Math.atan2(roofA + clear - this.pos.y, Math.max(hs * la, 0.5)) : -9;
    const cushion = 2.1;
    let h = this.pos.y - floor;
    const n = T.normalAt(this.pos.x, this.pos.z, this._n, 2.0);
    // steeper than ~52 degrees (the slope of the land means nothing while a roof is what is under us)
    const steep = n.y < 0.62 && T.heightAt(this.pos.x, this.pos.z) > 0.4 && roof <= ground;

    // ---- landing: coming out of a dive onto the deck, the broom sinks into its cushion and
    // bounces once or twice before it settles at riding height. The harder the dive, the deeper.
    this._sink = Math.max(this._sink * Math.exp(-dt / 1.2), -this.fwd.y * this.speed);
    this.touchdown = 0;
    if (h > clear + 3.5) this._air = true;
    else if (this._air && h < clear + 0.9 && !steep) {
      this._air = false;
      const hit = clamp((this._sink - 5) * 0.19, 0, 6.5);
      if (hit > 0.3) {
        this.bobV -= hit;
        this.touchdown = roof > ground ? 0 : hit;      // (a roof has no petals or spray to throw up)
        this.bump = Math.max(this.bump, hit * 0.07);
        if (Math.abs(pitchIn) < 0.05) this.holdAgl = clear + 0.15;   // hands off: settle at riding height
      }
      this._sink = 0;
    }
    {
      // a lightly damped spring about the riding height
      const wb = 7.2, zb = 0.19;
      this.bobV += (-wb * wb * this.bob - 2 * zb * wb * this.bobV) * dt;
      const nb = this.bob + this.bobV * dt;
      this.pos.y += nb - this.bob;
      this.bob = nb;
      h = this.pos.y - floor;
    }
    const ride = clear + Math.min(this.bob, 0);        // while the cushion is squashed, do not fight it
    if (h < cushion && !(steep && h < -1.2)) {
      const k = 1 - clamp((h - clear) / (cushion - clear), 0, 1);
      // close to the deck the nose cannot point below the lie of the land
      const slopeAhead = Math.max(Math.atan2(ahead - surf, Math.max(hs * la, 0.5)), slopeRoof);
      if (this.pitch < slopeAhead) this.pitch = damp(this.pitch, slopeAhead, 12 * k * k, dt);
      if (h < ride) {
        this.pos.y = damp(this.pos.y, floor + ride, 16, dt);
        if (this.pos.y < hard + 0.5) this.pos.y = hard + 0.5;
        else if (roof > ground && this.pos.y < roof + 0.5) this.pos.y = Math.min(roof + 0.5, this.pos.y + 18 * dt);
      }
    }
    // ---- walls: steer off them early, and if we touch one anyway, slide along it
    let wallN = null;
    if (steep && h < clear) {
      // inside a wall: step back out along its horizontal normal (never pop up to its top)
      const nl = Math.hypot(n.x, n.z) || 1;
      const nx = n.x / nl, nz = n.z / nl;
      for (let i = 0; i < 28; i++) {
        this.pos.x += nx * 0.6; this.pos.z += nz * 0.6;
        if (this.surfaceAt(this.pos.x, this.pos.z, time) + clear * 0.55 <= this.pos.y) break;
      }
      wallN = this._wn.set(nx, 0, nz);
      this._slide(nx, nz, 1, dt);
      if (this.bump < 0.2) { this.bump = 1; this.speed *= 0.88; }
    } else if (hs > 2) {
      // look a quarter-second down the heading: will the ground there be above us?
      const t1 = 0.30, t0 = 0.12;
      const y1 = this.pos.y + this.fwd.y * this.speed * t1, y0 = this.pos.y + this.fwd.y * this.speed * t0;
      const far = T.heightAt(this.pos.x + hx * t1, this.pos.z + hz * t1) > y1 + 0.6;
      const close = T.heightAt(this.pos.x + hx * t0, this.pos.z + hz * t0) > y0 + 0.6;
      if (far || close) {
        const wn = T.normalAt(this.pos.x + hx * (close ? t0 : t1), this.pos.z + hz * (close ? t0 : t1), this._wn, 3);
        if (wn.y < 0.75) {
          const nl = Math.hypot(wn.x, wn.z) || 1;
          const headOn = this._slide(wn.x / nl, wn.z / nl, close ? 1 : 0.4, dt);
          // square on to a wall there is no room to turn: pull up as well. A glancing pass stays level.
          if (headOn > 0.55) this.pitch = damp(this.pitch, Math.max(this.pitch, 0.55), (close ? 6 : 2.5) * headOn, dt);
        }
      }
    }
    // buildings: the same again
    if (this.solid) this._solidWalls(dt, hs, hx, hz);
    // stones, trees and the lighthouse: slide around them
    if (this.props && this.props.collide(this.pos, 0.9, this._n)) {
      const n = this._n, d = this.fwd.x * n.x + this.fwd.z * n.z;
      if (d < 0) {
        const rx = this.fwd.x - 1.5 * d * n.x, rz = this.fwd.z - 1.5 * d * n.z;
        let dy = Math.atan2(rx, -rz) - this.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.yaw += dy * Math.min(1, dt * 16);
        if (this.bump < 0.2) { this.bump = 1; this.speed *= 0.9; }
      }
    }
    this.bump = Math.max(0, this.bump - dt * 2.4);

    // ---- bookkeeping for effects
    this._book(ground, dt);

    // skimming close to anything fills the gust meter
    const near = clamp(1 - (this.agl - 1.0) / 7.0, 0, 1);
    if (!wantBoost) this.gust = Math.min(1, this.gust + dt * (0.035 + 0.17 * near * near));
  }
}

export const SPEEDS = { CRUISE, BOOST, SLOW, VMIN, VMAX };
