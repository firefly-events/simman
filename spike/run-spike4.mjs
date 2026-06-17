/**
 * Spike 4 — GATE EDIT LOOP end-to-end.
 *
 * Premise: synthesis got it wrong (the spike-3 gemma miss — a single run-on step
 * that taps the "Schedule" decoy). Instead of a hard reject, a human edits the plan
 * in the gate, then approves, and the SAME engine runs the corrected plan against a
 * real browser. Hybrid autonomy: a synthesis miss becomes a passing run, not a dead end.
 *
 * Part A — REJECT path: operator rejects → GATE_REJECTED, zero browser actions, zero POSTs.
 * Part B — EDIT path:   operator rebuilds the bad plan correctly → approve → engine
 *                       runs → posted=true.
 *
 * Run:  node spike/run-spike4.mjs   (needs MLX Qwen-VL on :8089 for verify steps)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runActualFlow } from '../engine/flow-runner.mjs';
import { gateReview } from '../gate/edit.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = 4176;
const MLX = process.env.MLX_URL || 'http://127.0.0.1:8089/v1/chat/completions';
const VL = process.env.MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';
const headless = process.env.HEADLESS !== 'false';

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
console.error(`[spike4] dense target up at ${baseUrl}`);

// The synthesis miss we're correcting: one run-on step that taps the decoy "Schedule".
function badPlan() {
  return {
    scenario: { id: 'publish-campaign', baseUrl, steps: [{ action: 'Fill the fields and click Schedule to publish', expected: 'the post is published' }] },
    overlay: { scenario: 'publish-campaign', steps: [{ how: 'native', act: 'tapRole', args: { role: 'button', name: 'Schedule' }, truth: 'posted' }] },
  };
}

// What a human does in the gate: throw out the decoy step, build the real 3-step plan.
const CORRECTION = [
  {
    op: 'replace', i: 0,
    scenario: { action: 'Enter a campaign title', expected: 'title accepted' },
    overlay: { how: 'native', act: 'fill', args: { selector: '#title', value: 'Spring Launch' } },
  },
  {
    op: 'insert', i: 1,
    scenario: { action: 'Enter a caption', expected: 'Post Now becomes enabled' },
    overlay: { how: 'native', act: 'fill', args: { selector: '#caption', value: 'Big news today!' }, truth: 'cta_enabled' },
  },
  {
    op: 'insert', i: 2,
    scenario: { action: 'Click the real Post Now button', expected: 'the post is published' },
    overlay: { how: 'native', act: 'tapRole', args: { role: 'button', name: 'Post Now' }, truth: 'posted' },
  },
];

const results = {};
try {
  // ── Part A — REJECT blocks execution ─────────────────────────────────────────
  console.error('\n[spike4:A] operator REJECTS the bad plan');
  const postsBeforeA = postCount;
  let rejected = false;
  try {
    await gateReview({ ...badPlan(), approver: 'spike-operator', decide: () => ({ action: 'reject' }) });
  } catch (e) {
    rejected = e.code === 'GATE_REJECTED';
  }
  results.A = { rejected, postsDuring: postCount - postsBeforeA };
  console.error(`[spike4:A] rejected=${rejected} posts=${results.A.postsDuring} (expect 0)`);

  // ── Part B — EDIT a bad plan into a good one, approve, run for real ───────────
  console.error('\n[spike4:B] operator EDITS the bad plan, then approves');
  let editApplied = false;
  const decide = ({ round }) => (round === 1 ? { action: 'edit', edits: CORRECTION } : (editApplied = true, { action: 'approve' }));
  const approved = await gateReview({ ...badPlan(), approver: 'spike-operator', onRender: (t) => console.error(t), decide });
  console.error(`\n[spike4:B] gate: APPROVED after edit (rounds=${approved.rounds}, edited=${approved.edited})`);

  const postsBeforeB = postCount;
  const report = await runActualFlow({
    scenario: approved.scenario, overlay: approved.overlay,
    baseUrl, mlxEndpoint: MLX, mlxModel: VL,
    snapDom: false, headless, stepTimeoutMs: 90000,
  });
  results.B = {
    rounds: approved.rounds, edited: approved.edited,
    flowPassed: report.flowPassed, stepsPassed: report.stepsPassed, posted: report.posted,
    postedViaRealCTA: postCount > postsBeforeB,
  };
  console.error(`[spike4:B] VERDICT: flowPassed=${report.flowPassed} stepsPassed=${report.stepsPassed} posted=${report.posted}`);

  console.log(JSON.stringify({ results, totalPosts: postCount }, null, 2));
  server.close();
  const ok = results.A.rejected && results.A.postsDuring === 0
    && results.B.posted && results.B.edited && results.B.postedViaRealCTA;
  console.error(`\n[spike4] OVERALL: ${ok ? 'PASS' : 'FAIL'}  (reject blocks + edit-then-run posts)`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  server.close();
  console.error(`\n[spike4] FAILED: ${e.message}`);
  process.exit(2);
}
