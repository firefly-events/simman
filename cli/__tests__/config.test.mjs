import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProviders, loadConfigFile, missingKeyRoles } from '../config.mjs';

const EMPTY = {};

test('default (no file, no flags): all roles hosted gemini, coords norm', () => {
  const r = resolveProviders({ flags: {}, env: { GEMINI_API_KEY: 'k' }, cwd: '/nonexistent-cwd' });
  assert.equal(r.grounding.provider, 'google');
  assert.equal(r.grounding.model, 'gemini-2.5-flash');
  assert.equal(r.grounding.thinkingBudget, 0);
  assert.equal(r.grounding.maxTokens, 2048);
  assert.equal(r.grounding.apiKey, 'k');
  assert.equal(r.verify.provider, 'google');
  assert.equal(r.synth.provider, 'google');
  assert.equal(r.coords, 'norm');
});

test('--local: all roles mlx, coords px, endpoint set', () => {
  const r = resolveProviders({ flags: { local: true }, env: EMPTY, cwd: '/nonexistent-cwd' });
  for (const role of ['grounding', 'verify', 'synth']) {
    assert.equal(r[role].provider, 'mlx');
    assert.equal(r[role].apiKey, undefined);
  }
  assert.equal(r.grounding.endpoint, 'http://127.0.0.1:8089/v1/chat/completions');
  assert.equal(r.grounding.model, 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit');
  assert.equal(r.coords, 'px');
});

test('--provider mlx forces all roles local', () => {
  const r = resolveProviders({ flags: { provider: 'mlx' }, env: EMPTY, cwd: '/nonexistent-cwd' });
  assert.equal(r.grounding.provider, 'mlx');
  assert.equal(r.coords, 'px');
});

test('--coords overrides the inferred convention', () => {
  const r = resolveProviders({ flags: { coords: 'px' }, env: { GEMINI_API_KEY: 'k' }, cwd: '/nonexistent-cwd' });
  assert.equal(r.grounding.provider, 'google');
  assert.equal(r.coords, 'px');
});

test('config file hybrid: grounding mlx + synth google; coords follows grounding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simman-cfg-'));
  try {
    writeFileSync(join(dir, 'simman.config.yaml'),
      'provider: google\ngrounding: { provider: mlx }\nverify: { provider: mlx }\nsynth: { provider: google, model: gemini-2.5-flash }\n');
    const r = resolveProviders({ flags: {}, env: { GEMINI_API_KEY: 'k' }, cwd: dir });
    assert.equal(r.grounding.provider, 'mlx');
    assert.equal(r.verify.provider, 'mlx');
    assert.equal(r.synth.provider, 'google');
    assert.equal(r.synth.model, 'gemini-2.5-flash');
    assert.equal(r.coords, 'px'); // follows grounding (mlx)
    assert.equal(r.configPath, join(dir, 'simman.config.yaml'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI --local overrides a hosted config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simman-cfg-'));
  try {
    writeFileSync(join(dir, 'simman.config.yaml'), 'provider: google\n');
    const r = resolveProviders({ flags: { local: true }, env: EMPTY, cwd: dir });
    assert.equal(r.grounding.provider, 'mlx');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missingKeyRoles: flags hosted roles without a key', () => {
  const hostedNoKey = resolveProviders({ flags: {}, env: {}, cwd: '/nonexistent-cwd' });
  assert.deepEqual(missingKeyRoles(hostedNoKey, ['grounding', 'verify']).sort(), ['grounding', 'verify']);
  const withKey = resolveProviders({ flags: {}, env: { GEMINI_API_KEY: 'k' }, cwd: '/nonexistent-cwd' });
  assert.deepEqual(missingKeyRoles(withKey, ['grounding', 'verify']), []);
  const local = resolveProviders({ flags: { local: true }, env: {}, cwd: '/nonexistent-cwd' });
  assert.deepEqual(missingKeyRoles(local, ['grounding', 'verify']), []);
});

test('loadConfigFile: malformed file throws CONFIG_INVALID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simman-cfg-'));
  try {
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    assert.throws(() => loadConfigFile(join(dir, 'bad.json')), (e) => e.code === 'CONFIG_INVALID');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfigFile: no file → empty data, null path', () => {
  const r = loadConfigFile(undefined, '/nonexistent-cwd');
  assert.equal(r.path, null);
  assert.deepEqual(r.data, {});
});
