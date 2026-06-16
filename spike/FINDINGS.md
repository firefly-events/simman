# Spike 1 — synthesis → gate → engine loop

**Date:** 2026-06-16 · **Verdict: PASS** · branch `spike/synthesis-gate-engine-loop`

## Question

Does the core SimMan thesis hold end-to-end on a real browser with live MLX
vision — agent synthesizes a plan, the gate approves it, the engine drives a real
cursor by vision and returns a sound verdict?

## Setup

- Controlled local target (`spike/target/index.html`): caption box + "Post Now"
  button (disabled until caption non-empty), click fires `POST /api/social/post`
  and shows a "Posted!" confirmation. Deterministic, no auth.
- Synthesis hand-authored (the `agent/` layer is not built — **I was the agent**).
- Gate: `gate/render.mjs` renders the plan + hard-stops unless approved.
- Engine: the seeded `engine/` (`runActualFlow`) — real headless Chromium +
  Qwen2.5-VL-7B on MLX `:8089`.

## Result — PASS

`flowPassed=true`, `stepsPassed=2/2`, `posted=true`, ~34s wall.

- **Step 1 (vision):** `visionFound=true`, clicked `[404,338]`, `topmost="BUTTON"`
  — Qwen2.5-VL grounded the Post Now button correctly, real cursor hit the right
  element, network post fired, confirmation verified. **Core thesis validated:
  vision → real click → correct element, on a real browser.**
- **Gate:** `REJECT=1` hard-stops before any browser launch.

## Key learnings (spike payload)

1. **Hybrid V&V is load-bearing, validated by a real divergence.** Step 0's
   *vision* verify was WRONG ("button is not enabled, input empty") while the
   *truth-signal* (`cta_enabled`, DOM) was right → step passed on the truth-signal.
   Vision alone would have false-failed. Confirms the locked design: vision is
   unreliable for enabled-state/ephemeral UI; declared truth-signals must be
   authoritative. → the synthesis agent should declare truth-signals wherever a
   DOM/network ground-truth exists.

2. **Installer finding — per-Playwright-version browser binaries.** SimMan's
   pinned `playwright@1.52.0` needs Chromium build **1169**; the globally cached
   builds (1217/1223, from plugin-hive's newer Playwright) do NOT satisfy it. The
   `installer/` MUST run `playwright install chromium` against SimMan's own
   Playwright version — cannot assume a shared/global browser cache.

3. **Latency:** ~34s for a 2-step flow with ~3-4 Qwen-VL calls. Tolerable for a
   targeted test tier; not a fast unit-test substitute. Per-step MLX timeout
   (added in review remediation) matters at scale.

## Not yet proven (next spikes)

- **Automated synthesis** — here a human authored the scenario+overlay. The
  `agent/` layer turning a bare goal + URL into this plan autonomously is unproven.
- **Grounding robustness** — one clean, high-contrast button on a simple page.
  Real apps: dense UIs, ambiguous targets, scrolling, normalized-coord mode.
- **Installer end-to-end** — clean-machine provisioning (mlx-lm, weights, browser)
  as one `setup`/`doctor` run.

## How to reproduce

```bash
cd simman && npm install && npx playwright install chromium
# MLX Qwen2.5-VL must be serving on :8089
node spike/run-spike.mjs                 # PASS (exit 0)
REJECT=1 node spike/run-spike.mjs        # gate blocks
HEADLESS=false node spike/run-spike.mjs  # watch the cursor
```
