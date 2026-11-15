import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../src/player/input.js';

class Target {
  handlers = new Map();
  addEventListener(name, fn) { const list = this.handlers.get(name) || []; list.push(fn); this.handlers.set(name, list); }
  emit(name, props = {}) { for (const fn of this.handlers.get(name) || []) fn({ preventDefault() {}, ...props }); }
}
let input, canvas;
beforeEach(() => {
  globalThis.window = new Target(); globalThis.document = new Target();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [] } });
  canvas = new Target(); input = new Input(canvas); input.enabled = true;
});
test('touch steering, boost and brake merge with keyboard and respect inversion', () => {
  input.touch = { x: 0.4, y: 0.6, boost: true, brake: true };
  input.update(1 / 60);
  assert.equal(input.turn, 0.4); assert.equal(input.pitch, 0.6);
  assert.equal(input.boost, true); assert.equal(input.brake, true);
  input.invert = true; input.update(1 / 60); assert.equal(input.pitch, -0.6);
  window.emit('keydown', { code: 'KeyD' }); input.update(1 / 60); assert.equal(input.turn, 1);
});
test('brake double tap requests landing; a single tap requests takeoff', () => {
  input.touchAction('Space', 1000); assert.equal(input.take('Space'), true); assert.equal(input.take('Space2'), false);
  input.touchAction('Space', 1200); assert.equal(input.take('Space2'), true);
  input.touchAction('Space', 1800); assert.equal(input.take('Space2'), false);
});
test('cancel, blur and background clear held controls and stale landing taps', () => {
  input.touchAction('Space', 1000); input.touch.boost = true; input.touch.x = 1;
  input.keys.add('KeyD'); input.mouseBrake = true; window.emit('blur'); input.update(1 / 60);
  assert.equal(input.turn, 0); assert.equal(input.boost, false); assert.equal(input.brake, false);
  input.touchAction('Space', 1100); assert.equal(input.take('Space2'), false);
  document.hidden = true; document.emit('visibilitychange'); assert.equal(input.pressed.size, 0);
});
test('disabled input and focused form controls do not queue flight actions', () => {
  input.enabled = false; input.touchAction('KeyQ'); window.emit('keydown', { code: 'Space' });
  assert.equal(input.pressed.size, 0);
  input.enabled = true; window.emit('keydown', { code: 'Space', target: { tagName: 'SELECT' } });
  assert.equal(input.keys.size, 0);
  input.touch.x = 1; input.enabled = false; input.update(1 / 60); assert.equal(input.turn, 0);
});
test('touch never requests pointer lock; mouse still does', () => {
  let calls = 0; canvas.requestPointerLock = () => { calls++; };
  canvas.emit('pointerdown', { pointerType: 'touch' }); assert.equal(calls, 0);
  canvas.emit('pointerdown', { pointerType: 'mouse' }); assert.equal(calls, 1);
});
