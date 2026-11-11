// Landing surface detection across baked terrain, water, props, and town collision grids.
// Evaluates whether a spot (open meadow, hill, beach, street, quay, bridge, or rooftop) is
// flat enough, solid underfoot, clear of obstacles, and safely inset from sheer drops.
import * as THREE from 'three';

const NONE = -1e8;
const RING8 = (() => {
  const a = new Float32Array(16);
  for (let i = 0; i < 8; i++) {
    const th = (i * Math.PI) / 4;
    a[i * 2] = Math.cos(th);
    a[i * 2 + 1] = Math.sin(th);
  }
  return a;
})();

const _pos = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Raw supporting surface at (x, z), distinguishing built roofs/decks from natural ground
 * and rejecting open water.
 */
function sampleSupport(terrain, river, solid, x, z) {
  const th = terrain.heightAt(x, z);
  const rw = river ? river.levelAt(x, z) : -1e9;
  const sh = solid ? solid.heightAt(x, z) : -1e9;
  const waterY = Math.max(0.42, rw + 0.08);
  if (sh > NONE && sh > Math.max(th, rw) + 0.22) {
    if (sh < 0.45) return null;
    return { y: sh, kind: 'roof' };
  }
  if (th < waterY) return null;
  return { y: th, kind: 'ground' };
}

/**
 * Test a candidate landing point (x, z) for a footprint of `radius` metres.
 * Fits a local plane across an 8-point ring so gently pitched roofs and hillsides pass,
 * while roof edges, parapets, chimneys, cliffs, walls, props, and water are rejected.
 *
 * @returns { x, y, z, kind: 'ground'|'roof', slope, normal: THREE.Vector3, score } | null
 */
export function probeLandingSurface(game, x, z, opts = {}) {
  const terrain = game.terrain;
  if (!terrain) return null;
  const flight = game.flight;
  const river = flight?.river || game.river || null;
  const solid = flight?.solid || game.town || null;
  const props = flight?.props || game.props || null;

  const radius = opts.radius ?? 0.9;
  const maxGroundSlope = opts.maxGroundSlope ?? 0.62;   // ~32 deg
  const maxRoofSlope = opts.maxRoofSlope ?? 0.68;       // ~34 deg
  const maxResidual = opts.maxResidual ?? (opts.kind === 'roof' ? 0.42 : 0.48);
  const propRadius = opts.propRadius ?? Math.max(0.65, radius * 0.8);

  const c = sampleSupport(terrain, river, solid, x, z);
  if (!c) return null;

  // Sample outer footprint ring (and an inner half-radius check for larger creatures like the catbus)
  let gx = 0, gz = 0, mean = 0;
  const hs = _ringH;
  for (let i = 0; i < 8; i++) {
    const dx = RING8[i * 2] * radius, dz = RING8[i * 2 + 1] * radius;
    const s = sampleSupport(terrain, river, solid, x + dx, z + dz);
    if (!s) return null;
    // On open ground, disallow footprints that clip into the base of a building wall
    if (c.kind === 'ground' && s.kind === 'roof' && s.y > c.y + 0.45) return null;
    hs[i] = s.y;
    mean += s.y;
    gx += s.y * RING8[i * 2];
    gz += s.y * RING8[i * 2 + 1];
  }
  mean *= 0.125;
  gx /= 4 * radius;
  gz /= 4 * radius;

  const slope = Math.hypot(gx, gz);
  const maxSlope = c.kind === 'roof' ? maxRoofSlope : maxGroundSlope;
  if (slope > maxSlope) return null;

  // Center must sit cleanly on the fitted plane (rejects narrow chimney pots, spikes, or trenches)
  let maxErr = Math.abs(c.y - mean);
  if (maxErr > maxResidual) return null;

  for (let i = 0; i < 8; i++) {
    const pred = c.y + (gx * RING8[i * 2] + gz * RING8[i * 2 + 1]) * radius;
    const err = Math.abs(hs[i] - pred);
    if (err > maxErr) maxErr = err;
    // Stricter on downward drops from roofs so paws/boots stay well inside the eave
    const dropLimit = c.kind === 'roof' ? maxResidual * 0.9 : maxResidual * 1.15;
    if (hs[i] < pred - dropLimit || hs[i] > pred + maxResidual) return null;
  }

  if (radius >= 1.25) {
    const rIn = radius * 0.5;
    for (let i = 0; i < 8; i += 2) {
      const dx = RING8[i * 2] * rIn, dz = RING8[i * 2 + 1] * rIn;
      const s = sampleSupport(terrain, river, solid, x + dx, z + dz);
      if (!s) return null;
      const pred = c.y + (gx * dx + gz * dz);
      if (Math.abs(s.y - pred) > maxResidual) return null;
    }
  }

  // Reject spots occupied by trees, boulders, standing stones, or hidden-place props
  if (props) {
    _pos.set(x, c.y + propRadius + 0.25, z);
    if (props.collide(_pos, propRadius, _n)) return null;
  }

  const normal = new THREE.Vector3(-gx, 1, -gz).normalize();
  const score = slope * 1.6 + maxErr * 2.4;
  return { x, y: c.y, z, kind: c.kind, slope, normal, score };
}
const _ringH = new Float64Array(8);

/**
 * Check that the straight glide from (x0, y0, z0) to (x1, y1 + clearance, z1) does not pass
 * through a wall or cliff ridge standing between them.
 */
export function hasClearGlide(game, x0, y0, z0, x1, y1, z1, clearance = 0.75) {
  const terrain = game.terrain;
  const solid = game.flight?.solid || game.town || null;
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(2, Math.min(20, Math.ceil(dist / 1.1)));
  for (let i = 1; i < steps; i++) {
    const u = i / steps;
    const x = x0 + (x1 - x0) * u;
    const z = z0 + (z1 - z0) * u;
    // Slight upward arc allowance over the straight line
    const arcY = y0 + (y1 + clearance - y0) * u + Math.sin(u * Math.PI) * Math.min(1.4, dist * 0.10);
    let obs = terrain.heightAt(x, z);
    if (solid) {
      const sh = solid.heightAt(x, z);
      if (sh > obs) obs = sh;
    }
    // Near the touchdown end (last 1.4m), allow rising onto the target deck itself
    const margin = dist * (1 - u) < 1.4 ? -0.35 : 0.25;
    if (obs > arcY + margin) return false;
  }
  return true;
}

/**
 * Search around the natural stopping point ahead of `origin` for a valid flat-enough landing
 * surface (terrain or town roof/terrace/quay/bridge).
 *
 * @param game   Game context
 * @param origin Current world position (Vector3)
 * @param vel    Current velocity (Vector3)
 * @param yaw    Current heading in radians
 * @param opts   { radius, maxAgl, maxClimb, leadTime, maxLead, searchRadius }
 */
export function findLandingSpot(game, origin, vel, yaw, opts = {}) {
  const maxAgl = opts.maxAgl ?? 24;
  const maxClimb = opts.maxClimb ?? 5.5;
  const leadTime = opts.leadTime ?? 0.34;
  const maxLead = opts.maxLead ?? 8.5;
  const minLead = opts.minLead ?? 1.0;
  const searchR = opts.searchRadius ?? 6.5;

  const hs = vel ? Math.hypot(vel.x, vel.z) : 0;
  const hx = hs > 1.5 ? vel.x / hs : Math.sin(yaw);
  const hz = hs > 1.5 ? vel.z / hs : -Math.cos(yaw);
  const lead = Math.min(maxLead, Math.max(minLead, hs * leadTime));

  const ax = origin.x + hx * lead;
  const az = origin.z + hz * lead;

  let best = null;
  let bestCost = Infinity;

  // Concentric candidate spiral around the natural stopping point (plus right beneath origin)
  const candidates = [[ax, az, 0], [origin.x + hx * 1.5, origin.z + hz * 1.5, 0.4], [origin.x, origin.z, 0.8]];
  const rings = [1.6, 3.2, 5.0, searchR];
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri];
    if (r > searchR + 0.01) break;
    const n = ri < 2 ? 8 : 12;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + yaw;
      candidates.push([ax + Math.sin(a) * r, az - Math.cos(a) * r, r * 0.45]);
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const [cx, cz, distPenalty] = candidates[i];
    const hit = probeLandingSurface(game, cx, cz, opts);
    if (!hit) continue;
    const dy = origin.y - hit.y;
    if (dy > maxAgl || dy < -maxClimb) continue;
    if (!hasClearGlide(game, origin.x, origin.y, origin.z, hit.x, hit.y, hit.z, opts.clearance ?? 0.75)) continue;
    const dHoriz = Math.hypot(hit.x - ax, hit.z - az);
    const cost = hit.score + distPenalty + dHoriz * 0.22 + Math.max(0, -dy) * 0.6;
    if (cost < bestCost) {
      bestCost = cost;
      best = hit;
    }
    // Early-out if right on the mark and very flat
    if (i === 0 && hit.score < 0.35 && dy >= -1.0) break;
  }

  return best;
}
