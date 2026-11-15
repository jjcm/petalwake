import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TouchControls } from '../src/ui/touch.js';
class Element {
  handlers = new Map(); captures = new Set(); hidden = false; style = {}; dataset = {};
  classes = new Set();
  classList = { add: v => this.classes.add(v), remove: v => this.classes.delete(v), toggle: (v, on) => on ? this.classes.add(v) : this.classes.delete(v) };
  addEventListener(name, fn) { const list = this.handlers.get(name) || []; list.push(fn); this.handlers.set(name, list); }
  emit(name, props = {}) { for (const fn of this.handlers.get(name) || []) fn({ preventDefault() {}, button: 0, ...props }); }
  append() {}
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}
let controls, input, game, elements;
beforeEach(() => {
  globalThis.window = new Element(); globalThis.document = new Element(); document.body = new Element();
  globalThis.matchMedia = () => Object.assign(new Element(), { matches: true });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: 5 } });
  globalThis.location = { search: '' };
  elements = Object.fromEntries(['stick', 'knob', 'boost', 'brake', 'camera', 'flip', 'journal'].map(k => [k, new Element()]));
  elements.boost.dataset.hold = 'boost'; elements.brake.dataset.hold = 'brake';
  elements.camera.dataset.code = 'KeyC'; elements.flip.dataset.code = 'KeyQ';
  document.createElement = () => Object.assign(new Element(), {
    querySelector: s => ({ '.touch-stick': elements.stick, '.touch-knob': elements.knob, '[data-journal]': elements.journal })[s],
    querySelectorAll: s => s === '[data-hold]' ? [elements.boost, elements.brake] : [elements.camera, elements.flip],
  });
  input = { enabled: true, touch: { x: 0, y: 0, boost: false, brake: false }, actions: [], touchAction(code, time) { this.actions.push([code, time]); } };
  game = { state: 'play', paused: false };
  controls = new TouchControls(input, game);
});
test('steering and held boost/brake work with separate fingers; cancel neutralizes steering', () => {
  elements.stick.emit('pointerdown', { pointerId: 1, clientX: 85, clientY: 50 });
  elements.boost.emit('pointerdown', { pointerId: 2 }); elements.brake.emit('pointerdown', { pointerId: 3, timeStamp: 1000 });
  assert.equal(input.touch.x, 1); assert.equal(input.touch.boost, true); assert.equal(input.touch.brake, true);
  assert.deepEqual(input.actions, [['Space', 1000]]);
  elements.stick.emit('pointercancel', { pointerId: 1 }); assert.equal(input.touch.x, 0); assert.equal(input.touch.y, 0);
  assert.equal(input.touch.boost, true); elements.boost.emit('pointerup', { pointerId: 2 }); assert.equal(input.touch.boost, false);
});
test('stick clamps diagonals and screen up climbs; second stick finger cannot take over', () => {
  elements.stick.emit('pointerdown', { pointerId: 1, clientX: 50, clientY: 0 }); assert.equal(input.touch.y, 1);
  elements.stick.emit('pointerdown', { pointerId: 2, clientX: 50, clientY: 100 }); assert.equal(input.touch.y, 1);
  elements.stick.emit('pointermove', { pointerId: 1, clientX: 1000, clientY: -1000 });
  assert.ok(Math.hypot(input.touch.x, input.touch.y) <= 1);
  elements.stick.emit('lostpointercapture', { pointerId: 1 }); assert.equal(input.touch.x, 0);
});
test('multiple fingers on the same button release only after the last finger', () => {
  elements.boost.emit('pointerdown', { pointerId: 1 }); elements.boost.emit('pointerdown', { pointerId: 2 });
  elements.boost.emit('pointerup', { pointerId: 1 }); assert.equal(input.touch.boost, true);
  elements.boost.emit('pointercancel', { pointerId: 2 }); assert.equal(input.touch.boost, false);
});
test('blur, background and hiding controls release captures and held actions', () => {
  elements.boost.emit('pointerdown', { pointerId: 1 }); window.emit('blur'); assert.equal(input.touch.boost, false); assert.equal(controls.pointers.size, 0);
  elements.brake.emit('pointerdown', { pointerId: 2 }); document.hidden = true; document.emit('visibilitychange'); assert.equal(input.touch.brake, false);
  elements.boost.emit('pointerdown', { pointerId: 3 }); controls.setMode('off'); assert.equal(controls.root.hidden, true); assert.equal(input.touch.boost, false);
});
test('paused controls cannot start flight actions; tools and journal are reachable', () => {
  game.paused = true; elements.boost.emit('pointerdown', { pointerId: 1 }); assert.equal(input.touch.boost, false);
  game.paused = false; elements.camera.emit('click'); elements.flip.emit('click'); assert.equal(input.actions[0][0], 'KeyC'); assert.equal(input.actions[1][0], 'KeyQ');
  let opened = false; game.places = { journal: { canOpen: () => true, toggle: () => { opened = true; } } };
  elements.journal.emit('click'); assert.equal(opened, true);
});
