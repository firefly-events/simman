import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONE, fixture, browserHarness, captureIO, contextDevice } from '../../engine/__tests__/phone-auth-block.helpers.mjs';

// node --test isolates files. Set env before importing run's transitive engine
// dependency, respecting today's import-time DEFAULTS evaluation.
process.env.VIEWPORT_W = '360';
process.env.VIEWPORT_H = '780';
const { run } = await import('../run.mjs');

test('CLI env guard: without device, VIEWPORT env overrides built-in desktop dimensions', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  assert.equal(await run(['run', f.file, '--local', '--config', f.config], c.io), 0, c.err.join('\n'));
  assert.deepEqual(contextDevice(h.contexts[0]), { viewport: { width: 360, height: 780 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  assert.equal(h.routes.length, 0);
});

test('CLI device config overrides viewport env established before module load', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ device: '390x844@3,touch' });
  assert.equal(await run(['run', f.file, '--local', '--config', f.config], c.io), 0, c.err.join('\n'));
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
});

test('CLI device flag overrides both config and import-time viewport env', async (t) => {
  const f = fixture(t), h = browserHarness(t), c = captureIO();
  f.writeConfig({ device: '412x915@2,touch' });
  assert.equal(await run(['run', f.file, '--local', '--config', f.config, '--device', '390x844@3,touch'], c.io), 0, c.err.join('\n'));
  assert.deepEqual(contextDevice(h.contexts[0]), PHONE);
});
