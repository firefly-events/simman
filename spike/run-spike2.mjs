/**
 * Spike 2 — AUTONOMOUS synthesis → gate → engine.
 *
 * Unlike spike 1 (hand-authored plan), here the agent/ layer turns a bare
 * natural-language goal + URL into the scenario + overlay itself. Then the same
 * gate approves it and the same engine executes it.
 *
 * Run:  node spike/run-spike2.mjs
 *       HEADLESS=false node spike/run-spike2.mjs
 *       SYNTH_MODEL=mlx-community/gemma-4-12B-it-qat-4bit node spike/run-spike2.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runActualFlow } from '../engine/flow-runner.mjs';
import { renderPlan, approveOrThrow } from '../gate/render.mjs';
import { synthesize } from '../agent/synthesize.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = 4174;
const MLX = process.env.MLX_URL || 'http://127.0.0.1:8089/v1/chat/completions';
const VL = process.env.MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';
const SYNTH_MODEL = process.env.SYNTH_MODEL || VL;
const headless = process.env.HEADLESS !== 'false';

// ── local target server ───────────────────────────────────────────────────────
const html = readFileSync(join(__dir, 'target/index.html'), 'utf8');
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/social/post')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(PORT, r));
const baseUrl = `http://localhost:${PORT}`;
console.error(`[spike2] target up at ${baseUrl}`);

const GOAL = process.env.GOAL
  || 'Write a caption in the compose box, publish the post, and confirm it was posted.';

try {
  // ── (1) AUTONOMOUS SYNTHESIS ────────────────────────────────────────────────
  console.error(`\n[spike2] synthesizing plan from bare goal via ${SYNTH_MODEL}...`);
  console.error(`         GOAL: ${GOAL}`);
  const plan = await synthesize({
    url: baseUrl, goal: GOAL, headless,
    providerCfg: { provider: 'mlx', endpoint: MLX, model: SYNTH_MODEL, timeoutMs: 90000 },
  });
  console.error('\n[spike2] AGENT-SYNTHESIZED PLAN (raw):');
  console.error(JSON.stringify({ scenario: plan.scenario, overlay: plan.overlay }, null, 2));

  // ── (2) GATE ──────────────────────────────────────────────────────────────
  console.error('\n──────── APPROVAL GATE ────────');
  console.error(renderPlan(plan.scenario, plan.overlay));
  approveOrThrow({ scenario: plan.scenario, overlay: plan.overlay, approved: process.env.REJECT !== '1', approver: 'spike-operator' });
  console.error('gate: APPROVED\n───────────────────────────────');

  // ── (3) ENGINE ──────────────────────────────────────────────────────────────
  const report = await runActualFlow({
    scenario: plan.scenario, overlay: plan.overlay,
    baseUrl, mlxEndpoint: MLX, mlxModel: VL,
    snapDom: false, headless, stepTimeoutMs: 60000,
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[spike2] VERDICT: flowPassed=${report.flowPassed} stepsPassed=${report.stepsPassed} posted=${report.posted}`);
  server.close();
  process.exit(report.flowPassed ? 0 : 1);
} catch (e) {
  server.close();
  console.error(`\n[spike2] FAILED: ${e.message}`);
  if (e.lastRaw) console.error(`[spike2] last model output:\n${e.lastRaw}`);
  process.exit(2);
}
