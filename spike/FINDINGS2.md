# Spike 2 — autonomous synthesis → gate → engine

**Date:** 2026-06-16 · **Verdict: PASS (with a strong synthesis model)** · branch `spike/synthesis-gate-engine-loop`

## Question

Can the `agent/` layer turn a **bare natural-language goal + URL** into a runnable
scenario+overlay autonomously — no hand-authoring — and have the same gate + engine
execute it to a sound verdict?

## Setup

- Same controlled local target as spike 1 (compose box + "Post Now").
- `agent/synthesize.mjs`: launches a browser, captures interactable elements
  (DOM + suggested selectors) + a screenshot, asks a model for a structured plan,
  normalizes + validates it against the engine's `bindings` validator (retry-on-invalid).
- Goal (verbatim): *"Write a caption in the compose box, publish the post, and
  confirm it was posted."*
- Compared two local synthesis models on MLX :8089.

## Result — PASS

**gemma-4-12B (synthesis):** clean, correct 2-step plan, fully autonomous:
```
fill #caption (truth cta_enabled) → tapRole "Post Now" (truth posted)
```
→ `flowPassed=true`, `stepsPassed=2/2`, `posted=true`. **Bare goal → working test,
no human authoring.** Grounding/verify ran on Qwen2.5-VL (the engine's vision model).

## Key learnings (spike payload)

1. **Per-role model strategy confirmed.** Grounding tolerates a small VL model
   (spike 1); **synthesis needs a stronger reasoner.** gemma-12B produced a clean
   plan; **Qwen2.5-VL-7B drifted** — first wrong schema (`action` key, invented
   `type`/`click` acts, over-decomposed into 5 micro-steps), then a structurally
   inconsistent plan (overlay 2 steps, scenario 1 step). → default: small-VL for
   grounding/verify, a stronger model (larger local or hosted frontier) for synthesis.

2. **Agent hardening shipped (made weak output survivable):**
   - Prompt now carries a worked example + a hard allowed-act list (goto/fill/
     tapRole/tapText/wait) + "fewest meaningful steps."
   - `normalizeOverlay`: infer missing `how` (act⇒native, target⇒vision), recover
     act from the `action` key, map synonyms (type/input⇒fill, click/tap⇒tapText).
   - **Length-parity guard:** reject when `scenario.steps.length !==
     overlay.steps.length`. The engine pairs by index and drives by scenario
     length, so a mismatch silently drops the tail (Qwen's plan filled but never
     clicked → `posted=false`). The validator checked the overlay alone and missed it.

3. **Infra finding — manual multi-model MLX is fragile.** The local MLX server was
   hand-serving BOTH Qwen-VL and gemma-12B; back-to-back model-swap load crashed it
   (connection refused) mid-spike. Reinforces: the `installer/` must own a managed,
   single-purpose sidecar lifecycle; SimMan should not depend on a hand-run
   multi-model server. (The captured gemma PASS predates the crash.)

## Not yet proven (next)

- **Stronger-synthesis on a dense/real UI** (this target is trivial — one form).
- **Hosted synthesis** (anthropic/openai/google) live — no keys at build time.
- **Grounding robustness** on ambiguous/scrolling pages.
- **Installer** clean-machine + managed sidecar.

## Reproduce

```bash
cd simman
# MLX must be serving a synthesis model + a vision model (or use one capable VL model)
SYNTH_MODEL=mlx-community/gemma-4-12B-it-qat-4bit node spike/run-spike2.mjs   # PASS
node spike/run-spike2.mjs                                                      # default Qwen-VL synth (drifts)
```
