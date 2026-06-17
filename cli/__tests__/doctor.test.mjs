import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { checkNode, checkProvider, checkMlx, checkPlaywright, doctor } from '../doctor.mjs';

test('checkNode: meets / fails the floor', () => {
  assert.equal(checkNode('22.5.0').status, 'ok');
  assert.equal(checkNode('20.19.0').status, 'ok');
  assert.equal(checkNode('20.18.0').status, 'fail');
  assert.equal(checkNode('18.20.0').status, 'fail');
});

test('checkProvider: key present / absent / local', () => {
  assert.equal(checkProvider({ GEMINI_API_KEY: 'x' }).status, 'ok');
  assert.equal(checkProvider({ GOOGLE_API_KEY: 'x' }).status, 'ok');
  const miss = checkProvider({});
  assert.equal(miss.status, 'fail');
  assert.match(miss.fix, /GEMINI_API_KEY/);
  assert.equal(checkProvider({}, { local: true }).status, 'skip');
});

test('checkMlx: skip in hosted, ok/fail in local', async () => {
  assert.equal((await checkMlx({ local: false })).status, 'skip');
  assert.equal((await checkMlx({ local: true, fetchImpl: async () => ({ ok: true, status: 200 }) })).status, 'ok');
  assert.equal((await checkMlx({ local: true, fetchImpl: async () => ({ ok: false, status: 500 }) })).status, 'fail');
  assert.equal((await checkMlx({ local: true, fetchImpl: async () => { throw new Error('refused'); } })).status, 'fail');
});

test('checkPlaywright: installed / missing path / import fails', async () => {
  const ok = await checkPlaywright(async () => ({ executablePath: () => execPath }));
  assert.equal(ok.status, 'ok');
  const missing = await checkPlaywright(async () => ({ executablePath: () => '/no/such/chromium' }));
  assert.equal(missing.status, 'fail');
  assert.match(missing.fix, /playwright install/);
  const broken = await checkPlaywright(async () => { throw new Error('not installed'); });
  assert.equal(broken.status, 'fail');
});

function cap() { const out = []; return { out, io: { log: (s) => out.push(String(s)) } }; }

test('doctor: all required pass → exit 0', async () => {
  const { io, out } = cap();
  const code = await doctor({ local: false }, {
    ...io, env: { GEMINI_API_KEY: 'x' },
    deps: { loadChromium: async () => ({ executablePath: () => execPath }) },
  });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /OK — ready to run/);
});

test('doctor: missing key → exit 1', async () => {
  const { io, out } = cap();
  const code = await doctor({ local: false }, {
    ...io, env: {},
    deps: { loadChromium: async () => ({ executablePath: () => execPath }) },
  });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /NOT READY/);
});

test('doctor --fix: installs missing chromium and recovers', async () => {
  const { io, out } = cap();
  let fixRan = false;
  const code = await doctor({ local: false, fix: true }, {
    ...io, env: { GEMINI_API_KEY: 'x' },
    runFix: () => { fixRan = true; },
    deps: { loadChromium: async () => ({ executablePath: () => '/no/such/chromium' }) },
  });
  assert.equal(fixRan, true);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /installed via --fix/);
});
