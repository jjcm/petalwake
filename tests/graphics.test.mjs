import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, SETTINGS_KEY, LEGACY_SETTINGS_KEY, sanitizeSettings, loadSettings, frameDue, renderPixelRatio } from '../src/core/settings.js';
import { Pipeline } from '../src/core/pipeline.js';
import { WindFX } from '../src/fx/windfx.js';
import * as THREE from 'three';

test('mobile defaults low; desktop defaults high; invalid preset names are ignored', () => {
  assert.deepEqual(loadSettings(null), PRESETS.high);
  assert.deepEqual(loadSettings(null, new URLSearchParams('preset=constructor')), PRESETS.high);
  assert.deepEqual(loadSettings(null, new URLSearchParams(), true), PRESETS.low);
  for (const preset of ['ultra-low', 'low', 'medium', 'high']) {
    const settings = loadSettings(null, new URLSearchParams({ preset }));
    assert.equal(settings.renderScale, 100); assert.equal(settings.adaptive, false); assert.equal(settings.fps, 60);
  }
});
test('corrupt, missing and unavailable storage fall back safely', () => {
  for (const getItem of [() => '{', () => 'null', () => { throw Error('blocked'); }]) {
    assert.deepEqual(loadSettings({ getItem }), PRESETS.high);
  }
  assert.deepEqual(sanitizeSettings({ renderScale: Infinity, fps: -1, meadow: 'bad', bloom: 'false', samples: 16 }), PRESETS.high);
});
test('saved preferences survive; valid URL overrides take precedence without writing storage', () => {
  const storage = { getItem: key => { assert.equal(key, SETTINGS_KEY); return JSON.stringify(PRESETS.medium); } };
  assert.deepEqual(loadSettings(storage), PRESETS.medium);
  const s = loadSettings(storage, new URLSearchParams('preset=ultra-low&q=medium&dpr=0.8&scale=60&noscale'));
  assert.equal(s.meadow, 'medium'); assert.equal(s.renderScale, 60); assert.equal(s.adaptive, false); assert.equal(s.fps, 60);
  assert.equal(loadSettings(storage, new URLSearchParams('scale=0&q=unknown')).renderScale, 100);
  assert.equal(loadSettings(storage, new URLSearchParams('dpr=0.8'), false, 2).renderScale, 40);
  assert.equal(loadSettings(storage, new URLSearchParams('dpr=-5')).renderScale, 100);
});
test('render scale is relative to native resolution on standard and high-DPI displays', () => {
  for (const dpr of [1, 1.5, 2, 3, 4]) {
    const native = renderPixelRatio(100, dpr), half = renderPixelRatio(50, dpr);
    assert.equal(native, dpr); assert.equal(half, dpr / 2);
    assert.equal((800 * half * 600 * half) / (800 * native * 600 * native), 0.25);
    assert.equal(renderPixelRatio(25, dpr), dpr / 4);
  }
  assert.equal(renderPixelRatio(50, 0), 0.5);
  assert.equal(renderPixelRatio(50, NaN), 0.5);
  assert.equal(renderPixelRatio(0, 2), 2);
});
test('render scale rejects blank output and supersampling values and preserves valid percentages', () => {
  for (const renderScale of [0, -1, 24, 101, NaN, Infinity, '50', null]) assert.equal(sanitizeSettings({ renderScale }).renderScale, 100);
  assert.equal(sanitizeSettings({ renderScale: 37 }).renderScale, 37);
  assert.equal(sanitizeSettings({ renderScale: 63.4 }).renderScale, 63);
});
test('legacy pixel-ratio preferences migrate to percentages; v2 preferences take priority', () => {
  const values = { [LEGACY_SETTINGS_KEY]: JSON.stringify({ ...PRESETS.low, renderScale: undefined, dpr: 1, fps: 30 }) };
  const storage = { getItem: key => values[key] ?? null };
  const migrated = loadSettings(storage, new URLSearchParams(), true, 2);
  assert.equal(migrated.renderScale, 50); assert.equal(migrated.fps, 30); assert.equal(Object.hasOwn(migrated, 'dpr'), false);
  assert.equal(loadSettings(storage, new URLSearchParams(), true, 4).renderScale, 25);
  assert.equal(sanitizeSettings({ dpr: 0.5 }, false, 4).renderScale, 25);
  values[SETTINGS_KEY] = JSON.stringify({ ...PRESETS.medium, renderScale: 68 });
  assert.equal(loadSettings(storage, new URLSearchParams(), false, 3).renderScale, 68);
});
test('frame limits hold their rate on 60Hz and 120Hz displays, including fractional 45fps', () => {
  for (const hz of [60, 120]) for (const fps of [30, 45, 60, 0]) {
    let deadline = 0, count = 0;
    for (let i = 0; i < hz * 10; i++) {
      const result = frameDue(i * 1000 / hz, deadline, fps); deadline = result.deadline;
      if (result.due) count++;
    }
    assert.ok(Math.abs(count - (fps || hz) * 10) <= 1, `${hz}Hz, ${fps}fps: ${count}`);
  }
});
function renderer() {
  return { capabilities: { reversedDepthBuffer: false, maxSamples: 4 }, targets: [], calls: 0,
    setRenderTarget(rt) { this.targets.push(rt); }, render() { this.calls++; } };
}
test('ultra-low removes bloom/ray targets and rendering passes, retains depth composition', () => {
  const r = renderer(), low = new Pipeline(r, PRESETS['ultra-low']); low.setSize(800, 600, renderPixelRatio(PRESETS['ultra-low'].renderScale, 3));
  assert.equal(low.sceneRT.width, 2400); assert.equal(low.sceneRT.samples, 0); assert.equal(low.compRT.samples, 0);
  assert.equal(low.bloom.length, 0); assert.equal(low.bloomUp.length, 0); assert.equal(low.raysRT, null);
  assert.equal(low.params.blur, 0); assert.equal(low.blurMat.depthWrite, true); assert.ok(low.uDepth.value);
  low.render(new THREE.Scene(), new THREE.PerspectiveCamera(), 1 / 30);
  assert.equal(r.calls, 3); assert.equal(low.finalMat.uniforms.tBloom.value, low.black);
  assert.equal(low.finalMat.uniforms.tRays.value, low.black);
  const highRenderer = renderer(), high = new Pipeline(highRenderer, PRESETS.high); high.setSize(800, 600, renderPixelRatio(PRESETS.high.renderScale, 3));
  high.render(new THREE.Scene(), new THREE.PerspectiveCamera(), 1 / 60);
  assert.ok(highRenderer.calls > 10); assert.equal(high.sceneRT.samples, 4);
  assert.equal(high.sceneRT.width * high.sceneRT.height, low.sceneRT.width * low.sceneRT.height);
  low.dispose(); high.dispose();
});
test('MSAA respects the device sample limit and particle budgets reduce allocations', () => {
  const r = renderer(); r.capabilities.maxSamples = 2;
  const pipeline = new Pipeline(r, PRESETS.high); pipeline.setSize(800, 600, 1); assert.equal(pipeline.sceneRT.samples, 2);
  const fx = new WindFX({}, {}, pipeline.uDepth, 0.15);
  assert.equal(fx.flakes.max, 1800); assert.equal(fx.sprites.max, 1050);
  pipeline.dispose();
});
