// Petalwake — boot, frame loop, game state, debug hooks.
import * as THREE from 'three';
import { U, World, applyEnv } from './core/ctx.js';
import { Pipeline } from './core/pipeline.js';
import { Terrain, makeNoiseTexture } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Water } from './world/water.js';
import { CloudBaker } from './world/clouds.js';
import { Meadow } from './world/meadow.js';
import { Input } from './player/input.js';
import { Flight, SPEEDS } from './player/flight.js';
import { Rider } from './player/rider.js';
import { Catbus } from './player/catbus.js';
import { ChaseCamera } from './player/camera.js';
import { Wake } from './fx/wake.js';
import { VortexWake } from './fx/vortex.js';
import { Strip } from './fx/strip.js';
import { WindFX } from './fx/windfx.js';
import { Seeds } from './world/seeds.js';
import { River } from './world/river.js';
import { Props } from './world/props.js';
import { Town } from './world/town.js';
import { Places } from './world/places.js';
import { Sound } from './audio/audio.js';
import { Gameplay } from './game/index.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false, depth: false, stencil: false,
  powerPreference: 'high-performance', reversedDepthBuffer: true,
});
renderer.autoClear = true;
renderer.setClearColor(0x000000, 1);
renderer.toneMapping = THREE.NoToneMapping;
renderer.info.autoReset = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const camera = new THREE.PerspectiveCamera(64, 1, 0.3, 60000);
const world = new THREE.Scene();
const pipeline = new Pipeline(renderer);
// without a reversed depth buffer (no EXT_clip_control) pull the planes in to keep distant water stable
if (!pipeline.reversed) { camera.near = 1.2; camera.far = 40000; camera.updateProjectionMatrix(); }
const game = {
  renderer, camera, world, pipeline, U, World,
  time: 0, paused: false, ready: false, state: 'title', fov: 64,
};
window.PW = game;

let maxDpr = Number(params.get('dpr')) || 1.5;
function applyFov() {
  // hold the horizontal field of view on very wide screens instead of letting it balloon
  const baseV = game.fov, hLimit = 122;
  const hFov = 2 * Math.atan(Math.tan((baseV * Math.PI) / 360) * camera.aspect) * 180 / Math.PI;
  camera.fov = hFov > hLimit ? 2 * Math.atan(Math.tan((hLimit * Math.PI) / 360) / camera.aspect) * 180 / Math.PI : baseV;
  camera.updateProjectionMatrix();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  pipeline.setSize(w, h, dpr);
  camera.aspect = w / h;
  applyFov();
}
game.resize = resize;
window.addEventListener('resize', resize);

function setLoad(frac, msg) {
  $('loadFill').style.width = `${Math.round(frac * 100)}%`;
  if (msg) $('loadStatus').textContent = msg;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------- boot
async function boot() {
  $('title').classList.add('loading');
  applyEnv('afternoon');
  const noise = makeNoiseTexture();
  U.uNoiseTex.value = noise.texture;
  game.noise = noise;
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  U.uWakeTex.value = blank;
  U.uStripTex.value = blank;
  U.uShadowTex.value = blank;
  U.uTownSh0.value = blank;
  U.uTownSh1.value = blank;
  U.uTownMask0.value = blank;
  U.uTownMask1.value = blank;

  setLoad(0.08, 'raising the island…');
  const riderLoad = Rider.load(renderer);
  const catbusLoad = Catbus.load(renderer);
  const propsLoad = Props.load();
  const townLoad = Town.load(renderer);
  const terrain = (game.terrain = await Terrain.load(renderer));
  terrain.mainView.mesh.renderOrder = 500;
  world.add(terrain.mainView.mesh);
  await tick();

  setLoad(0.4, 'sowing the meadows…');
  const meadow = (game.meadow = new Meadow(terrain, params.get('q') || 'high'));
  world.add(meadow.group);

  const sky = (game.sky = new Sky());
  world.add(sky.mesh);
  const clouds = (game.clouds = new CloudBaker(renderer));
  clouds.begin();
  while (!clouds.done) {
    setLoad(0.45 + 0.4 * clouds.step(2), 'painting the sky…');
    await tick();
  }
  sky.cloudTex.value = clouds.texture;
  sky.cloudOn.value = 1;

  const water = (game.water = new Water(sky));
  water.setupReflection(renderer, terrain);
  world.add(water.mesh);
  const river = (game.river = new River(terrain, terrain.meta, sky));
  world.add(river.group);
  water.material.uniforms.uFallBase.value.set(river.fall.base.x, river.fall.base.z, river.fall.hw * 1.6);

  const props = (game.props = await propsLoad);
  world.add(props.group);
  if (props.overlay) pipeline.overlay.add(props.overlay);
  // the towns: buildings, their landing pads, and what the broom bumps into
  const town = (game.town = await townLoad);
  world.add(town.group);
  town.bakeShadows();
  // hidden places and their treasures (their models load later, as the rider comes near)
  const places = (game.places = await Places.load(renderer, terrain));
  world.add(places.group);
  pipeline.overlay.add(places.overlay);

  setLoad(0.9, 'waking the broom…');
  const rider = (game.rider = await riderLoad);
  const catbus = (game.catbus = await catbusLoad);
  pipeline.overlay.add(rider.group, rider.lights, catbus.group, catbus.beaconMesh);
  pipeline.overlay.environment = sky.bakeEnvironment(renderer);
  const vortex = (game.vortex = new VortexWake(terrain));
  vortex.river = river;
  game.wake = new Wake(renderer, vortex);
  game.strip = new Strip(renderer, vortex);
  const fx = (game.fx = new WindFX(terrain, noise, pipeline.uDepth));
  fx.vortex = vortex;
  fx.strip = game.strip;
  pipeline.overlay.add(fx.group);
  // the shore: tide lines, what clings to the rocks, and the crabs. Decoration only, so it is loaded
  // on its own: if the module or its assets fail, the game goes on without it.
  const shore = (game.shore = await import('./world/shore.js').then((m) => m.Shore.load(renderer, terrain)).catch((e) => (console.error(e), null)));
  if (shore) world.add(shore.attach({ camera, fx, water, town, overlay: pipeline.overlay }).group);
  const seeds = (game.seeds = new Seeds(terrain, terrain.meta));
  pipeline.overlay.add(seeds.group);
  $('seedTotal').textContent = seeds.total;
  game.sound = new Sound();

  game.input = new Input(canvas);
  const flight = (game.flight = new Flight(terrain));
  flight.river = river;
  flight.props = props;
  places.bind(game);                         // journal, pickups, and the broom bumps into their pieces too
  fx.river = river;
  { const c = titleCircuit(); flight.place(c.x - c.r, c.z, c.agl, 0); }
  game.chase = new ChaseCamera(camera, flight);
  game.chase.mode = 2;                       // the title screen watches from further back
  game.chase.dist = 14; game.chase.height = 4.2;
  game.gameplay = new Gameplay(game);        // landing pads, deliveries, the kickflip (asleep until game.town exists)
  {
    const c = titleCircuit();
    catbus.placeInitial(game, c.x - c.r * 0.62, c.z - 55, 130);
  }

  resize();
  setLoad(1);
  $('loadStatus').hidden = true;
  $('title').querySelector('.bar').hidden = true;
  game.ready = true;
  $('title').classList.remove('loading');
  $('start').hidden = false;
  $('keys').hidden = false;
  $('start').addEventListener('click', start);
  if (params.has('debug')) $('title').classList.add('gone');
  if (params.has('play')) start();
  requestAnimationFrame(frame);
}

function start() {
  if (game.state === 'play') return;
  game.state = 'play';
  game.input.enabled = true;
  game.chase.mode = 0;
  game.chase.orbit = 0;                      // (the title's sidelong view swings round behind her)
  game.sound.start();
  $('title').classList.add('gone');
  $('hud').hidden = false;
  // (where the lock is refused - an embedded frame, say - the keyboard still flies the broom)
  canvas.requestPointerLock?.()?.catch?.(() => {});
}

// ---------------------------------------------------------------------------------- loop
let last = 0;
// Adaptive resolution: if the machine cannot hold the frame rate, render fewer pixels rather than
// drop frames; climb back when there is headroom. Steps are coarse and rare (each one reallocates).
const SCALES = [1, 0.85, 0.72, 0.6, 0.5];
const auto = { i: 0, acc: 0, n: 0, hold: 3, good: 0, on: !params.has('noscale') && !params.has('debug') };
function autoScale(rawDt) {
  if (!auto.on || rawDt > 0.25) return;          // ignore hitches (tab switches, loading)
  auto.acc += rawDt; auto.n++;
  if (auto.acc < 1.5) return;
  const avg = auto.acc / auto.n;
  auto.acc = 0; auto.n = 0;
  if (auto.hold > 0) { auto.hold--; return; }
  let next = auto.i;
  if (avg > 1 / 48 && auto.i < SCALES.length - 1) next++;
  else if (avg < 1 / 58 && auto.i > 0 && auto.good++ > 4) next--;
  if (avg >= 1 / 58) auto.good = 0;
  if (next !== auto.i) {
    auto.i = next; auto.hold = 2; auto.good = 0;
    pipeline.scale = SCALES[next];
    resize();
  }
}
game.auto = auto;
function frame(now) {
  requestAnimationFrame(frame);
  if (game.capturing) return;
  const raw = (now - last) / 1000 || 0.016;
  const dt = Math.min(raw, 0.05);
  last = now;
  autoScale(raw);
  if (!game.paused) step(dt);
  render(dt);
}

/** Where the title screen's broom circles: round the main town when there is one. */
function titleCircuit() {
  const t = (game.terrain.meta.towns || []).find((q) => q.id === 'larkhaven');
  return t && game.town && game.town.towns.length ? { x: t.x, z: t.z + 30, r: 235, agl: 30 } : { x: 120, z: -820, r: 420, agl: 9 };
}

/** Title screen: the broom flies itself in a lazy circuit over the meadows. */
const pilot = { turn: 0, pitch: 0, boost: false, brake: false };
function autopilot() {
  const f = game.flight, t = game.time;
  const wantAgl = titleCircuit().agl * (1 + 0.3 * Math.sin(t * 0.21));
  pilot.pitch = THREE.MathUtils.clamp((wantAgl - f.agl) * 0.09 - f.pitch * 1.6, -1, 1);
  // circle the harbour town (or, with no town, a point on the north plateau), breathing in and out
  const c = titleCircuit();
  const cx = c.x, cz = c.z, R = c.r * (1 + 0.22 * Math.sin(t * 0.13));
  const dx = f.pos.x - cx, dz = f.pos.z - cz;
  const r = Math.hypot(dx, dz) || 1;
  // clockwise tangent (seen from above), corrected toward the ring
  const tx = -dz / r, tz = dx / r;
  const k = THREE.MathUtils.clamp((r - R) / 140, -1, 1);
  const wx = tx - (dx / r) * k, wz = tz - (dz / r) * k;
  let d = Math.atan2(wx, -wz) - f.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  pilot.turn = THREE.MathUtils.clamp(d * 1.3, -0.7, 0.7);
  // the camera rides on her outside shoulder and looks in across her, so the town is the backdrop
  if (c.r < 300) game.chase.orbit = 1.78 + 0.16 * Math.sin(t * 0.09);
  return pilot;
}

const _bl = new THREE.Vector3(), _br = new THREE.Vector3();
const _sp = [0, 0, 0, 0];
function advance(dt, ctl) {
  const t = game.time;
  const { flight, rider, chase, terrain, wake, fx, vortex } = game;
  game.gameplay.update(dt, ctl);             // may take the broom over (flight.auto) to land it
  flight.update(dt, ctl, t);
  rider.update(dt, t, flight, terrain);
  game.catbus?.syncRiderHop(dt, rider);
  if (flight.touchdown > 0) fx.slam(flight, flight.touchdown, rider.sunVis);
  // the wake: step the vortex simulation, then let it blow over the ground field
  vortex.update(dt, flight, t, fx.env.wind);
  wake.update(dt, flight);
  // (the title screen's self-flying broom leaves the meadow as it found it)
  if (game.state === 'play' || params.has('debug')) game.strip.update(dt);
  if (!game.freeCam) {
    chase.update(dt, t, (x, z) => flight.surfaceAt(x, z, t));
    game.fov = chase.fovOut;
  }
  if (game.rig && !game.freeCam) {
    // debug rig: camera offset in the rider's frame (right, up, back), looking at the rider
    const r = game.rig, f = flight.fwd, hl = Math.hypot(f.x, f.z) || 1;
    const rx = -f.z / hl, rz = f.x / hl;
    camera.position.set(flight.pos.x + rx * r[0] - (f.x / hl) * r[2], flight.pos.y + r[1], flight.pos.z + rz * r[0] - (f.z / hl) * r[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(flight.pos.x + (f.x / hl) * (r[3] || 0), flight.pos.y + (r[4] || 0), flight.pos.z + (f.z / hl) * (r[3] || 0));
    game.fov = r[5] || 60;
  }
  fx.update(dt, t, flight, camera, rider.sunVis, pipeline.size, pipeline.reversed);
  // slipstream trails: off the broom's bristle head, or off the catbus's rear roof-rail posts
  if (game.catbus && game.catbus.mounted) {
    game.catbus.group.updateMatrixWorld(true);
    _bl.set(-0.46, 2.55, 1.48).applyMatrix4(game.catbus.group.matrixWorld);
    _br.set(0.46, 2.55, 1.48).applyMatrix4(game.catbus.group.matrixWorld);
  } else {
    rider.group.updateMatrixWorld(true);
    _bl.set(-0.17, -0.02, 1.16).applyMatrix4(rider.group.matrixWorld);
    _br.set(0.17, -0.02, 1.16).applyMatrix4(rider.group.matrixWorld);
  }
  const trail = THREE.MathUtils.clamp((flight.speed - 34) / 26, 0, 1) * 0.42 + flight.boosting * 0.5;
  fx.updateRibbons(dt, _bl, _br, camera.position, trail);
  game.river.update(dt, fx.sprites, camera.position, fx.sunTint(rider.sunVis));
  // wind seeds
  const got = game.seeds.update(dt, flight.pos);
  if (got) {
    const n = game.seeds.count, total = game.seeds.total;
    game.sound.chime(n - 1);
    terrain.splatAt(got.x, got.z, _sp);
    fx.burst(got.x, got.y, got.z, 90, _sp[1], 0.3 + 0.7 * rider.sunVis, 9);
    flight.gust = Math.min(1, flight.gust + 0.4);
    $('seedCount').textContent = n;
    if (n === total) toast('every seed caught — the whole island is on the wind');
    else if (n === 1) toast('a wind seed — there are more out there');
    else if (n % 6 === 0) toast(`${total - n} seeds still adrift`);
  }
  game.places.update(dt, flight, t);
  game.town.ambient(dt, fx, camera);
  game.shore?.update(dt, flight, t);
  U.uRider.value.set(flight.pos.x, flight.pos.y, flight.pos.z, flight.speed);
  U.uRiderVel.value.copy(flight.vel);
  pipeline.params.speed = THREE.MathUtils.clamp((flight.speed - 30) / 45, 0, 1);
  game.onStep?.(dt);
}

function step(dt) {
  game.time += dt;
  U.uTime.value = game.time;
  const { input, chase } = game;
  input.update(dt);
  if (game.state === 'play') {
    if (input.take('KeyC')) toast(`camera · ${chase.next()}`);
    if (input.take('KeyI')) { input.invert = !input.invert; toast(input.invert ? 'pitch inverted' : 'pitch normal'); }
    if (input.take('KeyP')) $('hud').classList.toggle('quiet');
    if (input.take('KeyM')) toast(game.sound.toggleMute() ? 'sound off' : 'sound on');
  }
  advance(dt, game.override || (game.state === 'play' ? input : autopilot()));
  applyFov();
  const f = game.flight;
  game.sound.update(dt, { speed: f.speed, boosting: f.boosting, contact: game.fx.contact, surface: game.fx.surface, roll: f.roll, shore: Math.max(shoreNear(dt), (game.river.near || 0) * 1.6), agl: f.agl * (game.river.near > 0.2 ? 0.2 : 1) });
  hud(dt);
}

function render(dt) {
  // a window with no size yet (hidden, minimised) has no render targets: wait for one
  if (!pipeline.sceneRT) { resize(); if (!pipeline.sceneRT) return; }
  camera.updateMatrixWorld();
  U.uCamPos.value.copy(camera.position);
  if (game.catbus && game.catbus.mounted) {
    const cb = game.catbus;
    game.rider.renderShadow(pipeline.reversed, cb.group, 4.8, () => cb.rig.setShadowMode(true), () => cb.rig.setShadowMode(false));
  } else {
    game.rider.renderShadow(pipeline.reversed);
  }
  game.water.renderReflection(camera, pipeline.size);
  game.terrain.select(game.terrain.mainView, camera);
  game.meadow.update(camera);
  game.town.update(dt, U.uTime.value, camera);
  game.water.update(camera);
  renderer.info.reset();
  pipeline.render(world, camera, dt);
  game.stats = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, nodes: game.terrain.mainView.count, ...game.meadow.stats, flakes: game.fx.flakes.count, sprites: game.fx.sprites.count };
}
game.step = step;
game.renderOnce = (dt = 1 / 60) => render(dt);

// ---------------------------------------------------------------------------------- hud
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  toastTimer = 2.2;
}
game.toast = toast;
let hudAcc = 0, placeNow = '', placeShown = '', placeHold = 0, shoreK = 0, shoreAcc = 0;
/** 0..1: how close the sea is (drives the surf sound). */
function shoreNear(dt) {
  shoreAcc += dt;
  if (shoreAcc > 0.4) {
    shoreAcc = 0;
    const p = game.flight.pos, T = game.terrain;
    let sea = T.heightAt(p.x, p.z) < 0.5 ? 1 : 0;
    for (let i = 0; i < 6 && !sea; i++) { const a = i * 1.047; if (T.heightAt(p.x + Math.cos(a) * 170, p.z + Math.sin(a) * 170) < 0) sea = 0.6; }
    shoreK += (sea - shoreK) * 0.25;
  }
  return shoreK;
}
function placeName() {
  const p = game.flight.pos, m = game.terrain.meta, T = game.terrain;
  const ground = T.heightAt(p.x, p.z);
  const town = game.town.nameAt(p.x, p.z);
  if (town) return town;
  if (Math.hypot(p.x - m.peak[0], p.z - m.peak[2]) < 240 && p.y > m.peak[1] - 110) return "Wren's Crown";
  for (let i = 0; i < m.fjord.length - 1; i++) {
    const a = m.fjord[i], b = m.fjord[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.z - a[1]) * dz) / (dx * dx + dz * dz)));
    if (Math.hypot(p.x - a[0] - dx * t, p.z - a[1] - dz * t) < a[2] + 30 && p.y < 170) return 'Hollowmere Sound';
  }
  if (ground < 0.5) {
    if (Math.hypot(p.x - m.lagoon[0], p.z - m.lagoon[1]) < m.lagoon[2] + 120) return 'Lace Bay';
    for (const s of m.stacks) if (Math.hypot(p.x - s[0], p.z - s[1]) < 190) return 'The Sisters';
    return p.z < -900 ? 'The Shale Coast' : 'The Open Blue';
  }
  if (Math.hypot(p.x - m.mountain[0], p.z - m.mountain[1]) < 950 && ground > 165) return 'Mount Wren';
  if (ground < 5) return 'Longstrand';
  if (p.x < -950 && p.z < -500) return 'Lantern Head';
  if (p.z < -330) return 'Cosmos Down';
  if (p.x < -700) return 'The Westbowl';
  return 'Southmeadow';
}
function hud(dt) {
  if (toastTimer > 0 && (toastTimer -= dt) <= 0) $('toast').classList.remove('show');
  hudAcc += dt;
  if (hudAcc < 0.066) return;
  const step = hudAcc;
  hudAcc = 0;
  const f = game.flight;
  $('speed').textContent = Math.round(f.speed * 3.6);
  $('gustFill').style.width = `${Math.round(f.gust * 100)}%`;
  // compass to the nearest seed, relative to our heading
  const near = game.seeds.nearest(f.pos);
  const comp = $('compass');
  if (near) {
    const brg = Math.atan2(near.seed.x - f.pos.x, -(near.seed.z - f.pos.z)) - f.yaw;
    comp.firstElementChild.style.transform = `rotate(${(brg * 180) / Math.PI}deg)`;
    $('seedDist').textContent = `${Math.round(near.dist / 10) * 10} m`;
  } else comp.style.display = 'none';
  // place names: announce a new region once we have clearly settled into it
  if (game.state === 'play') {
    const name = placeName();
    if (name !== placeNow) { placeNow = name; placeHold = 0; }
    placeHold += step;
    if (placeHold > 1.2 && placeShown !== placeNow) {
      placeShown = placeNow;
      const el = $('place');
      el.classList.remove('show');
      setTimeout(() => { el.textContent = placeShown; el.classList.add('show'); }, 350);
    }
  }
}

// ---------------------------------------------------------------------------------- debug hooks
/** Free camera: position + yaw/pitch in degrees (yaw 0 looks north, +yaw turns east). */
game.view = (x, y, z, yaw = 0, pitch = 0) => {
  game.freeCam = true;
  camera.position.set(x, y, z);
  camera.rotation.set(0, 0, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = (-yaw * Math.PI) / 180;
  camera.rotation.x = (pitch * Math.PI) / 180;
  camera.updateMatrixWorld();
  game.fov = 64;
  pipeline.hasPrev = false;
  return [x, y, z];
};
game.viewAGL = (x, agl, z, yaw = 0, pitch = 0) => game.view(x, Math.max(game.terrain.heightAt(x, z), 0) + agl, z, yaw, pitch);
/** Put the rider (or mounted catbus) somewhere and let the chase camera follow again. */
game.fly = (x, z, agl = 6, yawDeg = 0, speed = SPEEDS.CRUISE, pitchDeg = 0) => {
  game.freeCam = false;
  game.wake.reset();
  game.vortex.reset();
  for (const r of game.fx.ribbons) r.reset();
  const f = game.flight;
  const cb = game.catbus;
  if (cb && cb.mounted) {
    const surf = f.coverAt(x, z, 0);
    cb.pos.set(x, surf + agl, z);
    cb.yaw = (yawDeg * Math.PI) / 180;
    cb.pitch = (pitchDeg * Math.PI) / 180;
    cb.roll = 0;
    cb.airSpeed = speed;
    cb.state = agl > 0.5 ? 'fly' : 'ground';
    cb.groundSpeed = agl > 0.5 ? 0 : speed;
    if (cb.state === 'fly') cb._enterFlyAnim(0.05); else cb._returnToGroundAnims(0.05);
    cb._updateFwd();
    cb.vel.copy(cb.fwd).multiplyScalar(speed);
    cb._syncToFlight(1 / 60, game.time, f);
    f._dir();
  } else {
    f.place(x, z, agl, yawDeg);
    f.speed = speed;
    f.pitch = (pitchDeg * Math.PI) / 180;
  }
  game.chase.snap();
  pipeline.hasPrev = false;
};
/** Run the sim for a while under a fixed control input (scripted captures). */
game.sim = (seconds, ctl = {}, dt = 1 / 60) => {
  const c = { turn: 0, pitch: 0, boost: false, brake: false, ...ctl };
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    game.time += dt;
    U.uTime.value = game.time;
    advance(dt, c);
  }
  applyFov();
  game.override = c;
  const f = game.flight;
  return { pos: f.pos.toArray().map((v) => +v.toFixed(1)), agl: +f.agl.toFixed(2), speed: +f.speed.toFixed(1), pitch: +f.pitch.toFixed(2) };
};
/**
 * Render at an exact size and save the frame to .shots/<name>.jpg through the dev server.
 * steps > 1 advances the simulation first (so motion blur and particles have history).
 */
game.shot = async (name = 'shot', w = 1920, h = 1080, steps = 2, dt = 1 / 60) => {
  game.capturing = true;
  const keepScale = pipeline.scale;
  pipeline.scale = 1;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    pipeline.setSize(w, h, 1);
    camera.aspect = w / h;
    applyFov();
    for (let i = 0; i < steps; i++) {
      if (!game.paused) step(dt);
      render(dt);
    }
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.93));
    const res = await fetch(`/__save/${name}.jpg`, { method: 'POST', body: blob });
    return `${name}.jpg ${res.status} ${blob.size}`;
  } finally {
    game.capturing = false;
    pipeline.scale = keepScale;
    resize();
  }
};

boot().catch((e) => {
  console.error(e);
  $('loadStatus').textContent = `failed to load: ${e.message}`;
});
