import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderReport } from '../report.mjs';
import { run } from '../run.mjs';

const PLANS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plans');

function capture() {
  const out = [], err = [];
  return { io: { log: (s) => out.push(String(s)), errLog: (s) => err.push(String(s)) }, out, err };
}

test('renderReport: passing run', () => {
  const txt = renderReport({
    scenario: 'publish', model: 'gemini-2.5-flash', flowPassed: true, stepsPassed: '2/2', posted: true,
    steps: [
      { i: 0, how: 'native', pass: true, passBasis: 'native-act', action: 'Enter a caption' },
      { i: 1, how: 'vision', pass: true, passBasis: 'truth', truth: true, topmost: 'BUTTON', action: 'Publish' },
    ],
  });
  assert.match(txt, /scenario "publish"/);
  assert.match(txt, /✓ 1\. Enter a caption  \[native-act\]/);
  assert.match(txt, /✓ 2\. Publish  \[truth:pass  vision→BUTTON\]/);
  assert.match(txt, /PASS  2\/2 steps   truth 1\/1/);
});

test('renderReport: failing run shows why + glyph', () => {
  const txt = renderReport({
    scenario: 'x', flowPassed: false, stepsPassed: '0/1', posted: false,
    steps: [{ i: 0, how: 'vision', pass: false, passBasis: 'vision-verify', visionFound: false, why: 'not found', action: 'Click' }],
  });
  assert.match(txt, /✗ 1\. Click/);
  assert.match(txt, /why: not found/);
  assert.match(txt, /FAIL  0\/1 steps$/m);
});

test('renderReport: fatal entry', () => {
  const txt = renderReport({ scenario: 'x', flowPassed: false, stepsPassed: '0/1', posted: false, steps: [{ fatal: 'boom' }] });
  assert.match(txt, /‼ fatal: boom/);
});

test('run: no args prints usage, exit 2', async () => {
  const { io, out } = capture();
  assert.equal(await run([], io), 2);
  assert.match(out.join('\n'), /Usage:/);
});

test('run: --help exits 0', async () => {
  const { io, out } = capture();
  assert.equal(await run(['--help'], io), 0);
  assert.match(out.join('\n'), /simman run <scenario.yaml>/);
});

test('run: unknown command exits 2', async () => {
  const { io, err } = capture();
  assert.equal(await run(['frobnicate'], io), 2);
  assert.match(err.join('\n'), /unknown command/);
});

test('run: missing file path exits 2', async () => {
  const { io, err } = capture();
  assert.equal(await run(['run'], io), 2);
  assert.match(err.join('\n'), /scenario file path is required/);
});

test('run: unreadable scenario exits 2 with a clear error', async () => {
  const { io, err } = capture();
  assert.equal(await run(['run', '/no/such/file.yaml', '--local'], io), 2);
  assert.match(err.join('\n'), /cannot read scenario file/);
});

test('run: hosted provider without a key exits 2 with guidance', async () => {
  const saved = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY];
  delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
  try {
    const { io, err } = capture();
    assert.equal(await run(['run', join(PLANS, 'publish-simple.yaml')], io), 2);
    assert.match(err.join('\n'), /GEMINI_API_KEY/);
  } finally {
    if (saved[0] !== undefined) process.env.GEMINI_API_KEY = saved[0];
    if (saved[1] !== undefined) process.env.GOOGLE_API_KEY = saved[1];
  }
});
