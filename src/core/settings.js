// Validated, versioned preferences. URL overrides never overwrite saved preferences.
export const SETTINGS_KEY = 'petalwake.graphics.v2';
export const LEGACY_SETTINGS_KEY = 'petalwake.graphics.v1';
export const PRESETS = {
  'ultra-low': { renderScale: 100, fps: 60, meadow: 'minimal', particles: 0.15, samples: 0, bloom: false, rays: false, blur: false, reflections: false, shadows: false, clouds: false, shore: false, adaptive: false },
  low: { renderScale: 100, fps: 60, meadow: 'low', particles: 0.3, samples: 0, bloom: false, rays: false, blur: false, reflections: false, shadows: false, clouds: true, shore: false, adaptive: false },
  medium: { renderScale: 100, fps: 60, meadow: 'medium', particles: 0.6, samples: 2, bloom: true, rays: false, blur: false, reflections: true, shadows: true, clouds: true, shore: true, adaptive: false },
  high: { renderScale: 100, fps: 60, meadow: 'high', particles: 1, samples: 4, bloom: true, rays: true, blur: true, reflections: true, shadows: true, clouds: true, shore: true, adaptive: false },
};
const choices = {
  fps: [30, 45, 60, 0],
  meadow: ['minimal', 'low', 'medium', 'high'], particles: [0.15, 0.3, 0.6, 1], samples: [0, 2, 4],
};
const nativeRatio = dpr => Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
const validScale = scale => Number.isFinite(scale) && scale >= 25 && scale <= 100;
const validLegacyDpr = dpr => Number.isFinite(dpr) && dpr >= 0.5 && dpr <= 2;
const scaleFromDpr = (dpr, deviceDpr) => Math.round(Math.max(25, Math.min(100, Math.min(dpr, nativeRatio(deviceDpr)) / nativeRatio(deviceDpr) * 100)));

/** 100% = native width and height; 50% = a quarter of the pixels on any display. */
export function renderPixelRatio(renderScale, deviceDpr = 1) {
  return nativeRatio(deviceDpr) * (validScale(renderScale) ? renderScale : 100) / 100;
}

export function sanitizeSettings(value, mobile = false, deviceDpr = 1) {
  const base = PRESETS[mobile ? 'low' : 'high'];
  const result = { ...base };
  if (!value || typeof value !== 'object') return result;
  for (const key of Object.keys(base)) {
    const valid = key === 'renderScale' ? validScale(value[key])
      : choices[key] ? choices[key].includes(value[key]) : typeof value[key] === 'boolean';
    if (valid) result[key] = key === 'renderScale' ? Math.round(value[key]) : value[key];
  }
  if (!Object.hasOwn(value, 'renderScale') && validLegacyDpr(value.dpr)) result.renderScale = scaleFromDpr(value.dpr, deviceDpr);
  return result;
}
export function loadSettings(storage, params = new URLSearchParams(), mobile = false, deviceDpr = 1) {
  let saved;
  try { saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? storage?.getItem(LEGACY_SETTINGS_KEY) ?? null); } catch { /* storage can be unavailable */ }
  const settings = params.has('preset') && Object.hasOwn(PRESETS, params.get('preset'))
    ? { ...PRESETS[params.get('preset')] } : sanitizeSettings(saved, mobile, deviceDpr);
  if (['minimal', 'low', 'medium', 'high'].includes(params.get('q'))) settings.meadow = params.get('q');
  const dpr = Number(params.get('dpr'));
  if (params.has('dpr') && validLegacyDpr(dpr)) settings.renderScale = scaleFromDpr(dpr, deviceDpr);
  const scale = Number(params.get('scale'));
  if (params.has('scale') && validScale(scale)) settings.renderScale = Math.round(scale);
  if (params.has('noscale') || params.has('debug')) settings.adaptive = false;
  return settings;
}

// Fractional deadlines avoid turning a 45 fps limit on a 60 Hz display into 30 fps.
export function frameDue(now, deadline, fps) {
  if (!fps) return { due: true, deadline: now };
  const interval = 1000 / fps;
  if (now + 0.1 < deadline) return { due: false, deadline };
  return { due: true, deadline: now - deadline > interval ? now + interval : deadline + interval };
}
