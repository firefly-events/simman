import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseScenario } from '../scenario.mjs';
import { native, runFlow } from '../flow-runner.mjs';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function fakePage(sink, size = { width: 1280, height: 800 }) {
  let viewport = { ...size };
  return {
    viewportSize: () => viewport,
    setViewportSize: async (next) => { viewport = next; sink.push({ op: 'viewport', ...next }); },
    evaluate: async () => {},
    screenshot: async (o) => { sink.push({ op: 'screenshot', fullPage: o?.fullPage, viewport: { ...viewport } }); return PNG; },
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    on: () => {},
    off: () => {},
  };
}

const scenarioWith = (doStep) => `id: cap\nsteps:\n  - action: capture home\n    expected: home is captured\n    do: ${JSON.stringify(doStep)}\n`;

// ── authoring ─────────────────────────────────────────────────────────────────

test('a capture step compiles to a native capture act with its name and size', () => {
  const { overlay } = parseScenario(scenarioWith({ capture: 'home-calendar', width: 412, height: 915 }));
  assert.deepEqual(overlay.steps[0], { how: 'native', act: 'capture', args: { name: 'home-calendar', width: 412, height: 915 } });
});

test('a capture name must be a kebab screen name', () => {
  for (const name of ['Home', '../x', '', 'a b', '-lead']) {
    assert.throws(() => parseScenario(scenarioWith({ capture: name })), /capture needs a screen name/, name);
  }
});

test('a capture size must be an integer from 200 to 4000', () => {
  for (const width of [199, 4001, 41.5, '412']) {
    assert.throws(() => parseScenario(scenarioWith({ capture: 'home', width })), /width must be an integer from 200 to 4000/, String(width));
  }
});

// ── native ────────────────────────────────────────────────────────────────────

test('capture sets the viewport, then saves a full-page PNG named by the step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'simman-capture-'));
  try {
    const sink = [];
    const out = await native(fakePage(sink), { act: 'capture', args: { name: 'home', width: 412, height: 915 } }, { capturesDir: join(dir, 'shots') });
    assert.equal(out.capture, join(dir, 'shots', 'home.png'));
    assert.deepEqual(readFileSync(out.capture), PNG);
    assert.deepEqual(sink.at(-1), { op: 'screenshot', fullPage: true, viewport: { width: 412, height: 915 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture keeps the current viewport when no size is given, and keeps the other side when one is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'simman-capture-'));
  try {
    const sink = [];
    await native(fakePage(sink), { act: 'capture', args: { name: 'plain' } }, { capturesDir: dir });
    assert.ok(!sink.some((s) => s.op === 'viewport'), 'no viewport change without a size');
    await native(fakePage(sink), { act: 'capture', args: { name: 'wide', width: 1280 } }, { capturesDir: dir });
    assert.deepEqual(sink.find((s) => s.op === 'viewport'), { op: 'viewport', width: 1280, height: 800 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture without a captures directory throws instead of writing anywhere', async () => {
  await assert.rejects(native(fakePage([]), { act: 'capture', args: { name: 'home' } }, {}), /captures directory/);
});

// ── runFlow ───────────────────────────────────────────────────────────────────

test('a capture step passes on its file, records the path, and never asks the vision verifier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'simman-capture-'));
  try {
    const { scenario, overlay } = parseScenario(scenarioWith({ capture: 'home', width: 412, height: 915 }));
    // No provider is configured: a verify call would fail the step.
    const report = await runFlow(fakePage([]), scenario, overlay, { capturesDir: dir, verify: { provider: 'none-configured' } });
    assert.equal(report.flowPassed, true, JSON.stringify(report.steps));
    assert.equal(report.steps[0].capture, join(dir, 'home.png'));
    assert.equal(report.steps[0].why, 'capture written');
    assert.ok(existsSync(join(dir, 'home.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a capture step with no captures directory fails, and the flow does not pass', async () => {
  const { scenario, overlay } = parseScenario(scenarioWith({ capture: 'home' }));
  const report = await runFlow(fakePage([]), scenario, overlay, {});
  assert.equal(report.flowPassed, false);
  assert.match(report.steps[0].actError, /captures directory/);
  assert.equal(report.steps[0].capture, undefined);
});
