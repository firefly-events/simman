import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { run } from '../run.mjs';
import { synthesize } from '../../agent/synthesize.mjs';
import { PHONE, COOKIE_SECRET, fixture, browserHarness, captureIO, contextDevice, assertNoSecrets } from '../../engine/__tests__/phone-auth-block.helpers.mjs';

const URL = 'https://app.test';
const BLOCKED = 'https://stripe.test/write';
const args = (f, flags = []) => ['synthesize', URL, 'inspect the phone page', '--local', '--config', f.config, '--out', join(f.dir, 'plans'), ...flags];

test('synthesize guard: no feature flags installs no route and never adds storage state', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  assert.equal(await run(args(f), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts.length, 2, 'one exploration context, one approved execution context');
  assert.equal(h.routes.length, 0);
  assert.ok(h.contexts.every((o) => o.storageState === undefined));
});

test('synthesize flags reach BOTH exploration and approved execution contexts', async (t) => {
  const f = fixture(t), h = browserHarness(t, { initialRequests: [{ url: BLOCKED }] }), c = captureIO();
  assert.equal(await run(args(f, ['--device', '390x844@3,touch', '--storage-state', f.storageState, '--block', 'stripe.test', '--json']), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts.length, 2);
  for (const context of h.contexts) {
    assert.deepEqual(contextDevice(context), PHONE);
    assert.equal(context.storageState, f.storageState);
  }
  assert.equal(h.aborted.length, 2, 'exploration must be blocked as well as execution');
  assertNoSecrets(c.out.join('\n') + c.err.join('\n'));
});

test('synthesize config options reach BOTH contexts when flags are absent', async (t) => {
  const f = fixture(t), h = browserHarness(t, { initialRequests: [{ url: BLOCKED }] }), c = captureIO();
  f.writeConfig({ device: '390x844@3,touch', storageState: f.storageState, block: ['stripe.test'] });
  assert.equal(await run(args(f), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts.length, 2);
  for (const context of h.contexts) {
    assert.deepEqual(contextDevice(context), PHONE);
    assert.equal(context.storageState, f.storageState);
  }
  assert.equal(h.aborted.length, 2);
  assertNoSecrets(readFileSync(join(f.dir, 'plans', 'phone-plan.yaml'), 'utf8'));
});

test('synthesize CLI options replace config options for both phases', async (t) => {
  const f = fixture(t), c = captureIO();
  const h = browserHarness(t, { initialRequests: [{ url: BLOCKED }, { url: 'https://config-only.test/write' }] });
  f.writeConfig({ device: '360x780@2,touch', storageState: join(f.dir, 'overridden-missing.json'), block: ['config-only.test'] });
  assert.equal(await run(args(f, ['--device', '390x844@3,touch', '--storage-state', f.storageState, '--block', 'stripe.test']), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts.length, 2);
  for (const context of h.contexts) {
    assert.deepEqual(contextDevice(context), PHONE);
    assert.equal(context.storageState, f.storageState);
  }
  assert.deepEqual(h.aborted.map((r) => r.url), [BLOCKED, BLOCKED]);
  assert.equal(h.continued.filter((r) => r.url.includes('config-only.test')).length, 2);
});

test('synthesize --no-run still emulates, authenticates and blocks exploration', async (t) => {
  const f = fixture(t), h = browserHarness(t, { initialRequests: [{ url: BLOCKED }] }), c = captureIO();
  f.writeConfig({ device: '390x844@3,touch', storageState: f.storageState, block: ['stripe.test'] });
  assert.equal(await run(args(f, ['--no-run']), c.io), 0, c.err.join('\n'));
  assert.equal(h.contexts.length, 1);
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
  assert.equal(h.contexts[0].storageState, f.storageState);
  assert.equal(h.aborted.length, 1);
  assertNoSecrets(c.out.join('\n') + readFileSync(join(f.dir, 'plans', 'phone-plan.yaml'), 'utf8'));
});

test('synthesize routes before either navigation and includes exploration blocks in final JSON', async (t) => {
  const f = fixture(t), h = browserHarness(t, { initialRequests: [{ url: BLOCKED }] }), c = captureIO();
  f.writeConfig({ block: ['stripe.test'] });
  assert.equal(await run(args(f, ['--json']), c.io), 0, c.err.join('\n'));
  const events = h.events.filter(([name]) => ['route', 'goto'].includes(name)).map(([name]) => name);
  assert.deepEqual(events, ['route', 'goto', 'route', 'goto']);
  const report = JSON.parse(c.out.at(-1));
  assert.equal(report.blocked.length, 2, 'exploration evidence must survive into the final report');
  assert.deepEqual(report.blocked.map(({ method, url, i }) => ({ method, url, i })), [
    { method: 'POST', url: BLOCKED, i: null }, { method: 'POST', url: BLOCKED, i: null },
  ]);
  assert.ok(report.blocked.every((r) => typeof r.action === 'string' && r.action.length > 0));
});

test('synthesize malformed device returns validation error 2 before exploration', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  assert.equal(await run(args(f, ['--device', '390x844@0']), c.io), 2);
  assert.match(c.err.join('\n'), /device.*(?:invalid|must|expected|format)/i);
  assert.doesNotMatch(c.err.join('\n'), /unknown option/i);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.prompts.length, 0);
});

for (const input of ['flag', 'config']) {
  test(`synthesize missing storage state (${input}) exits 2 before exploration or model work`, async (t) => {
    const f = fixture(t), h = browserHarness(t), c = captureIO();
    const path = join(f.dir, 'missing.json');
    if (input === 'config') f.writeConfig({ storageState: path });
    assert.equal(await run(args(f, input === 'flag' ? ['--storage-state', path] : []), c.io), 2);
    assert.match(c.err.join('\n'), /storage.?state/i);
    assert.ok(c.err.join('\n').includes(path));
    assert.doesNotMatch(c.err.join('\n'), /unknown option/i);
    assert.equal(h.contexts.length, 0);
    assert.equal(h.prompts.length, 0);
  });
}

test('synthesize storage-state browser errors cannot leak cookies', async (t) => {
  const f = fixture(t), c = captureIO();
  browserHarness(t, { contextError: new Error(`storageState invalid: ${COOKIE_SECRET}`) });
  f.writeConfig({ storageState: f.storageState });
  assert.equal(await run(args(f), c.io), 2);
  assertNoSecrets(c.out.join('\n') + c.err.join('\n'));
  assert.ok(c.err.join('\n').includes(f.storageState));
});

test('agent synthesize itself uses phone/storage/block options before exploring', async (t) => {
  const f = fixture(t), h = browserHarness(t, { initialRequests: [{ url: BLOCKED }] });
  const plan = await synthesize({ url: URL, goal: 'inspect the phone page', providerCfg: { provider: 'mlx' },
    ...PHONE, storageState: f.storageState, block: ['stripe.test'] });
  assert.equal(plan.scenario.id, 'phone-plan');
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
  assert.equal(h.contexts[0].storageState, f.storageState);
  assert.deepEqual(h.aborted, [{ url: BLOCKED, method: 'POST' }]);
  assertNoSecrets(plan);
});
