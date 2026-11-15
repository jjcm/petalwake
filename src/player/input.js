// Input: keyboard, pointer-lock mouse (sprung virtual stick) and gamepad, merged into one state.
// The brake doubles as the landing key: held it is the brake as ever, tapped twice inside
// DOUBLE_TAP ms it also posts 'Space2' to `pressed` (come in to land; see game/index.js).
const DOUBLE_TAP = 300;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.stickX = 0;   // mouse stick
    this.stickY = 0;
    this.turn = 0;     // -1 left .. +1 right
    this.pitch = 0;    // -1 dive .. +1 climb
    this.boost = false;
    this.brake = false;
    this.invert = false;
    this.locked = false;
    this.enabled = false;
    this.pressed = new Set(); // edge-triggered keys, consumed by the game
    this.sens = 0.0021;
    this._tap = -1e9;         // when the brake was last tapped (ms)
    this._padBrake = false;   // gamepad buttons last step, for their edges
    this._padTrick = false;
    this.touch = { x: 0, y: 0, boost: false, brake: false };

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName)) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Space') this._tapBrake(e.timeStamp);
      if (this.enabled && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && this.enabled && !this.locked) canvas.requestPointerLock?.()?.catch?.(() => {}); });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.stickX = Math.max(-1, Math.min(1, this.stickX + e.movementX * this.sens));
      this.stickY = Math.max(-1, Math.min(1, this.stickY + e.movementY * this.sens));
    });
    window.addEventListener('mousedown', (e) => { if (this.locked) { if (e.button === 0) this.mouseBoost = true; if (e.button === 2) { this.mouseBrake = true; this.pressed.add('Space'); this._tapBrake(e.timeStamp); } } });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseBoost = false; if (e.button === 2) this.mouseBrake = false; });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
  }

  reset() {
    this.keys.clear(); this.pressed.clear();
    this.stickX = this.stickY = this.turn = this.pitch = 0;
    this.mouseBoost = this.mouseBrake = this.boost = this.brake = false;
    this.touch.x = this.touch.y = 0; this.touch.boost = this.touch.brake = false;
    this._tap = -1e9; this._padBrake = this._padTrick = false;
  }

  touchAction(code, time = performance.now()) {
    if (!this.enabled) return;
    this.pressed.add(code);
    if (code === 'Space') this._tapBrake(time);
  }

  /** A tap of the brake at time t (ms): the second of two close together is a double tap. */
  _tapBrake(t) {
    if (t - this._tap < DOUBLE_TAP) { this.pressed.add('Space2'); this._tap = -1e9; } else this._tap = t;
  }

  take(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  update(dt) {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    // the mouse stick springs back to centre like a self-centring joystick
    const relax = Math.exp(-dt * 2.6);
    this.stickX *= relax; this.stickY *= relax;
    x += this.stickX * 1.6 + this.touch.x;
    y += -this.stickY * 1.6 + this.touch.y;
    let boost = k.has('ShiftLeft') || k.has('ShiftRight') || !!this.mouseBoost || this.touch.boost;
    let brake = k.has('Space') || !!this.mouseBrake || this.touch.brake;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      x += dz(p.axes[0] || 0);
      y += -dz(p.axes[1] || 0);
      if (p.buttons[7]?.value > 0.3 || p.buttons[0]?.pressed) boost = true;
      const padBrake = p.buttons[6]?.value > 0.3 || !!p.buttons[1]?.pressed;
      if (padBrake) brake = true;
      // the same taps on a pad: brake twice to land (once to take off again), X or Y for the trick
      if (padBrake && !this._padBrake) { this.pressed.add('Space'); this._tapBrake(performance.now()); }
      this._padBrake = padBrake;
      const padTrick = !!(p.buttons[2]?.pressed || p.buttons[3]?.pressed);
      if (padTrick && !this._padTrick) this.pressed.add('KeyQ');
      this._padTrick = padTrick;
      break;
    }
    if (this.invert) y = -y;
    this.turn = Math.max(-1, Math.min(1, x));
    this.pitch = Math.max(-1, Math.min(1, y));
    this.boost = boost;
    this.brake = brake;
    if (!this.enabled) { this.turn = 0; this.pitch = 0; this.boost = false; this.brake = false; }
  }
}
