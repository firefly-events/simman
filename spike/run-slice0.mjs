/**
 * Slice 0 — hosted-grounding validation.
 *
 * v1's locked posture is hosted-default. But every passing grounding result so far
 * used LOCAL Qwen-VL, and grounding (exact pixel coords) is the hard job hosted
 * frontier models are weakest at. This measures whether a hosted VL can ground the
 * real CTA among lookalikes, below the fold, on the dense target — the one thing that
 * could invalidate hosted-default.
 *
 * Method: the spike-3 Part B flow (fill title+caption natively, then a VISION tap on
 * "Post Now" with a decoy blue "Boost Post" adjacent and below the fold). The verdict
 * uses ground truth that does NOT depend on vision verify:
 *   - posted        = the 'posted' truth-signal (network POST /api/social/post fired)
 *   - groundedRealCTA = exactly the real Post Now POSTs; the decoys never POST
 * Local Qwen-VL is the baseline (1 run); hosted gemini runs 3x for consistency.
 *
 * Run:  GEMINI_API_KEY=... node spike/run-slice0.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runActualFlow } from '../engine/flow-runner.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = 4177;
const MLX = process.env.MLX_URL || 'http://127.0.0.1:8089/v1/chat/completions';
const VL = process.env.MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';
const HOSTED_MODEL = process.env.HOSTED_VL || 'gemini-2.5-flash';
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
console.error(`[slice0] dense target up at ${baseUrl}`);

function flow() {
  return {
    scenario: {
      url: baseUrl, id: 'ground-publish',
      steps: [
        { action: 'Enter a campaign title', expected: 'title accepted' },
        { action: 'Enter a caption', expected: 'Post Now becomes enabled' },
        { action: 'Click the real Post Now button (not Boost Post)', expected: 'the post is published' },
      ],
    },
    overlay: {
      scenario: 'ground-publish',
      steps: [
        { how: 'native', act: 'fill', args: { selector: '#title', value: 'Spring Launch' } },
        { how: 'native', act: 'fill', args: { selector: '#caption', value: 'Big news today!' }, truth: 'cta_enabled' },
        { how: 'vision', target: 'the blue "Post Now" publish button (not the "Boost Post" button)', truth: 'posted' },
      ],
    },
  };
}

async function runOnce({ label, grounding, verify, coords }) {
  const before = postCount;
  const { scenario, overlay } = flow();
  let visionRec = null;
  const report = await runActualFlow({
    scenario, overlay, baseUrl,
    // local defaults still apply to any role not overridden
    mlxEndpoint: MLX, mlxModel: VL,
    grounding, verify, coords,
    snapDom: false, headless, stepTimeoutMs: 90000,
    onStep: (rec) => { if (rec.how === 'vision') visionRec = rec; },
  });
  const groundedRealCTA = postCount > before;
  const vstep = (report.steps || []).find((s) => s.how === 'vision') || {};
  return {
    label,
    posted: report.posted,
    groundedRealCTA,
    visionFound: vstep.visionFound,
    clicked: vstep.clicked,
    topmost: vstep.topmost, // which element the real cursor actually landed on
    rawCoords: visionRec?.vision?.raw,
  };
}

const results = [];
try {
  // ── Baseline: local Qwen-VL grounding ────────────────────────────────────────
  console.error('\n[slice0] BASELINE — local Qwen-VL grounding');
  results.push({ provider: 'local-qwen-vl', ...(await runOnce({
    label: 'local', coords: undefined, // local pixel convention
    grounding: { provider: 'mlx', endpoint: MLX, model: VL },
    verify: { provider: 'mlx', endpoint: MLX, model: VL },
  })) });

  // ── Hosted: gemini grounding (normalized 0-1000 coords) ───────────────────────
  const hostedGrounding = { provider: 'google', model: HOSTED_MODEL };
  const hostedVerify = { provider: 'google', model: HOSTED_MODEL };
  for (let t = 1; t <= 3; t++) {
    console.error(`\n[slice0] HOSTED trial ${t}/3 — ${HOSTED_MODEL} grounding (coords=norm)`);
    results.push({ provider: `hosted-${HOSTED_MODEL}#${t}`, ...(await runOnce({
      label: `hosted#${t}`, coords: 'norm',
      grounding: hostedGrounding, verify: hostedVerify,
    })) });
  }

  console.log(JSON.stringify({ results }, null, 2));
  const hosted = results.filter((r) => r.provider.startsWith('hosted'));
  const hostedHits = hosted.filter((r) => r.groundedRealCTA).length;
  console.error(`\n[slice0] SUMMARY`);
  for (const r of results) {
    console.error(`  ${r.provider.padEnd(26)} posted=${r.posted} realCTA=${r.groundedRealCTA} topmost=${r.topmost || '?'} coords=${(r.rawCoords || '').slice(0, 40)}`);
  }
  console.error(`\n[slice0] hosted grounding hit the real CTA ${hostedHits}/3 trials`);
  console.error(`[slice0] DECISION INPUT: ${hostedHits === 3 ? 'hosted grounding RELIABLE → viable default'
    : hostedHits === 0 ? 'hosted grounding FAILED → default grounding must be local'
    : 'hosted grounding FLAKY → local-if-available default, hosted fallback only'}`);
  server.close();
  process.exit(0);
} catch (e) {
  server.close();
  console.error(`\n[slice0] ERROR: ${e.message}`);
  process.exit(2);
}
