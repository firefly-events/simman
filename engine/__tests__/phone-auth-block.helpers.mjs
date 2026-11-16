// Shared offline fakes. This is test support, never production implementation.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';

export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
export const COOKIE_SECRET = 'COOKIE_SECRET_DO_NOT_PRINT_7c39';
export const TOKEN_SECRET = 'LOCAL_TOKEN_DO_NOT_PRINT_f682';
export const STATE = {
  cookies: [{ name: 'session', value: COOKIE_SECRET, domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://app.test', localStorage: [{ name: 'token', value: TOKEN_SECRET }] }],
};

export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'simman-phone-auth-block-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  writeFileSync(config, '{}');
  const storageState = join(dir, 'signed-in.json');
  writeFileSync(storageState, JSON.stringify(STATE));
  const file = join(dir, 'scenario.yaml');
  const writeScenario = (steps = [{ action: 'Wait', expected: 'ready', do: { wait: 1 } }]) => {
    writeFileSync(file, JSON.stringify({ id: 'phone-check', baseUrl: 'https://app.test', steps }));
  };
  writeScenario();
  return { dir, file, config, storageState, writeScenario,
    writeConfig: (data) => writeFileSync(config, JSON.stringify(data)) };
}

export function captureIO() {
  const out = [], err = [];
  return { out, err, io: { log: (s) => out.push(String(s)), errLog: (s) => err.push(String(s)), decide: () => ({ action: 'approve' }) } };
}

export function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [COOKIE_SECRET, TOKEN_SECRET]) assert.ok(!text.includes(secret), 'storage-state secret leaked');
}

// A PNG header is enough for the runner's pngSize reader; no image decoder runs.
function png(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function routeMatches(pattern, url) {
  if (typeof pattern === 'function') return pattern(new URL(url));
  if (pattern instanceof RegExp) return pattern.test(url);
  // Playwright matches the whole URL: a single star cannot cross '/', while
  // double stars can. Treating every star as .* hides broken route registration.
  const re = String(pattern).split(/(\*+)/).map((part) => {
    if (part === '*') return '[^/]*';
    if (part.startsWith('**')) return '.*';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${re}$`).test(url);
}

export function browserHarness(t, {
  initialRequests = [], actionRequests = [], firstLocateAbsent = false, contextError,
} = {}) {
  const h = { contexts: [], routes: [], aborted: [], continued: [], clicks: [], taps: [], events: [], prompts: [], screenshots: [], scrolls: [] };
  let action = 0;
  let located = 0;
  const plan = {
    scenario: { id: 'phone-plan', steps: [{ action: 'Wait', expected: 'ready' }] },
    overlay: { scenario: 'phone-plan', steps: [{ how: 'native', act: 'wait', args: { ms: 1 } }] },
  };
  // Never fall back to real fetch, even if a test assertion fails.
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    const content = body.messages?.[0]?.content;
    assert.ok(Array.isArray(content), 'offline fixture expects --local / MLX');
    const prompt = content.find((c) => c.type === 'text')?.text || '';
    h.prompts.push(prompt);
    let answer;
    if (prompt.includes('Where is the element')) {
      located++;
      const b64 = content.find((c) => c.type === 'image_url').image_url.url.split(',')[1];
      const image = Buffer.from(b64, 'base64');
      const W = image.readUInt32BE(16), H = image.readUInt32BE(20);
      answer = firstLocateAbsent && located === 1 ? { x: 0, y: 0 }
        : prompt.includes('normalized 0-1000') ? { x: 500, y: 500 }
        : { x: W / 2, y: H / 2 };
    } else if (prompt.includes('web UI test planner')) answer = plan;
    else if (prompt.includes('EXPECTED result')) answer = { pass: true, why: 'visible' };
    else assert.fail('unexpected model prompt in offline fixture');
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  });
  t.mock.method(chromium, 'launch', async (options) => {
    h.events.push(['launch', options]);
    return {
      newContext: async (options = {}) => {
        h.contexts.push(options);
        if (contextError) throw contextError;
        let viewport = options.viewport || { width: 1280, height: 720 };
        const scale = options.deviceScaleFactor ?? 1;
        const routes = [];
        const page = new EventEmitter();
        const context = {
          route: async (pattern, handler) => { h.routes.push({ pattern, handler }); routes.push({ pattern, handler }); h.events.push(['route']); },
          unroute: async () => {},
          close: async () => {},
          newPage: async () => page,
        };
        const dispatch = async ({ url, method = 'POST' }) => {
          const req = { url: () => url, method: () => method, isNavigationRequest: () => false };
          // Playwright emits request before a route callback decides its fate.
          page.emit('request', req);
          const route = {
            request: () => req,
            abort: async () => { h.aborted.push({ url, method }); h.events.push(['abort', url]); },
            continue: async () => { h.continued.push({ url, method }); },
            fallback: async () => { h.continued.push({ url, method }); },
          };
          const matching = routes.findLast((r) => routeMatches(r.pattern, url));
          if (matching) await matching.handler(route, req);
          else await route.continue();
        };
        const click = async (sink, point) => {
          sink.push(point);
          for (const request of (actionRequests[action++] || [])) await dispatch(request);
        };
        const locator = {
          count: async () => 1, first() { return this; }, filter() { return this; },
          click: async () => click(h.clicks, 'native'),
          tap: async () => click(h.taps, 'native'),
          waitFor: async () => {},
        };
        Object.assign(page, {
          context: () => context,
          viewportSize: () => viewport,
          setViewportSize: async (next) => { viewport = next; },
          goto: async (url) => {
            h.events.push(['goto', url]);
            await dispatch({ url, method: 'GET' });
            for (const request of initialRequests) await dispatch(request);
          },
          waitForLoadState: async () => {}, waitForTimeout: async () => {},
          evaluate: async (fn, arg) => {
            if (String(fn).includes('scrollHeight') && !String(fn).includes('performance.now')) return 2400;
            if (typeof arg === 'number') h.scrolls.push(arg);
            if (Array.isArray(arg)) return 'BUTTON.primary';
          },
          screenshot: async (o = {}) => {
            const size = [viewport.width * scale, (o.fullPage ? 2400 : viewport.height) * scale];
            h.screenshots.push({ fullPage: !!o.fullPage, size });
            return png(...size);
          },
          $$eval: async () => [],
          mouse: { click: async (x, y) => click(h.clicks, [x, y]) },
          touchscreen: { tap: async (x, y) => click(h.taps, [x, y]) },
          getByRole: () => locator, getByText: () => locator,
        });
        h.page = page;
        return context;
      },
      close: async () => { h.events.push(['close']); },
    };
  });
  return h;
}

export function contextDevice(context = {}) {
  return { viewport: context.viewport || { width: 1280, height: 720 },
    deviceScaleFactor: context.deviceScaleFactor ?? 1,
    isMobile: context.isMobile ?? false, hasTouch: context.hasTouch ?? false };
}

export const clickPlan = (truth) => ({
  scenario: { id: 'blocked-check', steps: [{ action: 'Submit order', expected: 'order accepted' }] },
  overlay: { scenario: 'blocked-check', steps: [{ how: 'native', act: 'tapRole', args: { name: 'Submit' }, ...(truth ? { truth } : {}) }] },
});
