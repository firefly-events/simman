/**
 * Spike 3 — DENSE UI: synthesis discrimination + grounding among lookalikes.
 *
 * The spike-1/2 target was a single form. This target adds distractors (a nav of
 * decoy buttons, secondary "Save Draft"/"Schedule", a decoy blue "Boost Post"
 * right beside the real "Post Now"), a multi-field gate (title AND caption), and
 * pushes the real CTA below the fold (scroll).
 *
 * Part A — AUTONOMOUS: bare goal → agent synthesizes a plan on the dense DOM →
 *          gate → engine. Tests whether synthesis picks the right elements +
 *          required fields + truth-signals while ignoring decoys.
 * Part B — FORCED VISION: a hand-authored overlay that fills title+caption
 *          natively, then taps "Post Now" via VISION grounding. Tests grounding
 *          discrimination (real CTA vs adjacent decoy blue button) + scroll.
 *
 * Run:  node spike/run-spike3.mjs
 *       SYNTH_MODEL=mlx-community/gemma-4-12B-it-qat-4bit node spike/run-spike3.mjs
 *       HEADLESS=false node spike/run-spike3.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runActualFlow } from '../engine/flow-runner.mjs';
import { renderPlan, approveOrThrow } from '../gate/render.mjs';
import { synthesize } from '../agent/synthesize.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = 4175;
const MLX = process.env.MLX_URL || 'http://127.0.0.1:8089/v1/chat/completions';
const VL = process.env.MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';
const SYNTH_MODEL = process.env.SYNTH_MODEL || 'mlx-community/gemma-4-12B-it-qat-4bit';
const headless = process.env.HEADLESS !== 'false';

// ── local dense target ────────────────────────────────────────────────────────
const html = readFileSync(join(__dir, 'target/dense.html'), 'utf8');
let postCount = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/social/post')) {
    postCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(PORT, r));
const baseUrl = `http://localhost:${PORT}`;
console.error(`[spike3] dense target up at ${baseUrl}`);

const results = {};

try {
  // ════ PART A — AUTONOMOUS SYNTHESIS ON A DENSE DOM ═══════════════════════════
  // Part A failure is NON-fatal: Part B is hand-authored and independent, so a
  // synthesis miss (the very signal we want) must not block the grounding test.
  const GOAL = process.env.GOAL
    || 'Create a campaign post — fill in the required fields and publish it, then confirm it was posted.';
  // Synthesis provider is configurable: default local MLX, or a hosted frontier
  // model (e.g. SYNTH_PROVIDER=google SYNTH_MODEL=gemini-2.5-pro) to test whether a
  // stronger reasoner fixes the dense-UI discrimination failure.
  const SYNTH_PROVIDER = process.env.SYNTH_PROVIDER || 'mlx';
  const synthCfg = SYNTH_PROVIDER === 'mlx'
    ? { provider: 'mlx', endpoint: MLX, model: SYNTH_MODEL, timeoutMs: 120000 }
    // Hosted: give the answer headroom and disable the 2.5 thinking tax (thinkingBudget 0)
    // so the structured plan is what comes back, not internal reasoning.
    : { provider: SYNTH_PROVIDER, model: process.env.SYNTH_MODEL, timeoutMs: 120000, maxTokens: 2048, thinkingBudget: 0 };
  console.error(`\n[spike3:A] synthesizing on dense DOM via ${SYNTH_PROVIDER}:${synthCfg.model || '(default)'}`);
  console.error(`           GOAL: ${GOAL}`);
  try {
    const plan = await synthesize({
      url: baseUrl, goal: GOAL, headless,
      providerCfg: synthCfg,
      retries: 2,
    });
    console.error('\n[spike3:A] SYNTHESIZED PLAN:');
    console.error(JSON.stringify({ scenario: plan.scenario, overlay: plan.overlay }, null, 2));

    // Discrimination check: did synthesis pick the REAL publish button (Post Now)
    // and not a decoy (Schedule / Save Draft / Boost Post)?
    const lastStep = plan.overlay.steps[plan.overlay.steps.length - 1] || {};
    const tappedName = (lastStep.args?.name || lastStep.args?.text || lastStep.target || '').toLowerCase();
    const pickedRealCTA = /post now/.test(tappedName);

    console.error('\n──────── APPROVAL GATE (A) ────────');
    console.error(renderPlan(plan.scenario, plan.overlay));
    approveOrThrow({ scenario: plan.scenario, overlay: plan.overlay, approved: process.env.REJECT !== '1', approver: 'spike-operator' });
    console.error('gate: APPROVED\n');

    const reportA = await runActualFlow({
      scenario: plan.scenario, overlay: plan.overlay,
      baseUrl, mlxEndpoint: MLX, mlxModel: VL,
      snapDom: false, headless, stepTimeoutMs: 90000,
    });
    results.A = { synthFailed: false, pickedRealCTA, flowPassed: reportA.flowPassed, stepsPassed: reportA.stepsPassed, posted: reportA.posted };
    console.error(`[spike3:A] VERDICT: pickedRealCTA=${pickedRealCTA} flowPassed=${reportA.flowPassed} stepsPassed=${reportA.stepsPassed} posted=${reportA.posted}`);
  } catch (eA) {
    results.A = { synthFailed: true, reason: eA.message, lastRaw: (eA.lastRaw || '').slice(0, 600) };
    console.error(`[spike3:A] SYNTH FAILED (non-fatal): ${eA.message}`);
  }

  // ════ PART B — FORCED VISION GROUNDING (decoy-blue + below-fold) ══════════════
  console.error('\n[spike3:B] forced-vision grounding: tap "Post Now" by sight, decoy "Boost Post" adjacent, below fold');
  const scenarioB = {
    url: baseUrl, id: 'dense-vision-publish',
    steps: [
      { action: 'Enter a campaign title', expected: 'title accepted' },
      { action: 'Enter a caption', expected: 'Post Now becomes enabled' },
      { action: 'Click the real Post Now button (not Boost Post)', expected: 'the post is published' },
    ],
  };
  const overlayB = {
    scenario: 'dense-vision-publish',
    steps: [
      { how: 'native', act: 'fill', args: { selector: '#title', value: 'Spring Launch' } },
      { how: 'native', act: 'fill', args: { selector: '#caption', value: 'Big news today!' }, truth: 'cta_enabled' },
      { how: 'vision', target: 'the blue "Post Now" publish button (not the "Boost Post" button)', truth: 'posted' },
    ],
  };
  console.error(renderPlan(scenarioB, overlayB));
  approveOrThrow({ scenario: scenarioB, overlay: overlayB, approved: true, approver: 'spike-operator' });

  const postsBefore = postCount;
  const reportB = await runActualFlow({
    scenario: scenarioB, overlay: overlayB,
    baseUrl, mlxEndpoint: MLX, mlxModel: VL,
    snapDom: false, headless, stepTimeoutMs: 90000,
  });
  results.B = {
    flowPassed: reportB.flowPassed, stepsPassed: reportB.stepsPassed, posted: reportB.posted,
    groundedRealCTA: postCount > postsBefore, // only the real Post Now POSTs
  };
  console.error(`[spike3:B] VERDICT: flowPassed=${reportB.flowPassed} stepsPassed=${reportB.stepsPassed} posted=${reportB.posted} groundedRealCTA=${results.B.groundedRealCTA}`);

  console.log(JSON.stringify({ results, totalPosts: postCount }, null, 2));
  server.close();
  // Part B (grounding) is the independent pass criterion; Part A (synthesis
  // discrimination) is reported separately — its failure is a finding, not a crash.
  const groundingOk = results.B.posted && results.B.groundedRealCTA;
  const synthOk = results.A.synthFailed === false && results.A.pickedRealCTA && results.A.posted;
  console.error(`\n[spike3] GROUNDING(B): ${groundingOk ? 'PASS' : 'FAIL'}  |  SYNTH(A): ${synthOk ? 'PASS' : 'FAIL — see results.A'}`);
  process.exit(groundingOk ? 0 : 1);
} catch (e) {
  server.close();
  console.error(`\n[spike3] FAILED: ${e.message}`);
  if (e.lastRaw) console.error(`[spike3] last model output:\n${e.lastRaw}`);
  process.exit(2);
}
