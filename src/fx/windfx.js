// Wind effects director: looks at what the broom is skimming past and lets go of the right things
// - petals off flowers, clippings off grass, spray off water, dust and stones off rock - into the
// simulated wake vortices (see vortex.js), which wind them up and carry them along. Plus ambient
// petals on the breeze and speed streaks in the air.
import * as THREE from 'three';
import { U, World } from '../core/ctx.js';
import { Flakes, Sprites, Ribbon, KIND, SPR } from './particles.js';
import { VORTEX } from './vortex.js';
import { stripWidth } from './strip.js';
import { waveHeight } from '../world/water.js';

const SURF = { NONE: 0, WATER: 1, FLOWERS: 2, GRASS: 3, ROCK: 4, SAND: 5 };
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// same drifts as flowerPetal() in the shaders
const PAL = {
  pinkA: [0.90, 0.16, 0.46], pinkB: [0.97, 0.42, 0.66], pinkC: [0.97, 0.76, 0.87], white: [0.97, 0.96, 0.90],
  lavA: [0.42, 0.26, 0.82], lavB: [0.66, 0.50, 0.93], red: [0.90, 0.07, 0.035], orange: [0.98, 0.36, 0.05],
  gold: [0.99, 0.72, 0.05], lemon: [0.98, 0.90, 0.30], blue: [0.16, 0.36, 0.92],
};
export function petalColor(s, r) {
  if (s < 0.42) return r < 0.42 ? PAL.pinkA : r < 0.76 ? PAL.pinkB : r < 0.90 ? PAL.pinkC : PAL.white;
  if (s < 0.60) return r < 0.62 ? PAL.white : r < 0.80 ? PAL.lemon : r < 0.92 ? PAL.pinkC : PAL.gold;
  if (s < 0.78) return r < 0.48 ? PAL.lavA : r < 0.80 ? PAL.lavB : r < 0.90 ? PAL.blue : PAL.white;
  if (s < 0.90) return r < 0.6 ? PAL.gold : r < 0.85 ? PAL.lemon : r < 0.94 ? PAL.white : PAL.orange;
  return r < 0.66 ? PAL.red : r < 0.84 ? PAL.orange : r < 0.93 ? PAL.pinkA : PAL.white;
}

export class WindFX {
  constructor(terrain, noise, depthUniform, particleBudget = 1) {
    this.terrain = terrain;
    this.noise = noise;
    this.flakes = new Flakes(Math.max(1, Math.round(12000 * particleBudget)));
    this.sprites = new Sprites(depthUniform, Math.max(1, Math.round(7000 * particleBudget)));
    this.ribbons = [new Ribbon(44, 0.7), new Ribbon(44, 0.7)];
    this.group = new THREE.Group();
    this.group.add(this.flakes.mesh, this.sprites.mesh, this.ribbons[0].mesh, this.ribbons[1].mesh);
    this.acc = new Float32Array(32);
    this.time = 0;
    this._sp = [0, 0, 0, 0];
    this._n = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._prevCam = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this.vortex = null;
    this.strip = null;       // the map of petals the wake has already taken: only what is left can be lifted
    this.surface = SURF.NONE;
    this.contact = 0;
    const self = this;
    this.env = {
      wind: (x, y, z, out) => self.windAt(x, y, z, out),
      wake: (x, y, z, out) => (self.vortex ? self.vortex.sample(x, y, z, out) : 0),
      surface: (x, z) => self.surfaceAt(x, z),
    };
  }

  // ------------------------------------------------------------------ fields
  _noise(u, v, ch) {
    const S = this.noise.size, d = this.noise.data;
    let x = (u * S) % S, y = (v * S) % S;
    if (x < 0) x += S; if (y < 0) y += S;
    const ix = x | 0, iy = y | 0, tx = x - ix, ty = y - iy;
    const ix1 = (ix + 1) % S, iy1 = (iy + 1) % S;
    const a = d[(iy * S + ix) * 4 + ch], b = d[(iy * S + ix1) * 4 + ch], c = d[(iy1 * S + ix) * 4 + ch], e = d[(iy1 * S + ix1) * 4 + ch];
    return ((a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty) / 255;
  }
  /** Mirrors windGust() in the shaders so petals ride the same fronts the grass shows. */
  gustAt(x, z) {
    const w = U.uWind.value, t = this.time;
    const ax = x * w.x + z * w.y, ay = -x * w.y + z * w.x;
    const g1 = this._noise(((ax - t * 12) * 0.62) / 256, (ay * 0.42 * 0.62) / 256, 0);
    const g2 = this._noise(((ax - t * 19) * 2.3) / 256 + 0.31, (ay * 0.55 * 2.3) / 256 + 0.31, 1);
    const g = g1 * 0.72 + g2 * 0.28;
    const s = clamp((g - 0.28) / 0.52, 0, 1);
    return s * s * (3 - 2 * s);
  }
  windAt(x, y, z, out) {
    const w = U.uWind.value, t = this.time;
    const g = this.gustAt(x, z);
    const sp = (1.6 + 6.2 * g) * w.z;
    // eddies
    const ex = Math.sin(z * 0.23 + t * 0.9) + Math.sin(y * 0.61 + t * 1.3 + x * 0.11);
    const ey = Math.sin(x * 0.19 + t * 1.1) * 0.5 + Math.sin(z * 0.27 - t * 0.7) * 0.5;
    const ez = Math.cos(x * 0.21 - t * 0.8) + Math.sin(y * 0.53 + t * 1.7 + z * 0.13);
    out[0] = w.x * sp + ex * 0.8; out[1] = ey * 0.6 + g * 0.5; out[2] = w.y * sp + ez * 0.8;
    return out;
  }
  surfaceAt(x, z) {
    const h = this.terrain.heightAt(x, z);
    if (this.river) { const r = this.river.levelAt(x, z); if (r > h) return r; }
    return h > 0.3 ? h : Math.max(h, waveHeight(x, z, this.time, 0.8));
  }
  classify(x, z, splat) {
    const T = this.terrain;
    const h = T.heightAt(x, z);
    if (h < 0.3) return SURF.WATER;
    if (this.river && this.river.levelAt(x, z) > h) return SURF.WATER;
    const n = T.normalAt(x, z, this._n, 2.5);
    if (1 - n.y > 0.27) return SURF.ROCK;
    if (h < 3.3) return SURF.SAND;
    T.splatAt(x, z, splat);
    if (splat[3] < 0.3) return SURF.ROCK;
    return splat[0] > 0.14 ? SURF.FLOWERS : SURF.GRASS;
  }
  /** Share of the flowers at a point that still have petals to lose. */
  _petalsLeft(x, z) { return this.strip ? 1 - this.strip.at(x, z) : 1; }
  _count(i, rate, dt) {
    this.acc[i] += rate * dt;
    const n = this.acc[i] | 0;
    this.acc[i] -= n;
    return n;
  }

  // ------------------------------------------------------------------ emitters
  _petal(x, y, z, vx, vy, vz, species, lit, life = rand(3.5, 6.5)) {
    const c = petalColor(clamp(species + rand(-0.05, 0.05), 0, 1), Math.random());
    const v = rand(0.86, 1.1);
    this.flakes.spawn(x, y, z, vx, vy, vz, KIND.PETAL, rand(0.10, 0.19), c[0] * v, c[1] * v, c[2] * v, life, lit, rand(0.62, 0.86));
  }
  _leaf(x, y, z, vx, vy, vz, lit, straw) {
    const g = straw ? [0.52, 0.47, 0.20] : [0.20, 0.36, 0.08];
    const v = rand(0.75, 1.25);
    this.flakes.spawn(x, y, z, vx, vy, vz, KIND.LEAF, rand(0.09, 0.2), g[0] * v, g[1] * v, g[2] * v, rand(2.2, 4.5), lit, rand(0.16, 0.34));
  }
  _pebble(x, y, z, vx, vy, vz, lit, sand) {
    const v = rand(0.6, 1.15);
    // grit off the beach; chips of shale and sandstone off the rock
    const c = sand ? [0.62, 0.55, 0.42] : Math.random() < 0.55 ? [0.25, 0.245, 0.25] : [0.44, 0.38, 0.29];
    const size = sand ? rand(0.02, 0.05) : 0.05 + 0.24 * Math.pow(Math.random(), 2.6);
    this.flakes.spawn(x, y, z, vx, vy, vz, KIND.PEBBLE, size, c[0] * v, c[1] * v, c[2] * v, rand(2.0, 3.6), lit, rand(0.7, 1));
  }

  update(dt, t, flight, camera, sunVis, res, reversed) {
    this.time = t;
    const T = this.terrain, sp = this._sp;
    const env = this.env;
    const f = flight.fwd, p = flight.pos, v = flight.vel;
    // right vector (level)
    const rl = Math.hypot(f.x, f.z) || 1;
    const rx = -f.z / rl, rz = f.x / rl;
    const speedK = clamp(flight.speed / 33, 0.35, 2.4);
    const sun = uSun(sunVis);
    const lit = 0.25 + 0.75 * sunVis;

    // ---- what is under the broom?
    const below = this.classify(p.x, p.z, sp);
    const near = clamp(1 - (flight.agl - 0.9) / 7.5, 0, 1);
    const k = Math.pow(near, 1.5) * speedK;
    this.surface = near > 0 ? below : SURF.NONE;
    this.contact = k;

    if (k > 0.01) {
      // candidates scattered around the ground track
      const pick = (lat, back, lead = 0) => {
        const a = rand(-1, 1), b = rand(0, 1);
        const lx = a * lat, bx = -b * back + 1.5 + lead;
        return [p.x + rx * lx + (f.x / rl) * bx, p.z + rz * lx + (f.z / rl) * bx, lx];
      };
      if (below === SURF.FLOWERS || below === SURF.GRASS) {
        // they do not come off in a steady stream: the rate surges and slackens, and a good share
        // tear loose in tufts from one spot
        const pulse = 0.4 + 1.2 * (0.5 + 0.5 * Math.sin(t * 6.3 + 3 * Math.sin(t * 1.7))) * (0.6 + 0.4 * Math.sin(t * 2.9 + 1));
        // The petals in the air are the ones this pass is taking off the flowers (see strip.js):
        // more of them the faster we go, from a wider swath, most from the middle of it - and none
        // from flowers an earlier pass has already taken as much from.
        const wakeK = this.vortex ? this.vortex.strength : 13 * speedK, coreH = Math.max(flight.agl - 0.15, 0.3);
        const reach = 1.2 * stripWidth(wakeK, coreH);
        // (the count rises with speed less steeply than the ground covered does: a sprint already
        // takes a bigger share from a wider swath, and that is plenty of petals)
        let n = this._count(0, 190 * reach * (k / Math.sqrt(speedK)) * pulse, dt);
        if ((this._tuftT -= dt) <= 0 || !this._tuft) {
          this._tuftT = rand(0.05, 0.22);
          this._tuft = pick(reach * 0.7, 4.5, 1.2);
          this._tuftV = [rand(-3, 3), rand(1, 5.5), rand(-3, 3)];
        }
        for (let i = 0; i < n; i++) {
          const tuft = Math.random() < 0.35;
          let [x, z, off] = tuft ? this._tuft : pick(reach, 4.5, 1.2);
          if (tuft) { x += rand(-0.45, 0.45); z += rand(-0.45, 0.45); }
          const take = this.strip ? Math.max(0, this.strip.passAmount(off) - this.strip.at(x, z)) : 0.5;
          const s = this.classify(x, z, sp);
          if (s !== SURF.FLOWERS && s !== SURF.GRASS) continue;
          const gy = T.heightAt(x, z);
          // torn loose with little speed of their own: the vortices take it from here. A few are
          // flicked up and out hard enough to miss them altogether.
          const drag = rand(0.2, 0.6), flick = Math.random() < 0.12 ? rand(2, 5) : 0;
          const vx = v.x * drag + rand(-1.5, 1.5) + (tuft ? this._tuftV[0] : 0) + rx * rand(-1, 1) * flick;
          const vz = v.z * drag + rand(-1.5, 1.5) + (tuft ? this._tuftV[2] : 0) + rz * rand(-1, 1) * flick;
          const vy = rand(0.5, 3.0) + Math.max(v.y, 0) * 0.5 + (tuft ? this._tuftV[1] * 0.5 : 0) + flick;
          const dens = sp[0];
          // (at a sprint they are left far behind the camera within a second or two: no need to
          // keep simulating them as long)
          if (s === SURF.FLOWERS && Math.random() < (0.25 + dens * 0.75) * Math.min(1, take * 2.0)) this._petal(x, gy + rand(0.45, 0.95), z, vx, vy, vz, sp[1], lit, rand(3.5, 6.5) / (1 + 0.35 * Math.max(speedK - 1, 0)));
          else if (Math.random() < 0.2) this._leaf(x, gy + rand(0.2, 0.55), z, vx, vy, vz, lit, Math.random() < 0.3);
        }
        // pollen and seed fluff glinting in the air
        n = this._count(1, 26 * k, dt);
        for (let i = 0; i < n; i++) {
          const [x, z] = pick(2.2, 4);
          const gy = T.heightAt(x, z);
          this.sprites.spawn(x, gy + rand(0.3, 1.0), z, v.x * 0.4 + rand(-1, 1), rand(0.5, 2.5), v.z * 0.4 + rand(-1, 1), {
            type: SPR.BLOB, r: 1.0 * sun[0], g: 0.96 * sun[1], b: 0.78 * sun[2], alpha: 0.5, size: rand(0.03, 0.07), life: rand(1.5, 3.5), drag: 1.6, grav: 0.4, add: 0.6,
          });
        }
      } else if (below === SURF.WATER) {
        const sy = flight.surfaceY;
        // rooster tails: two sheets thrown up and out to either side
        let n = this._count(2, 620 * k, dt);
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const lat = side * rand(0.05, 0.7 + flight.agl * 0.2);
          const back = rand(-0.5, 2.5);
          const x = p.x + rx * lat - (f.x / rl) * back, z = p.z + rz * lat - (f.z / rl) * back;
          const up = rand(2.0, 10.0) * (0.6 + 0.4 * k);
          const out = side * rand(1.5, 9.0);
          const dr = rand(0.45, 0.85);
          const b = rand(0.7, 1.25);
          this.sprites.spawn(x, sy + rand(0, 0.2), z, v.x * dr + rx * out, up, v.z * dr + rz * out, {
            type: SPR.DROP, r: 0.86 * sun[0] * b, g: 0.94 * sun[1] * b, b: 1.0 * sun[2] * b, alpha: rand(0.35, 0.85), size: rand(0.018, 0.06), life: rand(0.6, 1.6),
            drag: 0.8, grav: 9.8, stretch: 0.020, add: 0.8, wind: 0.5, wake: 1,
          });
        }
        // the body of the spray: soft clots that hide the gaps between beads
        n = this._count(11, 260 * k, dt);
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const lat = side * rand(0.0, 0.6), back = rand(0, 2);
          const x = p.x + rx * lat - (f.x / rl) * back, z = p.z + rz * lat - (f.z / rl) * back;
          this.sprites.spawn(x, sy + rand(0, 0.2), z, v.x * rand(0.5, 0.75) + rx * side * rand(1.0, 6.5), rand(1.5, 7.0), v.z * rand(0.5, 0.75) + rz * side * rand(1.0, 6.5), {
            type: SPR.BLOB, r: 0.82 * sun[0], g: 0.90 * sun[1], b: 0.96 * sun[2], alpha: rand(0.14, 0.30), size: rand(0.25, 0.55), grow: rand(0.8, 1.6), life: rand(0.5, 1.1),
            drag: 0.8, grav: 7.5, stretch: 0.014, add: 0.45, wind: 0.6,
          });
        }
        // spindrift: the finest spray is light enough to be wound up into the vortices, where it
        // shows them as two turning rings of beads and mist
        n = this._count(14, 900 * k, dt);
        for (let i = 0; i < n; i++) {
          const lat = rand(-2.4, 2.4), back = rand(-2.5, 3.0);
          const x = p.x + rx * lat - (f.x / rl) * back, z = p.z + rz * lat - (f.z / rl) * back;
          const b = rand(0.75, 1.2), dr = rand(0.3, 0.6);
          this.sprites.spawn(x, sy + rand(0.05, 0.45), z, v.x * dr + rx * lat * 0.8, rand(0.4, 3.2), v.z * dr + rz * lat * 0.8, {
            type: SPR.BLOB, r: 0.86 * sun[0] * b, g: 0.93 * sun[1] * b, b: 1.0 * sun[2] * b, alpha: rand(0.4, 0.85), size: rand(0.05, 0.13), life: rand(1.0, 2.4),
            drag: rand(14, 24), grav: 4.5, stretch: 0.006, add: 0.75,
          });
        }
        n = this._count(24, 110 * k, dt);
        for (let i = 0; i < n; i++) {
          const lat = rand(-2.2, 2.2), back = rand(-2, 3);
          const x = p.x + rx * lat - (f.x / rl) * back, z = p.z + rz * lat - (f.z / rl) * back;
          this.sprites.spawn(x, sy + rand(0.1, 0.6), z, v.x * 0.5, rand(0.3, 2.0), v.z * 0.5, {
            type: SPR.PUFF, r: 0.82 * sun[0], g: 0.90 * sun[1], b: 0.96 * sun[2], alpha: rand(0.07, 0.15), size: rand(0.25, 0.5), grow: rand(0.7, 1.3), life: rand(1.0, 2.0),
            drag: rand(12, 18), grav: 1.5, add: 0.3, stretch: 0.04,
          });
        }
        // mist hanging behind (too heavy with water to be carried far)
        n = this._count(3, 60 * k, dt);
        for (let i = 0; i < n; i++) {
          const lat = rand(-1.6, 1.6), back = rand(0, 3);
          const x = p.x + rx * lat - (f.x / rl) * back, z = p.z + rz * lat - (f.z / rl) * back;
          this.sprites.spawn(x, sy + rand(0.2, 1.0), z, v.x * rand(0.15, 0.4) + rx * lat * 1.2, rand(0.8, 3.0), v.z * rand(0.15, 0.4) + rz * lat * 1.2, {
            type: SPR.PUFF, r: 0.80 * sun[0], g: 0.88 * sun[1], b: 0.94 * sun[2], alpha: rand(0.08, 0.17), size: rand(0.8, 1.5), grow: rand(3.0, 5.5), life: rand(1.4, 2.8), drag: 1.4, add: 0.25, wake: 0.3,
          });
        }
      } else if (below === SURF.ROCK || below === SURF.SAND) {
        const sand = below === SURF.SAND;
        this._dust(dt, 4, k, p.x, p.z, rx, rz, f.x / rl, f.z / rl, v, sun, lit, sand, flight.agl);
      }
    }

    // ---- walls: the nearest rock at our own height, all around. Scraping past a cliff, or diving
    // down its face, tears dust and chips off it and drags them along in the slipstream.
    const fxh = f.x / rl, fzh = f.z / rl;
    const reach = 10 + 16 * clamp(-v.y / 40, 0, 1);       // a fast dive disturbs the face from further out
    let wall = 0;
    for (let i = 0; i < 8; i++) {
      const a = i * 0.7853981634 + 0.3926990817;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fxh * ca + rx * sa, dz = fzh * ca + rz * sa;
      let hit = -1;
      for (let d = 1.4; d <= reach; d += 1.2) {
        if (T.heightAt(p.x + dx * d, p.z + dz * d) > p.y - 0.4) { hit = d; break; }
      }
      if (hit < 0) continue;
      const wx = p.x + dx * hit, wz = p.z + dz * hit;
      if (this.classify(wx, wz, sp) !== SURF.ROCK) continue;
      const kk = Math.pow(1 - (hit - 1.4) / reach, 1.4) * speedK;
      wall = Math.max(wall, kk);
      const m = this._count(16 + i, 150 * kk, dt);
      if (!m) continue;
      const n = T.normalAt(wx, wz, this._n, 2.5);
      const nl = Math.hypot(n.x, n.z) || 1;
      const nx = n.x / nl, nz = n.z / nl;
      for (let j = 0; j < m; j++) {
        // a spot on the face: back off the probe's last step, spread along the wall, up and down it,
        // and a little ahead of us as well as behind
        const al = rand(-2.6, 2.6), lead = rand(-2.5, 3.5);
        const ox = wx - dx * 1.0 - nz * al + fxh * lead, oz = wz - dz * 1.0 + nx * al + fzh * lead;
        const oy = p.y + rand(-2.6, 2.6) + f.y * lead;
        if (T.heightAt(ox, oz) > oy + 1.5) continue;      // that spot is inside the rock
        const pickK = Math.random();
        if (pickK < 0.24) {
          const dr = rand(0.45, 0.9);
          this._pebble(ox, oy, oz, v.x * dr + nx * rand(1.5, 7), v.y * dr + rand(-1, 4.5), v.z * dr + nz * rand(1.5, 7), lit, false);
        } else if (pickK < 0.48) {
          const dr = rand(0.5, 0.92);
          this._puff(ox + nx * 0.4, oy, oz + nz * 0.4, v.x * dr + nx * rand(0.5, 3), v.y * dr + rand(0, 1.6), v.z * dr + nz * rand(0.5, 3), sun, false);
        } else if (pickK < 0.74) {
          this._wisp(ox + nx * 0.5, oy, oz + nz * 0.5, v.x * 0.6 + nx * rand(0.5, 3), v.y * 0.6, v.z * 0.6 + nz * rand(0.5, 3), sun, false);
        } else {
          this._grit(ox + nx * 0.3, oy, oz + nz * 0.3, v.x * 0.5 + nx * rand(1, 4), v.y * 0.5 + rand(-1, 2), v.z * 0.5 + nz * rand(1, 4), lit, false);
        }
      }
    }
    if (wall > this.contact) { this.contact = wall; this.surface = SURF.ROCK; }

    // ---- along the trail: where the shed vortices rake the surface behind us they keep lifting
    // whatever is there, for as long as they have the strength
    const vw = this.vortex;
    if (vw && vw.count > 4) {
      const span = Math.min(vw.count - 1, 110);
      const m = this._count(13, 2.0 * span, dt);
      const c = this._c;
      for (let j = 0; j < m; j++) {
        const r = 2 + ((Math.random() * (span - 2)) | 0);
        const side = Math.random() < 0.5 ? -1 : 1;
        const i = vw.core(r, side, c);
        const gw = vw.groundWind(i, side);
        if (gw < 4.5 || Math.random() > gw / 16) continue;
        // a spot under the core or just outboard of it, where the air turns upward
        const off = side * rand(-0.7, 1.9), al = rand(-1.2, 1.2);
        const lx = vw.lx[i], lz = vw.lz[i];
        const x = c.x + lx * off + lz * al, z = c.z + lz * off - lx * al;
        const s = this.classify(x, z, sp);
        const ox = lx * side * rand(0, 2), oz = lz * side * rand(0, 2);
        if (s === SURF.FLOWERS || s === SURF.GRASS) {
          const gy = T.heightAt(x, z);
          const take = this.strip ? Math.max(0, this.strip.stationAmount(r, x, z) - this.strip.at(x, z)) : 0.5;
          if (s === SURF.FLOWERS && Math.random() < (0.3 + sp[0] * 0.7) * Math.min(1, take * 2.0)) this._petal(x, gy + rand(0.45, 0.95), z, ox, rand(0.4, 2.2), oz, sp[1], lit);
          else if (Math.random() < 0.3) this._leaf(x, gy + rand(0.2, 0.5), z, ox, rand(0.4, 2.0), oz, lit, Math.random() < 0.3);
        } else if (s === SURF.WATER) {
          const sy = this.surfaceAt(x, z), b = rand(0.75, 1.2);
          this.sprites.spawn(x, sy + rand(0.05, 0.3), z, ox, rand(0.3, 2.2), oz, {
            type: SPR.BLOB, r: 0.86 * sun[0] * b, g: 0.93 * sun[1] * b, b: 1.0 * sun[2] * b, alpha: rand(0.2, 0.5), size: rand(0.035, 0.10), life: rand(0.8, 1.8),
            drag: rand(14, 24), grav: 4.5, stretch: 0.006, add: 0.75,
          });
        } else if (Math.random() < 0.6) {
          const gy = T.heightAt(x, z), sand = s === SURF.SAND, q = Math.random();
          if (q < 0.2) this._pebble(x, gy + 0.08, z, ox * 2, rand(1, 4), oz * 2, lit, sand);
          else if (q < 0.4) this._puff(x, gy + 0.3, z, ox, rand(0.3, 1.6), oz, sun, sand);
          else if (q < 0.7) this._wisp(x, gy + 0.25, z, ox, rand(0.3, 1.5), oz, sun, sand);
          else this._grit(x, gy + 0.1, z, ox, rand(0.5, 2.5), oz, lit, sand);
        }
      }
    }

    // ---- the swirl itself, drawn as wind lines winding round the two cores: a hint of them at a
    // cruise, unmistakable at a sprint
    if (vw && vw.count > 3) {
      const kS = clamp((vw.strength - 7) / 20, 0, 1.3);
      const m = this._count(15, 170 * kS, dt);
      const c = this._c, o = this._o || (this._o = [0, 0, 0, 0]);
      // only in the pocket of air still travelling with the broom: further back the lines would
      // be left behind and smear into long needles
      let span = 1;
      while (span < vw.count - 1 && span < 40 && vw.age[(vw.head - span + VORTEX.N) % VORTEX.N] < 0.26) span++;
      for (let j = 0; j < m; j++) {
        const r = (Math.random() * span) | 0;
        const i = vw.core(r, Math.random() < 0.5 ? -1 : 1, c);
        // a point on or about the ring of air that core carries, in the plane across the trail
        const a = rand(6.2831853), rad = vw.r0[i] * rand(0.6, 1.4);
        const cy = Math.cos(a) * rad, cz = Math.sin(a) * rad;
        const x = c.x + vw.lx[i] * cy + vw.ux[i] * cz, y = c.y + vw.uy[i] * cz, z = c.z + vw.lz[i] * cy + vw.uz[i] * cz;
        if (y < this.surfaceAt(x, z) + 0.15) continue;
        vw.sample(x, y, z, o);
        this.sprites.spawn(x, y, z, o[0], o[1], o[2], {
          type: SPR.STREAK, r: sun[0], g: sun[1], b: sun[2], alpha: rand(0.10, 0.26) * (0.45 + kS), size: rand(0.025, 0.05), life: rand(0.35, 0.8),
          drag: 14, wind: 0, wake: 1, stretch: 0.075, add: 1,
        });
      }
    }

    // ---- ambient: petals let go on the gusts all around the camera
    {
      const n = this._count(12, 34, dt);
      for (let i = 0; i < n; i++) {
        const a = rand(6.2831853), r = rand(4, 46);
        const x = camera.position.x + Math.cos(a) * r + f.x * 22, z = camera.position.z + Math.sin(a) * r + f.z * 22;
        if (this.classify(x, z, sp) !== SURF.FLOWERS || Math.random() > this._petalsLeft(x, z)) continue;
        if (Math.random() > 0.3 + 0.7 * this.gustAt(x, z)) continue;
        const gy = T.heightAt(x, z);
        const w = this.windAt(x, gy + 1, z, this.env._w3 || (this.env._w3 = [0, 0, 0]));
        this._petal(x, gy + rand(0.6, 1.0), z, w[0] * 0.5, rand(0.6, 2.4), w[2] * 0.5, sp[1], lit, rand(5, 9));
      }
    }

    // ---- speed streaks in the air ahead
    {
      const sk = clamp((flight.speed - 36) / 30, 0, 1.4);
      const n = this._count(10, 70 * sk, dt);
      for (let i = 0; i < n; i++) {
        const a = rand(6.2831853), r = rand(2.2, 11);
        const d = rand(18, 60);
        const ux = rx * Math.cos(a) * r, uy = Math.sin(a) * r * 0.7 + 1.0, uz = rz * Math.cos(a) * r;
        const x = p.x + f.x * d + ux, y = p.y + f.y * d + uy, z = p.z + f.z * d + uz;
        if (y < this.surfaceAt(x, z) + 0.4) continue;
        this.sprites.spawn(x, y, z, 0, 0, 0, {
          type: SPR.STREAK, r: sun[0], g: sun[1], b: sun[2], alpha: rand(0.05, 0.13) * sk, size: rand(0.02, 0.05), life: rand(0.35, 0.7), drag: 0, wind: 0, stretch: 0.085, add: 1,
        });
      }
    }

    // ---- simulate + ribbons
    this.flakes.update(dt, t, env);
    const cv = this._v.copy(camera.position).sub(this._prevCam).multiplyScalar(1 / Math.max(dt, 1e-4));
    if (cv.lengthSq() > 250 * 250) cv.set(0, 0, 0);
    this.sprites.camVel.copy(cv);
    this._prevCam.copy(camera.position);
    this.sprites.update(dt, t, env, camera, res, reversed);
  }

  _puff(x, y, z, vx, vy, vz, sun, sand) {
    // sunlit dust is pale; it billows out and hangs in the slipstream
    const c = sand ? [0.84, 0.76, 0.58] : [0.66, 0.60, 0.52];
    const b = rand(0.75, 1.05) * 0.78;
    this.sprites.spawn(x, y, z, vx, vy, vz, {
      type: SPR.PUFF, r: c[0] * sun[0] * b, g: c[1] * sun[1] * b, b: c[2] * sun[2] * b, alpha: rand(0.16, 0.36), size: rand(0.7, 1.5), grow: rand(3.4, 6.8), life: rand(1.6, 3.4), drag: 1.6, add: 0, wake: 0.25,
    });
  }
  /** A small tatter of dust, light enough for the wake vortices to wind up. */
  _wisp(x, y, z, vx, vy, vz, sun, sand) {
    const c = sand ? [0.84, 0.76, 0.58] : [0.66, 0.60, 0.52];
    const b = rand(0.75, 1.05) * 0.8;
    this.sprites.spawn(x, y, z, vx, vy, vz, {
      type: SPR.PUFF, r: c[0] * sun[0] * b, g: c[1] * sun[1] * b, b: c[2] * sun[2] * b, alpha: rand(0.08, 0.17), size: rand(0.25, 0.5), grow: rand(0.8, 1.4), life: rand(0.9, 1.9), drag: rand(12, 18), grav: 0.6, add: 0, stretch: 0.045,
    });
  }
  /** Grit: flecks of stone and sand that fly like chaff and trace the swirl. */
  _grit(x, y, z, vx, vy, vz, lit, sand) {
    const c = sand ? [0.70, 0.62, 0.46] : Math.random() < 0.5 ? [0.34, 0.33, 0.33] : [0.50, 0.44, 0.34];
    const v = rand(0.75, 1.2);
    this.flakes.spawn(x, y, z, vx, vy, vz, KIND.LEAF, rand(0.035, 0.085), c[0] * v, c[1] * v, c[2] * v, rand(1.4, 3.0), lit, rand(0.6, 1.0));
  }
  _dust(dt, slot, k, px, pz, rx, rz, fx, fz, v, sun, lit, sand, agl) {
    const T = this.terrain;
    let n = this._count(slot, (sand ? 230 : 200) * k, dt);
    for (let i = 0; i < n; i++) {
      const lat = rand(-2.3, 2.3), back = rand(-2.5, 4);
      const x = px + rx * lat - fx * back, z = pz + rz * lat - fz * back;
      const gy = T.heightAt(x, z);
      if (gy < 0.3) continue;
      const dr = rand(0.12, 0.4), q = Math.random();
      if (q < 0.18) this._pebble(x, gy + 0.08, z, v.x * dr * 1.4 + rx * lat * 1.2, rand(1.5, 6), v.z * dr * 1.4 + rz * lat * 1.2, lit, sand);
      else if (q < 0.34) { const dq = rand(0.45, 0.85); this._puff(x, gy + 0.3, z, v.x * dq + rx * lat * 0.6, rand(0.5, 2.4), v.z * dq + rz * lat * 0.6, sun, sand); }
      else if (q < 0.60) this._wisp(x, gy + 0.25, z, v.x * 0.5, rand(0.3, 1.8), v.z * 0.5, sun, sand);
      else this._grit(x, gy + 0.1, z, v.x * dr + rand(-1, 1), rand(0.5, 3), v.z * dr + rand(-1, 1), lit, sand);
    }
  }

  /** Light arriving on small bright things (spray, mist) for a given sun visibility. */
  sunTint(vis) { return uSun(vis); }

  /** Bristle trails: call after the rider's matrices are current. */
  updateRibbons(dt, left, right, camPos, strength) {
    this.ribbons[0].update(dt, left, camPos, 0.11, strength);
    this.ribbons[1].update(dt, right, camPos, 0.11, strength);
  }

  /** A dive lands: whatever is underneath is thrown outward in a ring. hit = how hard (m/s). */
  slam(flight, hit, sunVis) {
    const T = this.terrain, sp = this._sp, p = flight.pos, v = flight.vel;
    const sun = uSun(sunVis), lit = 0.25 + 0.75 * sunVis;
    const n = Math.round(30 + 34 * hit);
    for (let i = 0; i < n; i++) {
      const a = rand(6.2831853), r = rand(0.4, 3.2), sp0 = rand(3, 5 + 2.2 * hit);
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = p.x + ca * r + v.x * 0.03, z = p.z + sa * r + v.z * 0.03;
      const vx = ca * sp0 + v.x * 0.35, vz = sa * sp0 + v.z * 0.35, vy = rand(0.8, 2.5 + hit * 0.6);
      const s = this.classify(x, z, sp);
      if (s === SURF.WATER) {
        const sy = this.surfaceAt(x, z), b = rand(0.75, 1.2);
        this.sprites.spawn(x, sy + 0.1, z, vx, vy * 1.6, vz, {
          type: i % 3 ? SPR.DROP : SPR.BLOB, r: 0.86 * sun[0] * b, g: 0.93 * sun[1] * b, b: 1.0 * sun[2] * b, alpha: rand(0.4, 0.85), size: rand(0.03, 0.10), life: rand(0.7, 1.6),
          drag: i % 3 ? 0.8 : rand(14, 24), grav: i % 3 ? 9.8 : 4.5, stretch: i % 3 ? 0.02 : 0.006, add: 0.8, wind: 0.5, wake: 1,
        });
        continue;
      }
      const gy = T.heightAt(x, z);
      if (s === SURF.FLOWERS && Math.random() < (0.3 + sp[0] * 0.7) * this._petalsLeft(x, z)) this._petal(x, gy + rand(0.4, 0.9), z, vx, vy, vz, sp[1], lit);
      else if (s === SURF.FLOWERS || s === SURF.GRASS) this._leaf(x, gy + rand(0.2, 0.5), z, vx, vy, vz, lit, Math.random() < 0.3);
      else if (i % 3 === 0) this._pebble(x, gy + 0.08, z, vx, vy * 1.5, vz, lit, s === SURF.SAND);
      else if (i % 3 === 1) this._wisp(x, gy + 0.25, z, vx, vy * 0.5, vz, sun, s === SURF.SAND);
      else this._grit(x, gy + 0.1, z, vx, vy, vz, lit, s === SURF.SAND);
    }
  }

  /** A burst (collecting a seed, bouncing off a wall...). */
  burst(x, y, z, n, species, lit, speed = 6) {
    for (let i = 0; i < n; i++) {
      const a = rand(6.2831853), u = rand(-1, 1), s = Math.sqrt(1 - u * u) * rand(0.3, 1) * speed;
      this._petal(x, y, z, Math.cos(a) * s, u * speed * 0.8 + 2, Math.sin(a) * s, species, lit, rand(2.5, 5));
    }
  }
}

function uSun(vis) {
  const s = U.uSunColor.value, a = U.uAmbSky.value;
  // light arriving on a small bright thing: sun + sky
  const k = 0.30 * (0.2 + 0.8 * vis);
  return [s.x * k + a.x * 0.75, s.y * k + a.y * 0.75, s.z * k + a.z * 0.75];
}

export { SURF };
