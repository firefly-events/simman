import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderConfig, askVision, RECOMMENDED_LOCAL_MODELS } from '../providers.mjs';

// ── resolveProviderConfig ───────────────────────────────────────────────────────

test('defaults to local mlx provider', () => {
  const cfg = resolveProviderConfig({}, 'grounding');
  assert.equal(cfg.provider, 'mlx');
});

test('legacy opts.mlx maps to endpoint', () => {
  const cfg = resolveProviderConfig({ mlx: 'http://x:1/v1/chat/completions', model: 'm' }, 'grounding');
  assert.equal(cfg.endpoint, 'http://x:1/v1/chat/completions');
  assert.equal(cfg.model, 'm');
});

test('per-role override beats global', () => {
  const opts = {
    provider: 'mlx', model: 'local-vl',
    verify: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  const g = resolveProviderConfig(opts, 'grounding');
  const v = resolveProviderConfig(opts, 'verify');
  assert.equal(g.provider, 'mlx');
  assert.equal(g.model, 'local-vl');
  assert.equal(v.provider, 'anthropic');
  assert.equal(v.model, 'claude-sonnet-4-6');
});

// ── askVision guard rails (no network — throw before fetch) ─────────────────────

test('unknown provider throws', async () => {
  await assert.rejects(() => askVision('b64', 'prompt', { provider: 'nope' }), /unknown vision provider/);
});

test('anthropic without key throws actionable error', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(() => askVision('b64', 'p', { provider: 'anthropic' }), /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('google without key throws actionable error', async () => {
  const saved = [process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY];
  delete process.env.GOOGLE_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  try {
    await assert.rejects(() => askVision('b64', 'p', { provider: 'google' }), /GOOGLE_API_KEY|GEMINI_API_KEY/);
  } finally {
    if (saved[0] !== undefined) process.env.GOOGLE_API_KEY = saved[0];
    if (saved[1] !== undefined) process.env.GEMINI_API_KEY = saved[1];
    if (saved[2] !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved[2];
  }
});

// ── recommended models catalog ──────────────────────────────────────────────────

test('recommends local grounding models (spatial-VL)', () => {
  assert.ok(RECOMMENDED_LOCAL_MODELS.grounding.length >= 1);
  assert.ok(RECOMMENDED_LOCAL_MODELS.grounding.every((m) => typeof m.id === 'string'));
});
