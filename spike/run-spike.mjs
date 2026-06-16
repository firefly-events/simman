/**
 * Spike 1 — synthesis → gate → engine loop on a real browser + live MLX vision.
 *
 * Proves the core SimMan thesis end-to-end against a controlled local target:
 *   (1) synthesis  — hand-authored here (agent/ layer not built yet; I am the agent)
 *   (2) gate       — render the plan, require approval
 *   (3) engine     — drive real Chromium + Qwen2.5-VL grounding, return verdict
 *
 * Run:  node spike/run-spike.mjs            (headless)
 *       HEADLESS=false node spike/run-spike.mjs
 *       REJECT=1 node spike/run-spike.mjs   (prove the gate blocks)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runActualFlow } from '../engine/flow-runner.mjs';
import { renderPlan, approveOrThrow } from '../gate/render.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = 4173;
const MLX = process.env.MLX_URL || 'http://127.0.0.1:8089/v1/chat/completions';
const MODEL = process.env.MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';

// ── local target server (deterministic, no auth) ──────────────────────────────
const html = readFileSync(join(__dir, 'target/index.html'), 'utf8');
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/social/post')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(PORT, r));
const baseUrl = `http://localhost:${PORT}`;
console.error(`[spike] target up at ${baseUrl}`);

// ── (1) SYNTHESIS — hand-authored stand-in for the agent/ layer ───────────────
const scenario = {
  id: 'spike-compose-post',
  baseUrl,
  steps: [
    { action: 'Enter a caption in the compose box', expected: 'The Post Now button becomes enabled' },
    { action: 'Click the Post Now button', expected: 'A "Posted!" confirmation message is shown' },
  ],
};
const overlay = {
  scenario: 'spike-compose-post',
  steps: [
    { how: 'native', act: 'fill', args: { selector: '#caption', value: 'Launch day is here' }, truth: 'cta_enabled' },
    { how: 'vision', target: 'the blue "Post Now" button', truth: 'posted' },
  ],
};

// ── (2) GATE ──────────────────────────────────────────────────────────────────
console.error('\n──────── APPROVAL GATE ────────');
console.error(renderPlan(scenario, overlay));
const approval = approveOrThrow({
  scenario, overlay,
  approved: process.env.REJECT !== '1',
  approver: 'spike-operator',
});
console.error(`gate: APPROVED by ${approval.approver}`);
console.error('───────────────────────────────\n');

// ── (3) ENGINE ──────────────────────────────────────────────────────────────
let report;
try {
  report = await runActualFlow({
    scenario, overlay,
    mlxEndpoint: MLX,
    mlxModel: MODEL,
    baseUrl,
    headless: process.env.HEADLESS !== 'false',
    snapDom: false,
    stepTimeoutMs: 60000,
  });
} finally {
  server.close();
}

console.log(JSON.stringify(report, null, 2));
console.error(`\n[spike] VERDICT: flowPassed=${report.flowPassed} stepsPassed=${report.stepsPassed} posted=${report.posted}`);
process.exit(report.flowPassed ? 0 : 1);
