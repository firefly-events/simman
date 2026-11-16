import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runActualFlow, visionTap } from '../flow-runner.mjs';
import { renderReport } from '../../cli/report.mjs';
import { PHONE, COOKIE_SECRET, fixture, browserHarness, contextDevice, clickPlan, assertNoSecrets } from './phone-auth-block.helpers.mjs';

const TARGET = 'https://app.test/api/orders';
const TRUTH = { kind: 'network', match: '/api/orders', method: 'POST' };
const emptyPlan = { scenario: { id: 'empty', steps: [] }, overlay: { scenario: 'empty', steps: [] } };

test('phone guard: no options keeps 1280x800 desktop and installs no routes', async (t) => {
  const h = browserHarness(t);
  const report = await runActualFlow(emptyPlan);
  assert.equal(report.flowPassed, true);
  assert.deepEqual(contextDevice(h.contexts[0]), { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  assert.equal(h.routes.length, 0);
});

test('phone guard: VIEWPORT_W/H still supply viewport without a device', async (t) => {
  const saved = [process.env.VIEWPORT_W, process.env.VIEWPORT_H];
  process.env.VIEWPORT_W = '360'; process.env.VIEWPORT_H = '780';
  t.after(() => {
    for (const [i, key] of ['VIEWPORT_W', 'VIEWPORT_H'].entries()) {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }
  });
  // DEFAULTS is currently evaluated at import time; isolate this import so the
  // guard tests the existing env contract, rather than demanding a new timing.
  const fresh = await import(`../flow-runner.mjs?phone-env=${Date.now()}`);
  const h = browserHarness(t);
  await fresh.runActualFlow(emptyPlan);
  assert.deepEqual(h.contexts[0].viewport, { width: 360, height: 780 });
  assert.equal(h.routes.length, 0);
});

test('phone: runActualFlow forwards all four context emulation options', async (t) => {
  const h = browserHarness(t);
  await runActualFlow({ ...emptyPlan, ...PHONE });
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
});

for (const coords of ['px', 'norm']) {
  test(`phone: runActualFlow carries touch and scale-3 viewport through to grounded action (${coords})`, async (t) => {
    const h = browserHarness(t);
    const report = await runActualFlow({
      scenario: { id: 'touch-flow', steps: [{ action: 'Continue', expected: 'ready' }] },
      overlay: { scenario: 'touch-flow', steps: [{ how: 'vision', target: 'Continue button' }] },
      ...PHONE, coords,
    });
    assert.equal(report.flowPassed, true);
    assert.deepEqual(report.steps[0].clicked, [195, 422]);
    assert.deepEqual(h.taps, [[195, 422]]);
    assert.deepEqual(h.clicks, []);
  });
}

test('phone guard: default vision action uses mouse at grounded CSS point', async (t) => {
  const h = browserHarness(t);
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const result = await visionTap(page, 'Continue', { coords: 'px' });
  assert.deepEqual(result.clicked, [640, 400]);
  assert.deepEqual(h.clicks, [[640, 400]]);
  assert.deepEqual(h.taps, []);
});

for (const coords of ['px', 'norm']) {
  test(`phone: touch lands on the same CSS point at scale 1 and 3 (${coords})`, async (t) => {
    const h = browserHarness(t);
    const browser = await chromium.launch();
    for (const deviceScaleFactor of [1, 3]) {
      const options = { ...PHONE, deviceScaleFactor };
      const page = await (await browser.newContext(options)).newPage();
      const result = await visionTap(page, 'Continue', { ...options, coords });
      assert.deepEqual(result.clicked, [195, 422], 'grounding image pixels/normalized units must map to CSS pixels');
    }
    assert.deepEqual(h.screenshots.map((s) => s.size), [[390, 844], [1170, 2532]]);
    assert.deepEqual(h.taps, [[195, 422], [195, 422]], 'hasTouch must use touchscreen.tap at CSS coordinates');
    assert.deepEqual(h.clicks, [], 'touch must not also mouse-click');
  });

  test(`phone: scale-3 full-page fallback scrolls in CSS px then re-grounds before tap (${coords})`, async (t) => {
    const h = browserHarness(t, { firstLocateAbsent: true });
    const browser = await chromium.launch();
    const page = await (await browser.newContext(PHONE)).newPage();
    const result = await visionTap(page, 'Continue', { ...PHONE, coords });
    assert.deepEqual(h.screenshots.map((s) => s.size), [[1170, 2532], [1170, 7200], [1170, 2532]]);
    assert.deepEqual(h.scrolls, [778], 'half of 2400 CSS document px minus half of 844 CSS viewport px');
    assert.deepEqual(result.clicked, [195, 422]);
    assert.deepEqual(h.taps, [[195, 422]]);
    assert.deepEqual(h.clicks, []);
  });
}

for (const coords of ['px', 'norm']) {
  for (const firstLocateAbsent of [false, true]) {
    test(`phone: grounding follows a capture resize (${coords}, fallback=${firstLocateAbsent})`, async (t) => {
      const f = fixture(t), h = browserHarness(t, { firstLocateAbsent });
      const report = await runActualFlow({
        scenario: { id: 'resized-phone', steps: [
          { action: 'Capture narrow phone', expected: 'capture saved' },
          { action: 'Continue', expected: 'ready' },
        ] },
        overlay: { scenario: 'resized-phone', steps: [
          { how: 'native', act: 'capture', args: { name: 'narrow', width: 360, height: 780 } },
          { how: 'vision', target: 'Continue button' },
        ] },
        ...PHONE, coords, capturesDir: f.dir,
      });
      assert.equal(report.flowPassed, true);
      assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
      assert.deepEqual(h.taps, [[180, 390]], 'use the current CSS viewport after a capture changes its size');
      assert.deepEqual(h.clicks, []);
      assert.deepEqual(h.screenshots.at(-2).size, [1080, 2340], 're-grounding retains scale 3');
      if (firstLocateAbsent) assert.deepEqual(h.scrolls, [810], 'scroll center uses the resized viewport height');
    });
  }
}

test('auth: engine passes only the storage-state path into newContext', async (t) => {
  const f = fixture(t), h = browserHarness(t);
  const report = await runActualFlow({ ...emptyPlan, storageState: f.storageState });
  assertNoSecrets(report);
  assert.equal(h.contexts[0].storageState, f.storageState);
});

test('auth: engine rejects a missing storage state before browser launch', async (t) => {
  const f = fixture(t), h = browserHarness(t);
  const path = join(f.dir, 'missing-state.json');
  await assert.rejects(runActualFlow({ ...emptyPlan, storageState: path }), (e) => {
    assert.match(e.message, /storage.?state/i);
    assert.ok(e.message.includes(path));
    assertNoSecrets(e.message);
    return true;
  });
  assert.equal(h.contexts.length, 0);
  assert.ok(!h.events.some(([name]) => name === 'launch'));
});

test('auth: context storage-state errors are sanitized even if Playwright echoes a cookie', async (t) => {
  const f = fixture(t);
  browserHarness(t, { contextError: new Error(`storageState parse failed: ${COOKIE_SECRET}`) });
  await assert.rejects(runActualFlow({ ...emptyPlan, storageState: f.storageState }), (e) => {
    assertNoSecrets(e.message);
    assert.match(e.message, /storage.?state/i);
    assert.ok(e.message.includes(f.storageState));
    return true;
  });
});

test('block guard: without patterns requests continue and network truth passes', async (t) => {
  const h = browserHarness(t, { actionRequests: [[{ url: TARGET }]] });
  const report = await runActualFlow(clickPlan(TRUTH));
  assert.equal(h.routes.length, 0);
  assert.deepEqual(h.aborted, []);
  assert.equal(report.flowPassed, true);
  assert.equal(report.steps[0].truth, true);
});

test('block: route is installed before initial navigation and aborts substring matches', async (t) => {
  const h = browserHarness(t, { initialRequests: [{ url: TARGET }] });
  await runActualFlow({ ...emptyPlan, block: ['/api/orders'] });
  assert.deepEqual(h.aborted, [{ url: TARGET, method: 'POST' }]);
  assert.ok(h.events.findIndex(([n]) => n === 'route') < h.events.findIndex(([n]) => n === 'goto'));
  assert.ok(h.continued.some((r) => r.url === 'http://localhost:3100/'));
});

test('block: simple star globs work and regexp punctuation stays literal', async (t) => {
  const blocked = 'https://billing.test/v1/a/charge?mode=live';
  const allowed = 'https://billingXtest/v1/a/charge?mode=live';
  const h = browserHarness(t, { initialRequests: [{ url: blocked }, { url: allowed }, { url: 'https://cdn.test/app.js', method: 'GET' }] });
  await runActualFlow({ ...emptyPlan, block: ['billing.test/v1/*/charge?mode=live'] });
  assert.deepEqual(h.aborted.map((r) => r.url), [blocked]);
  assert.ok(h.continued.some((r) => r.url === allowed));
  assert.ok(h.continued.some((r) => r.url === 'https://cdn.test/app.js'));
});

test('block: JSON records every blocked request once with zero-based step index and action', async (t) => {
  browserHarness(t, { actionRequests: [[{ url: TARGET }, { url: TARGET, method: 'DELETE' }]] });
  const report = await runActualFlow({ ...clickPlan(), block: ['/api/orders', 'app.test/api/*'] });
  assert.deepEqual(JSON.parse(JSON.stringify(report)).blocked, [
    { method: 'POST', url: TARGET, i: 0, action: 'Submit order' },
    { method: 'DELETE', url: TARGET, i: 0, action: 'Submit order' },
  ]);
});

test('block: initial-navigation requests have null step index and navigation action', async (t) => {
  browserHarness(t, { initialRequests: [{ url: TARGET }] });
  const report = await runActualFlow({ ...emptyPlan, block: ['/api/orders'] });
  assert.deepEqual(report.blocked, [{ method: 'POST', url: TARGET, i: null, action: 'navigation' }]);
});

test('block: aborted request emitted before route cannot satisfy network truth', async (t) => {
  const h = browserHarness(t, { actionRequests: [[{ url: TARGET }]] });
  const report = await runActualFlow({ ...clickPlan(TRUTH), block: ['/api/orders'] });
  assert.equal(report.steps[0].visionVerify, true, 'a positive vision judge must not mask blocked truth');
  assert.equal(report.steps[0].truth, false, 'a request event is not evidence when routing aborts it');
  assert.equal(report.steps[0].pass, false);
  assert.equal(report.steps[0].why, 'blocked');
  assert.equal(report.flowPassed, false);
  assert.deepEqual(h.aborted, [{ url: TARGET, method: 'POST' }]);
});

test('block: an allowed matching request still satisfies truth alongside a blocked one', async (t) => {
  browserHarness(t, { actionRequests: [[{ url: TARGET + '/blocked' }, { url: TARGET + '/allowed' }]] });
  const report = await runActualFlow({ ...clickPlan(TRUTH), block: ['/blocked'] });
  assert.equal(report.steps[0].truth, true);
  assert.equal(report.flowPassed, true);
  assert.equal(report.blocked?.length, 1);
});

test('block: legacy posted truth and posted report stay false for aborted writes', async (t) => {
  browserHarness(t, { actionRequests: [[{ url: 'https://app.test/api/social/post' }]] });
  const report = await runActualFlow({ ...clickPlan('posted'), block: ['/api/social/post'] });
  assert.equal(report.posted, false);
  assert.equal(report.steps[0].truth, false);
  assert.equal(report.steps[0].why, 'blocked');
});

test('block: report attributes requests to each active step rather than the last step', async (t) => {
  browserHarness(t, { actionRequests: [[{ url: TARGET }], [{ url: TARGET + '/2' }]] });
  const plan = clickPlan();
  plan.scenario.steps.push({ action: 'Retry order', expected: 'order accepted' });
  plan.overlay.steps.push({ ...plan.overlay.steps[0] });
  const report = await runActualFlow({ ...plan, block: ['/api/orders'] });
  assert.deepEqual(report.blocked?.map(({ i, action }) => ({ i, action })), [
    { i: 0, action: 'Submit order' }, { i: 1, action: 'Retry order' },
  ]);
});

test('block: human summary counts blocked requests', () => {
  const text = renderReport({ scenario: 'x', flowPassed: false, stepsPassed: '0/1', steps: [],
    blocked: [{ method: 'POST', url: TARGET, i: 0, action: 'Submit order' }, { method: 'GET', url: TARGET, i: 0, action: 'Submit order' }] });
  assert.match(text, /(?:blocked\s*[:=]?\s*2|2\s+(?:requests?\s+)?blocked)/i);
});
