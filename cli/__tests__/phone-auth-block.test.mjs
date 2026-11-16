import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { run } from '../run.mjs';
import { PHONE, STATE, COOKIE_SECRET, fixture, browserHarness, captureIO, contextDevice, assertNoSecrets } from '../../engine/__tests__/phone-auth-block.helpers.mjs';

const args = (f, flags = []) => ['run', f.file, '--local', '--config', f.config, ...flags];

test('CLI phone guard: no feature flags keeps desktop, mouse, and no routing', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeScenario([{ action: 'Continue', expected: 'ready', do: { vision: 'Continue button' } }]);
  assert.equal(await run(args(f), c.io), 0, c.err.join('\n'));
  assert.deepEqual(contextDevice(h.contexts[0]), { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  assert.deepEqual(h.clicks, [[640, 400]]);
  assert.deepEqual(h.taps, []);
  assert.equal(h.routes.length, 0);
});

const validDevices = [
  ['390x844', { viewport: PHONE.viewport, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
  ['390x844,touch', { ...PHONE, deviceScaleFactor: 1 }],
  ['390x844@3', { ...PHONE, isMobile: false, hasTouch: false }],
  ['390x844@3,touch', PHONE],
  ['360x780@1.5,touch', { viewport: { width: 360, height: 780 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true }],
];
for (const [device, expected] of validDevices) {
  test(`CLI device parses ${device} and wires context options`, async (t) => {
    const f = fixture(t), h = browserHarness(t), c = captureIO();
    assert.equal(await run(args(f, ['--device', device]), c.io), 0, c.err.join('\n'));
    assert.deepEqual(contextDevice(h.contexts[0]), expected);
  });
}

for (const device of ['', 'phone', '390', '390x', '390x844junk', '0x844', '-390x844', '390.5x844', '390x844@0', '390x844@-1', '390x844@NaN', '390x844@Infinity', '390x844,mouse', '390x844,touch,touch']) {
  test(`CLI malformed device ${JSON.stringify(device)} exits 2 with a device validation error`, async (t) => {
    const f = fixture(t), h = browserHarness(t), c = captureIO();
    assert.equal(await run(args(f, [`--device=${device}`]), c.io), 2);
    assert.match(c.err.join('\n'), /device.*(?:invalid|must|expected|format)/i);
    assert.doesNotMatch(c.err.join('\n'), /unknown option/i, 'red must be device validation, not accepting any parse error as success');
    assert.equal(h.contexts.length, 0);
  });
}

test('CLI device precedence: flag replaces config and VIEWPORT env', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ device: '360x780@2,touch' });
  const saved = [process.env.VIEWPORT_W, process.env.VIEWPORT_H];
  process.env.VIEWPORT_W = '900'; process.env.VIEWPORT_H = '600';
  t.after(() => {
    for (const [i, key] of ['VIEWPORT_W', 'VIEWPORT_H'].entries()) {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }
  });
  assert.equal(await run(args(f, ['--device', '390x844@3,touch']), c.io), 0, c.err.join('\n'));
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
});

test('CLI device precedence: config replaces env and defaults', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ device: '390x844@3,touch' });
  const saved = process.env.VIEWPORT_W;
  process.env.VIEWPORT_W = '900';
  t.after(() => { if (saved === undefined) delete process.env.VIEWPORT_W; else process.env.VIEWPORT_W = saved; });
  assert.equal(await run(args(f), c.io), 0, c.err.join('\n'));
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
});

test('CLI malformed config device exits 2 before launching a browser', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ device: '390x844@0' });
  assert.equal(await run(args(f), c.io), 2);
  assert.match(c.err.join('\n'), /device/i);
  assert.equal(h.contexts.length, 0);
});

test('CLI storage-state flag overrides config and only its path reaches context', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ storageState: join(f.dir, 'overridden-missing.json') });
  assert.equal(await run(args(f, ['--storage-state', f.storageState]), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts[0].storageState, f.storageState);
  assertNoSecrets(c.out.join('\n') + c.err.join('\n'));
});

test('CLI storageState config is used when no flag is given', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ storageState: f.storageState });
  assert.equal(await run(args(f), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts[0].storageState, f.storageState);
});

for (const kind of ['missing', 'unreadable-directory']) {
  test(`CLI ${kind} storage-state file exits 2 with path and no browser launch`, async (t) => {
    const f = fixture(t), h = browserHarness(t), c = captureIO();
    const path = kind === 'missing' ? join(f.dir, 'missing.json') : f.dir;
    assert.equal(await run(args(f, ['--storage-state', path]), c.io), 2);
    assert.match(c.err.join('\n'), /storage.?state/i);
    assert.ok(c.err.join('\n').includes(path), 'diagnostic must identify the file');
    assert.doesNotMatch(c.err.join('\n'), /unknown option/i);
    assertNoSecrets(c.err);
    assert.equal(h.contexts.length, 0);
  });
}

test('CLI missing storageState in config exits 2 with path', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  const path = join(f.dir, 'missing.json');
  f.writeConfig({ storageState: path });
  assert.equal(await run(args(f), c.io), 2);
  assert.match(c.err.join('\n'), /storage.?state/i);
  assert.ok(c.err.join('\n').includes(path));
  assert.equal(h.contexts.length, 0);
});

for (const json of [false, true]) {
  test(`CLI auth never leaks state into ${json ? 'JSON report' : 'human summary'} or capture metadata`, async (t) => {
    const f = fixture(t), h = browserHarness(t), c = captureIO();
    f.writeConfig({ storageState: f.storageState });
    f.writeScenario([{ action: 'Capture phone', expected: 'captured', do: { capture: 'phone' } }]);
    const captures = join(f.dir, 'captures');
    assert.equal(await run(args(f, ['--captures', captures, ...(json ? ['--json'] : [])]), c.io), 0, c.err.join('\n'));
    assertNoSecrets(c.out.join('\n') + c.err.join('\n'));
    const files = readdirSync(captures);
    assert.ok(files.includes('phone.png'));
    for (const name of files) assertNoSecrets(readFileSync(join(captures, name)).toString('utf8'));
    if (json) {
      const report = JSON.parse(c.out.at(-1));
      assert.equal(report.steps[0].capture, join(captures, 'phone.png'));
      assertNoSecrets(report);
    }
    assert.equal(h.contexts[0].storageState, f.storageState, 'state must actually be wired for this secrecy test');
  });
}

test('CLI invalid storage-state JSON errors identify path without echoing tokens', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  writeFileSync(f.storageState, `{"cookies": ${COOKIE_SECRET}`);
  f.writeConfig({ storageState: f.storageState });
  assert.equal(await run(args(f), c.io), 2);
  assertNoSecrets(c.err);
  assert.ok(c.err.join('\n').includes(f.storageState));
  assert.match(c.err.join('\n'), /storage.?state/i);
  assert.equal(h.contexts.length, 0);
});

test('CLI storage-state browser errors do not echo secret values', async (t) => {
  const f = fixture(t), c = captureIO();
  browserHarness(t, { contextError: new Error(`Invalid storageState cookies: ${JSON.stringify(STATE)}`) });
  f.writeConfig({ storageState: f.storageState });
  assert.equal(await run(args(f), c.io), 2);
  assertNoSecrets(c.out.join('\n') + c.err.join('\n'));
  assert.ok(c.err.join('\n').includes(f.storageState));
});

test('CLI repeatable --block replaces config patterns and is visible in JSON', async (t) => {
  const f = fixture(t), c = captureIO();
  const h = browserHarness(t, { initialRequests: [
    { url: 'https://stripe.test/write' }, { url: 'https://billing.test/a/charge' }, { url: 'https://config-only.test/write' },
  ] });
  f.writeConfig({ block: ['config-only.test'] });
  assert.equal(await run(args(f, ['--block', 'stripe.test', '--block', 'billing.test/*/charge', '--json']), c.io), 0, c.err.join('\n'));
  assert.deepEqual(h.aborted.map((r) => r.url), ['https://stripe.test/write', 'https://billing.test/a/charge']);
  assert.ok(h.continued.some((r) => r.url.includes('config-only.test')), 'CLI array replaces rather than merges config');
  const report = JSON.parse(c.out.at(-1));
  assert.equal(report.blocked.length, 2);
});

test('CLI block config works without flags and human summary counts it', async (t) => {
  const f = fixture(t), h = browserHarness(t, { initialRequests: [{ url: 'https://stripe.test/write' }] }), c = captureIO();
  f.writeConfig({ block: ['stripe.test'] });
  assert.equal(await run(args(f), c.io), 0, c.err.join('\n'));
  assert.equal(h.aborted.length, 1);
  assert.match(c.out.join('\n'), /(?:blocked\s*[:=]?\s*1|1\s+(?:requests?\s+)?blocked)/i);
});

test('CLI blocked network truth returns flow-failure exit 1 and reason blocked', async (t) => {
  const f = fixture(t), c = captureIO();
  browserHarness(t, { actionRequests: [[{ url: 'https://app.test/api/orders' }]] });
  f.writeConfig({ block: ['/api/orders'] });
  f.writeScenario([{ action: 'Submit order', expected: 'accepted', do: { tapRole: 'Submit' }, truth: { kind: 'network', match: '/api/orders', method: 'POST' } }]);
  assert.equal(await run(args(f, ['--json']), c.io), 1);
  const report = JSON.parse(c.out.at(-1));
  assert.equal(report.steps[0].truth, false);
  assert.equal(report.steps[0].why, 'blocked');
  assert.equal(report.blocked.length, 1);
});

test('CLI help documents all three flags and device syntax', async () => {
  const c = captureIO();
  assert.equal(await run(['--help'], c.io), 0);
  for (const flag of ['--device', '--storage-state', '--block']) assert.ok(c.out.join('\n').includes(flag), `${flag} missing from help`);
  assert.match(c.out.join('\n'), /390x844@3,touch|width.*height/i);
});
