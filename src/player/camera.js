// Chase camera with an FPV-drone feel: it trails the broom with a little lag, rolls with the bank,
// widens with speed and never dips under the ground - or into a building (flight.solid).
// When she lands it hands over to a slow orbit that shows off the view, and takes over again as
// she leaves (orbit / release).
import * as THREE from 'three';
import { SPEEDS } from './flight.js';

const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const dampAngle = (cur, target, rate, dt) => {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + d * (1 - Math.exp(-rate * dt));
};

// look = how far ahead of the rider the camera aims, drop = how far below her (tilts the view down
// so the ground streaming between camera and broom fills the lower frame)
// zoom = [slow, fast]: how the following distance scales with airspeed (1 at a cruise) - the chase
// camera closes in when the broom dawdles and drops back as it sprints
export const CAM_MODES = [
  { name: 'chase', dist: 7.2, height: 1.65, look: 5.5, drop: 0.55, fov: 70, roll: 0.62, lag: 3.4, zoom: [0.64, 1.42] },
  { name: 'low', dist: 5.2, height: 0.75, look: 9, drop: 0.25, fov: 82, roll: 0.78, lag: 4.6 },
  { name: 'far', dist: 14, height: 4.2, look: 6, drop: 1.0, fov: 60, roll: 0.45, lag: 2.6 },
];

export class ChaseCamera {
  constructor(camera, flight) {
    this.camera = camera;
    this.flight = flight;
    this.mode = 0;
    this.yaw = flight.yaw;
    this.pitch = flight.pitch;
    this.roll = 0;
    this.dist = CAM_MODES[0].dist;
    this.height = CAM_MODES[0].height;
    this.fov = 70;
    this.fovOut = 70;
    this.shake = 0;
    this.orbit = 0;         // title-screen orbit angle offset
    this.orbitPitch = 0;
    this.vehicleScale = 1;  // > 1 pulls back & raises framing for larger mounts (catbus)
    this._vScale = 1;
    this.targetOffset = new THREE.Vector3();
    this._tOff = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._z = new THREE.Vector3(0, 0, 1);
    // the landed view: an orbit about a point, blended in (k) over the chase camera
    this.cine = {
      on: false, k: 0, tin: 1.4, tout: 1.2, t: 0,
      focus: new THREE.Vector3(),          // what it circles (may move; see circle())
      az: 0, dist: 6, h: 2,                // bearing focus -> camera, distance out, height above the focus
      tDist: 6.6, tH: 1.9, spin: 0.085, fov: 56, lookY: 0.35,
      skip: 1, arc: null, phase: 0,        // see circle()
      block: { cut: 1, lift: 0 },
    };
    this._block = { cut: 1, lift: 0 };
    this._cp = new THREE.Vector3();
    this._pc = new THREE.Vector3();
    this._qc = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }

  snap() {
    this.yaw = this.flight.yaw;
    this.pitch = this.flight.pitch;
    this.roll = this.flight.roll * CAM_MODES[this.mode].roll;
  }

  next() { this.mode = (this.mode + 1) % CAM_MODES.length; return CAM_MODES[this.mode].name; }

  /**
   * Hand the view to a slow orbit about `focus` (a Vector3 that is read every frame, so it may
   * move). It starts from wherever the camera is now and eases out to its own distance and height.
   * @param o { dist, height, spin (rad/s), fov, lookY (aim this far above the focus), seconds (blend),
   *            skip (m round the focus in which buildings are not allowed to block the view: the
   *            place she is standing on), arc ({ mid, half } bearings: with a wall behind her the
   *            camera cannot go all the way round, so it swings to and fro across the open side) }
   */
  circle(focus, o = {}) {
    const c = this.cine, p = this.camera.position;
    c.focus = focus;
    const dx = p.x - focus.x, dz = p.z - focus.z;
    if (c.k <= 0) {
      c.az = Math.atan2(dx, -dz);
      c.dist = Math.max(Math.hypot(dx, dz), 1.5);
      c.h = p.y - focus.y;
      c.block.cut = 1; c.block.lift = 0;
      c.t = 0;
    }
    c.tDist = o.dist ?? 6.6; c.tH = o.height ?? 1.9; c.spin = o.spin ?? 0.085;
    c.fov = o.fov ?? 56; c.lookY = o.lookY ?? 0.35; c.tin = o.seconds ?? 1.4;
    c.skip = o.skip ?? 1;
    c.arc = o.arc || null;
    if (c.arc) {
      const off = Math.atan2(Math.sin(c.az - c.arc.mid), Math.cos(c.az - c.arc.mid));
      c.phase = Math.asin(Math.max(-1, Math.min(1, off / Math.max(c.arc.half, 0.2))));
    }
    c.on = true;
  }

  /** Give the view back to the chase camera over `seconds`. */
  release(seconds = 1.2) {
    const c = this.cine;
    c.on = false;
    c.tout = Math.max(seconds, 0.05);
    // (while she stood by a wall the chase camera, unseen, was pressed up against it: let it out)
    this._block.cut = Math.max(this._block.cut, 0.7);
    this._block.lift = Math.min(this._block.lift, 0.5);
  }

  /**
   * Keep a camera at p, watching (tx, ty, tz), out of the buildings: a roof just under the line
   * of sight is ridden over, a wall across it brings the camera in to the near side of it.
   */
  _unblock(p, tx, ty, tz, st, dt, skip = 0.9) {
    const S = this.flight.solid;
    if (!S) return;
    const N = 12, reach = Math.hypot(p.x - tx, p.z - tz);
    let lift = 0, cut = 1;
    for (let i = 1; i <= N; i++) {
      const u = i / N;
      if (reach * u < skip) continue;                        // (right by her: that is where she is, not in the way)
      const top = S.heightAt(tx + (p.x - tx) * u, tz + (p.z - tz) * u);
      if (top < -1e8) continue;
      const under = top + 0.5 - (ty + (p.y - ty) * u);      // how far this point of the line is inside
      if (under <= 0) continue;
      if (under / u < 3) { if (under / u > lift) lift = under / u; continue; }
      cut = Math.max((i - 1) / N, 0.14);
      break;
    }
    // in at once, back out gently
    st.cut = cut < st.cut ? cut : Math.min(cut, damp(st.cut, cut, 2.5, dt) + 0.002);
    st.lift = lift > st.lift ? lift : damp(st.lift, lift, 3, dt);
    p.x = tx + (p.x - tx) * st.cut;
    p.z = tz + (p.z - tz) * st.cut;
    p.y = ty + (p.y - ty) * st.cut + st.lift * st.cut;
  }

  update(dt, time, surfaceAt) {
    const f = this.flight, m = CAM_MODES[this.mode], cam = this.camera;
    this.yaw = dampAngle(this.yaw, f.yaw + this.orbit, m.lag, dt);
    this.pitch = damp(this.pitch, f.pitch * 0.86 + this.orbitPitch, m.lag * 0.9, dt);
    this.roll = damp(this.roll, f.roll * m.roll, 4.2, dt);
    const sk = Math.max(0, (f.speed - 33) / 30);
    let zoom = 1 + 0.16 * f.boosting + sk * 0.5 / m.dist;
    if (m.zoom) {
      const { SLOW, CRUISE, BOOST } = SPEEDS, v = f.speed;
      if (v < CRUISE) {
        const t = Math.min(1, (CRUISE - v) / (CRUISE - SLOW));
        zoom = 1 - (1 - m.zoom[0]) * t * t * (3 - 2 * t);
      } else {
        // (keeps easing out past boost speed, in a dive)
        zoom = 1 + (m.zoom[1] - 1) * (1 - Math.exp(-(v - CRUISE) / 22)) / (1 - Math.exp(-(BOOST - CRUISE) / 22));
      }
    }
    this._vScale = damp(this._vScale, this.vehicleScale, 4.0, dt);
    this._tOff.lerp(this.targetOffset, 1 - Math.exp(-5.0 * dt));
    const vs = this._vScale;
    this.dist = damp(this.dist, m.dist * zoom * vs, 2.4, dt);
    // rise and sink with the distance so the broom (or catbus) stays framed the same way
    this.height = damp(this.height, m.height * (0.4 + 0.6 * zoom) * (1 + (vs - 1) * 1.15), 2.4, dt);
    this.fov = damp(this.fov, m.fov + 11 * Math.min(sk, 1.3) + 7 * f.boosting, 2.6, dt);

    const ax = f.pos.x + this._tOff.x;
    const ay = f.pos.y + this._tOff.y;
    const az = f.pos.z + this._tOff.z;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dx = Math.sin(this.yaw) * cp, dy = sp, dz = -Math.cos(this.yaw) * cp;
    // sit behind and above, measured in the camera's own tilted frame so dives stay framed
    const ux = -Math.sin(this.yaw) * sp, uy = cp, uz = Math.cos(this.yaw) * sp;
    // the camera rides out most of a landing bounce, so the broom is seen to dip and spring back
    const fy = ay - (f.bob || 0) * 0.65;
    const p = this._pos.set(
      ax - dx * this.dist + ux * this.height,
      fy - dy * this.dist + uy * this.height,
      az - dz * this.dist + uz * this.height,
    );
    // keep out of the buildings, the ground and the swell
    this._unblock(p, ax, fy + 0.6, az, this._block, dt, 0.9 * vs * vs);
    const floor = surfaceAt(p.x, p.z) + 0.45;
    if (p.y < floor) p.y = floor;

    // shake: a fine buzz at speed plus a kick on impact
    this.shake = damp(this.shake, 0.012 * sk + 0.035 * f.boosting + f.bump * 0.22, 8, dt);
    const s = this.shake;
    p.x += (Math.sin(time * 37.1) + Math.sin(time * 61.7)) * 0.5 * s;
    p.y += (Math.sin(time * 43.3 + 1) + Math.sin(time * 71.9)) * 0.5 * s;

    cam.position.copy(p);
    const t = this._target.set(
      ax + f.fwd.x * m.look, fy + f.fwd.y * m.look - m.drop, az + f.fwd.z * m.look,
    );
    this._up.set(0, 1, 0);
    cam.up.copy(this._up);
    cam.lookAt(t);
    // roll about the view axis
    this._q.setFromAxisAngle(this._z, -this.roll + Math.sin(time * 29.0) * s * 0.06);
    cam.quaternion.multiply(this._q);
    this.fovOut = this.fov;

    const c = this.cine;
    if (c.on || c.k > 0) this._circle(dt, surfaceAt);
  }

  /** The orbit, blended over the chase pose that update() has just set. */
  _circle(dt, surfaceAt) {
    const c = this.cine, cam = this.camera, F = c.focus;
    const pc = this._pc.copy(cam.position), qc = this._qc.copy(cam.quaternion);
    c.k = Math.min(1, Math.max(0, c.k + (c.on ? dt / c.tin : -dt / c.tout)));
    if (c.on) {
      // drift round, breathing in and out and up and down so the view keeps changing
      c.t += dt;
      if (c.arc) {
        c.phase += (c.spin / Math.max(c.arc.half, 0.2)) * dt;
        c.az = dampAngle(c.az, c.arc.mid + c.arc.half * Math.sin(c.phase), 1.6, dt);
      } else c.az += c.spin * dt;
      c.dist = damp(c.dist, c.tDist + 0.8 * Math.sin(c.t * 0.11), 0.9, dt);
      c.h = damp(c.h, c.tH + 0.5 * Math.sin(c.t * 0.083 + 1.0), 0.9, dt);
    } else {
      // on the way out: swing round to where the chase camera wants to be, then let it take over
      const dx = pc.x - F.x, dz = pc.z - F.z;
      c.az = dampAngle(c.az, Math.atan2(dx, -dz), 3.0, dt);
      c.dist = damp(c.dist, Math.hypot(dx, dz), 3.0, dt);
      c.h = damp(c.h, pc.y - F.y, 3.0, dt);
    }
    const p = this._cp.set(F.x + Math.sin(c.az) * c.dist, F.y + c.h, F.z - Math.cos(c.az) * c.dist);
    this._unblock(p, F.x, F.y + 0.2, F.z, c.block, dt, c.skip);
    const floor = surfaceAt(p.x, p.z) + 0.45;
    if (p.y < floor) p.y = floor;
    this._m.lookAt(p, this._target.set(F.x, F.y + c.lookY, F.z), this._up.set(0, 1, 0));
    this._q2.setFromRotationMatrix(this._m);
    const e = c.k * c.k * (3 - 2 * c.k);
    cam.position.copy(pc).lerp(p, e);
    cam.quaternion.copy(qc).slerp(this._q2, e);
    this.fovOut = this.fov + (c.fov - this.fov) * e;
  }
}
