// Errands: landing on the town's pads, carrying parcels between them, and a trick.
//
// Everything to do with pads hangs off game.town - { pads, heightAt(x, z) }, see world/town.js -
// and is asleep while that has no pads: no beacons, nothing on the HUD, nothing in the flight
// model. The town may be assigned, swapped or grow more pads at any time; it is looked at afresh
// every step. ?padtest stands three plain towers and a shed up as well (padtest.js).
//
// main.js makes one of these and calls update() once a step, before the flight model moves.
// Debug hooks (on the game object, window.PW): land(padId?), takeoff(), kickflip(), padsNear().
import * as THREE from 'three';
import { buildPadTest } from './padtest.js';
import { Beacons } from './beacons.js';
import { Landing, LAND } from './landing.js';
import { findLandingSpot } from './surface.js';
import { Courier } from './courier.js';
import { Kickflip } from './tricks.js';
import { Hud } from './hud.js';

/** localStorage, where there is one (private windows and embeds may refuse). */
class Store {
  get(key, fallback) {
    try { const v = localStorage.getItem(`petalwake.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  }
  set(key, value) {
    try { localStorage.setItem(`petalwake.${key}`, JSON.stringify(value)); } catch { /* it lasts the visit */ }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Gameplay {
  constructor(game) {
    this.game = game;
    this.params = new URLSearchParams(location.search);
    this.debug = this.params.has('debug');
    this.store = new Store();
    this.hud = new Hud();
    this.fixture = this.params.has('padtest') ? buildPadTest(game.terrain) : null;
    if (this.fixture) game.world.add(this.fixture.group);
    this.town = undefined;        // game.town as last looked at, and how many pads it had
    this.nPads = -1;
    this.pads = [];               // every pad there is
    this.open = [];               // ...and those that can actually be flown on to (landing.way)
    this.beacons = null;
    this.zone = null;             // the pad that can be landed on right now
    this.hush = 0;                // seconds before a pad just left lights up again
    this.playing = false;
    this.intro = -1;
    this.courier = new Courier(game, this.store, this.hud);
    this.trick = new Kickflip(game, this.store, this.hud);
    this.landing = new Landing(game, {
      touch: (pad) => { if (pad && !pad.adhoc) this.courier.arrive(pad); },
      leave: () => { this.hush = 1.6; },
      broke: () => { this.hush = 0.9; },
    });
    if (this.trick.unlocked) this.hud.hint('flip', '<kbd>Q</kbd> kickflip');

    game.land = (id) => this.land(id);
    game.takeoff = () => this.landing.takeoff();
    game.kickflip = () => this.trick.start(true);
    game.padsNear = () => this.padsNear();
    this._bind();
    this._loadStand();
  }

  /** The standing rider, if the file is there (she sets the broom down and stays on it otherwise). */
  async _loadStand() {
    const base = './assets/models', name = this.params.get('stand') || 'rider_stand';
    try {
      // asking for a file that is not there writes an error to the console: where the server
      // lists its folders (the dev server does), look before asking
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
        const list = await fetch(`${base}/`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        if (list && !list.includes(`${name}.glb`)) return;
      }
      await this.game.rider.loadStand(base, name);
    } catch { /* no standing model */ }
  }

  /** game.town has changed: its buildings become solid, its pads come alive. */
  _bind() {
    const g = this.game, f = g.flight, town = g.town || null, fix = this.fixture;
    const real = town && Array.isArray(town.pads) ? town.pads : [];
    this.town = town;
    this.nPads = real.length;
    this.pads = fix ? [...real, ...fix.pads] : real.slice();

    // what the broom (and the camera) cannot fly through
    let solid = town && typeof town.heightAt === 'function' ? town : null;
    if (fix) solid = solid ? { heightAt: (x, z) => Math.max(town.heightAt(x, z), fix.heightAt(x, z)) } : fix;
    if (solid && (fix || !f.solid || f.solid === this._solid)) f.solid = this._solid = solid;
    // ...and what petals, dust and spray come down on: roofs as well as the land
    const env = g.fx.env;
    if (f.solid && !env._land) {
      env._land = env.surface;
      env.surface = (x, z) => { const h = env._land(x, z), S = f.solid; if (!S) return h; const s = S.heightAt(x, z); return s > h ? s : h; };
    }

    // a pad with something built across every way in is left out of it all (see landing.way)
    this.landing.forget();
    this.open = this.pads.filter((p) => this.landing.way(p));

    if (this.beacons) { g.pipeline.overlay.remove(this.beacons.group); this.beacons.dispose(); this.beacons = null; }
    if (this.open.length) {
      this.beacons = new Beacons(this.open);
      g.pipeline.overlay.add(this.beacons.group);
    }
    this.hud.hint('land', '<kbd>Space</kbd><kbd>Space</kbd> land');
    if (this.landing.busy && this.landing.pad && !this.landing.pad.adhoc && !this.open.includes(this.landing.pad)) this.landing.abort();
    this.zone = null;
    this.courier.setPads(this.open);
  }

  /** The landing zone: the nearest pad within reach (with a little stickiness, so two do not flicker). */
  _zone() {
    const f = this.game.flight, L = this.landing;
    if (L.busy) return L.pad && !L.pad.adhoc && L.state === 'descent' ? L.pad : null;
    if (this.hush > 0) return null;
    let best = null, bd = Infinity;
    for (const p of this.open) {
      const d = Math.hypot(p.pos.x - f.pos.x, p.pos.y - f.pos.y, p.pos.z - f.pos.z) - (p === this.zone ? 5 : 0);
      if (d < LAND.RANGE && d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Try to land at a nearby designated pad or on any valid flat-enough ground/roof below. */
  _tryLand() {
    const g = this.game, f = g.flight, L = this.landing;
    if (this.zone && L.begin(this.zone)) return true;
    const spot = findLandingSpot(g, f.pos, f.vel, f.yaw, {
      radius: 0.85,
      maxAgl: 25,
      maxClimb: 5.0,
      leadTime: 0.34,
      maxLead: 8.5,
    });
    if (!spot) {
      if (f.overWater) g.toast?.('only open water below');
      else if (f.agl > 25) g.toast?.('come lower to set down');
      else g.toast?.('too steep to land here');
      return false;
    }
    // Snap to an open perch if the chosen spot falls right onto it so parcel deliveries fire
    for (const p of this.open) {
      if (Math.hypot(p.pos.x - spot.x, p.pos.z - spot.z) < p.radius + 3.2 && Math.abs(p.pos.y - spot.y) < 2.2) {
        if (L.begin(p)) return true;
      }
    }
    return L.begin({
      id: null,
      name: null,
      adhoc: true,
      kind: spot.kind,
      pos: new THREE.Vector3(spot.x, spot.y, spot.z),
      radius: 1.4,
      yaw: f.yaw,
      approach: f.yaw,
    });
  }

  _prompt(play) {
    const L = this.landing;
    let html = null;
    if (play) {
      if (L.state === 'landed') html = '<kbd>Space</kbd> to take off';
      else if (L.state === 'descent' && L.pad && !L.pad.adhoc) html = `setting down at <em>${esc(L.pad.name)}</em>`;
      else if (L.state === 'fly' && this.zone) html = `<kbd>Space</kbd><span class="x2">×2</span> to land<em>${esc(this.zone.name)}</em>`;
    }
    this.hud.prompt(html);
  }

  /** Once a step, before the flight model moves. */
  update(dt, ctl) {
    const g = this.game, f = g.flight, L = this.landing;
    const town = g.town || null;
    if (town !== this.town || (town && Array.isArray(town.pads) ? town.pads.length : 0) !== this.nPads) this._bind();

    // keys are drained every step and acted on only while she is being flown
    const play = g.state === 'play', inp = g.input;
    const tapLand = inp.take('Space2'), tapSpace = inp.take('Space'), tapQ = inp.take('KeyQ');

    // the trick and the landing each pose the seated rider from a clean slate
    const seat = g.rider.seat;
    seat.hop = 0; seat.sy = 1; seat.flip = 0; seat.calm = 0;
    if (play && tapQ) this.trick.start();
    this.trick.update(dt);

    L.update(dt, ctl);
    if (this.hush > 0) this.hush -= dt;

    this.zone = (play || this.debug) && this.open.length ? this._zone() : null;
    if (play) {
      if (L.state === 'fly' && tapLand) this._tryLand();
      else if (L.landed && (tapSpace || tapLand)) L.takeoff();
      if (!this.playing && this.open.length) { this.playing = true; this.intro = 2.4; }
      if (this.intro > 0 && (this.intro -= dt) <= 0 && this.courier.target && !L.busy) {
        this.hud.card('a parcel for', this.courier.target.name, 'follow the gold light · Space twice to land', 5);
      }
    }
    if (this.beacons) this.beacons.update(dt, f.pos, this.zone, this.courier.target, L.pad && !L.pad.adhoc ? L.pad : null);
    if (this.open.length) this.courier.update(dt);
    this._prompt(play);
    this.hud.update(dt);
  }

  // ------------------------------------------------------------------------------- debug hooks
  /** Land on a pad (by id or name), or right here on valid ground/roof ('here' or omitted). */
  land(id) {
    const f = this.game.flight, L = this.landing;
    if (L.busy) return { ok: false, why: `busy (${L.state})` };
    if (id === 'here') {
      const ok = this._tryLand();
      return ok
        ? { ok: true, pad: L.pad.id || L.pad.kind, pos: L.pad.pos.toArray().map((v) => +v.toFixed(2)), dur: +L.dur.toFixed(2) }
        : { ok: false, why: 'no flat surface in reach' };
    }
    const d = (p) => Math.hypot(p.pos.x - f.pos.x, p.pos.y - f.pos.y, p.pos.z - f.pos.z);
    let pad = id ? this.pads.find((p) => p.id === id || p.name === id) : this.zone;
    if (!pad && !id) {
      if (this._tryLand()) {
        return { ok: true, pad: L.pad.id || L.pad.kind, pos: L.pad.pos.toArray().map((v) => +v.toFixed(2)), dur: +L.dur.toFixed(2) };
      }
      pad = [...this.open].sort((a, b) => d(a) - d(b))[0];
    }
    if (!pad) return { ok: false, why: 'no such pad' };
    if (!L.begin(pad, { force: !!id })) return { ok: false, why: 'no clear way in' };
    const P = L.path;
    return { ok: true, pad: pad.id, dist: +d(pad).toFixed(1), path: +P.len.toFixed(1), dur: +L.dur.toFixed(2), lift: +P.lift.toFixed(2), own: L.way(pad).own };
  }

  /** Every pad, nearest first. */
  padsNear() {
    const f = this.game.flight;
    return this.pads.map((p) => {
      const dist = Math.hypot(p.pos.x - f.pos.x, p.pos.y - f.pos.y, p.pos.z - f.pos.z);
      return { id: p.id, name: p.name, town: p.town, dist: +dist.toFixed(1), open: this.open.includes(p), inRange: dist < LAND.RANGE, zone: p === this.zone, target: p === this.courier.target };
    }).sort((a, b) => a.dist - b.dist);
  }
}
