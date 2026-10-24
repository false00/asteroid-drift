export const RANKED_AREA = 960 * 640;
export const RANKED_SCALE = 640 / 600;
export const VIEWPORT_UNITS = 64;
export const MAX_VIEWPORT_EDGE = 1048576;
export const DEFAULT_VIEWPORT = Object.freeze({ width: 960 * VIEWPORT_UNITS, height: 640 * VIEWPORT_UNITS });

export function arenaForViewport(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_VIEWPORT_EDGE)) throw new RangeError('Viewport dimensions must be bounded positive integers.');
  const aspect = width / height;
  if (aspect < 1 / 8 || aspect > 8) throw new RangeError('Viewport aspect ratio is outside the supported range.');
  const arenaWidth = Math.sqrt(RANKED_AREA * aspect);
  return { width: arenaWidth, height: RANKED_AREA / arenaWidth };
}

export function viewportForSize(width, height) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('The visible playfield must have positive finite dimensions.');
  const units = Math.min(VIEWPORT_UNITS, MAX_VIEWPORT_EDGE / Math.max(width, height));
  const viewport = { width: Math.max(1, Math.round(width * units)), height: Math.max(1, Math.round(height * units)) };
  arenaForViewport(viewport.width, viewport.height);
  return viewport;
}

export function isRankedArena(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    && width / height >= 1 / 8 - 0.000000000001 && width / height <= 8 + 0.000000000001
    && Math.abs(width * height - RANKED_AREA) < 0.000001;
}
