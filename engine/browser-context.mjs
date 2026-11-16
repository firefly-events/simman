import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const DEVICE_RE = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?(?:,(touch))?$/;

export function parseDevice(value) {
  const match = typeof value === 'string' ? DEVICE_RE.exec(value) : null;
  if (!match) {
    throw new Error(`invalid device "${value ?? ''}"; expected <width>x<height>[@<scale>][,touch]`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const deviceScaleFactor = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 ||
      !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new Error(`invalid device "${value}"; width and height must be positive integers and scale must be positive`);
  }
  const touch = match[4] === 'touch';
  return { viewport: { width, height }, deviceScaleFactor, isMobile: touch, hasTouch: touch };
}

export function validateStorageState(file) {
  if (file === undefined || file === null || file === '') return undefined;
  const path = resolve(String(file));
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`storage state "${path}" is missing, unreadable, or invalid JSON`);
  }
  return path;
}

export function storageStateError(path) {
  return new Error(`storage state "${path}" could not be loaded`);
}

export function matchesBlockPattern(pattern, url) {
  const source = String(pattern);
  if (!source.includes('*')) return String(url).includes(source);
  const escaped = source.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`.*${escaped}.*`).test(String(url));
}

export function createBlockState(patterns = [], initial = { i: null, action: 'navigation' }) {
  return {
    patterns: Array.isArray(patterns) ? patterns.filter((p) => p !== undefined) : [],
    blocked: [],
    blockedRequests: new WeakSet(),
    active: initial,
    installed: false,
  };
}

export async function installBlockRouting(context, state) {
  if (!state || state.installed || state.patterns.length === 0) return;
  state.installed = true;
  // A single-star Playwright glob does not cross URL slashes. Keep the
  // policy matcher inside a real catch-all route callback.
  await context.route('**/*', async (route, suppliedRequest) => {
    const request = typeof route.request === 'function' ? route.request() : suppliedRequest;
    const url = request.url();
    if (state.patterns.some((pattern) => matchesBlockPattern(pattern, url))) {
      state.blockedRequests.add(request);
      const active = state.active || { i: null, action: 'navigation' };
      state.blocked.push({ method: request.method(), url, i: active.i ?? null, action: active.action || 'navigation' });
      await route.abort();
      return;
    }
    if (typeof route.continue === 'function') await route.continue();
    else await route.fallback();
  });
}
