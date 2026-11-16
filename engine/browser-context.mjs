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
    blockedRequestKeys: new Set(),
    active: initial,
    installed: false,
    handler: null,
    sessions: new Map(),
  };
}

function requestKey(method, url) { return `${method} ${url}`; }

function recordBlocked(state, method, url, request) {
  if (request && typeof request === 'object') state.blockedRequests.add(request);
  state.blockedRequestKeys.add(requestKey(method, url));
  const active = state.active || { i: null, action: 'navigation' };
  let safeUrl = String(url);
  try {
    const parsed = new URL(safeUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, 'REDACTED');
    safeUrl = parsed.toString();
  } catch { safeUrl = safeUrl.split('#')[0].replace(/([?&][^=&#]+)=([^&#]*)/g, '$1=[REDACTED]'); }
  state.blocked.push({ method, url: safeUrl, i: active.i ?? null, action: active.action || 'navigation' });
}

export async function installBlockRouting(context, state, page) {
  if (!state || state.installed || state.patterns.length === 0) return;
  state.installed = true;
  // A single-star Playwright glob does not cross URL slashes. Keep the
  // policy matcher inside a real catch-all route callback.
  state.handler = async (route, suppliedRequest) => {
    const request = typeof route.request === 'function' ? route.request() : suppliedRequest;
    const url = request.url();
    if (state.patterns.some((pattern) => matchesBlockPattern(pattern, url))) {
      recordBlocked(state, request.method(), url, request);
      await route.abort();
      return;
    }
    if (typeof route.fallback === 'function') await route.fallback();
    else await route.continue();
  };
  await context.route('**/*', state.handler);
  if (page) await installRedirectGuard(context, page, state);
}

/**
 * Chromium's Fetch domain sees redirect hops before they reach the wire. Attach
 * this before navigation on the page being driven; popup target chains that
 * start before a page event is delivered are outside this page-scoped guard.
 */
export async function installRedirectGuard(context, page, state) {
  if (!state || !state.patterns.length || state.sessions.has(page) || typeof context.newCDPSession !== 'function') return;
  let session;
  try { session = await context.newCDPSession(page); }
  catch { return; }
  state.sessions.set(page, session);
  session.on('Fetch.requestPaused', async (event) => {
    const { requestId, request, redirectedRequestId } = event;
    // Context routing handles initial requests and records their identity. CDP
    // is needed only for redirected hops, which Playwright does not route.
    if (!redirectedRequestId) {
      try { await session.send('Fetch.continueRequest', { requestId }); } catch { /* page may be closing */ }
      return;
    }
    if (state.patterns.some((pattern) => matchesBlockPattern(pattern, request.url))) {
      recordBlocked(state, request.method, request.url);
      try { await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); } catch { /* page may be closing */ }
      return;
    }
    try { await session.send('Fetch.continueRequest', { requestId }); }
    catch { /* page may be closing */ }
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

export async function removeBlockRouting(context, state) {
  if (!state) return;
  if (state.handler) await context.unroute('**/*', state.handler).catch(() => {});
  for (const session of state.sessions.values()) {
    try { await session.send('Fetch.disable'); } catch { /* page may be closing */ }
    try { await session.detach(); } catch { /* context may be closing */ }
  }
  state.sessions.clear();
}
