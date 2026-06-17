# Spike 3 — dense UI: synthesis discrimination + grounding among lookalikes

**Date:** 2026-06-16 · **Verdict: SPLIT — grounding PASS, autonomous synthesis FAIL** · branch `spike/synthesis-gate-engine-loop`

## Question

Spikes 1–2 used a single-form target. Do the two layers hold up on a **dense** UI?
- **Engine/grounding:** can vision click the *real* CTA among lookalike buttons,
  below the fold (scroll)?
- **Agent/synthesis:** can a bare goal be synthesized into a correct plan when the
  DOM has distractors (nav buttons, decoy "Save Draft"/"Schedule"/"Boost Post") and
  a multi-field gate (title AND caption required)?

## Target

`spike/target/dense.html` — Campaign Studio: sticky nav (4 decoy buttons), form
(`#title`, `#caption`, `#tags`, `#audience` select), secondary "Save Draft"/"Schedule",
a tall preview panel that pushes the CTA **below the fold**, and **two blue
primary-looking buttons side by side**: a decoy "Boost Post" and the real "Post Now"
(`#post`). The CTA enables only when *both* title and caption are non-empty. Only the
real "Post Now" fires `POST /api/social/post`.

## Result — SPLIT

### Part B — grounding (engine): **PASS**
Hand-authored overlay: native-fill title+caption, then a **vision** tap on "the blue
Post Now button (not Boost Post)".
```
flowPassed=true  stepsPassed=3/3  posted=true  groundedRealCTA=true  totalPosts=1
```
Vision grounding hit the **correct** CTA — not the adjacent decoy blue button — and
the two-pass scroll-to-center reached it below the fold. Exactly one POST fired (the
real publish). **Engine grounding generalizes to a dense UI.**

### Part A — autonomous synthesis (agent): **FAIL (reproducible)**
gemma-4-12B, bare goal, twice:
- **Structural collapse** — scenario compressed to a single run-on step ("Fill in the
  title, caption, and tags, then click Schedule to publish") while the overlay had 4
  steps → **length-parity guard rejected all 3 attempts** (no bad plan executed).
- **Wrong target** — it chose the **"Schedule" decoy** as the publish action and
  declared `truth: posted` on it, never selecting "Post Now".
- Filled `#tags` (not required).

The simple-form PASS from spike 2 does **not** generalize: synthesis discrimination
degrades on a dense DOM with decoys + a multi-field gate.

## Key learnings (spike payload)

1. **Clean engine/agent split, empirically.** The deterministic engine (grounding +
   truth-signals) is the robust layer; the LLM synthesis layer is the weak link. This
   is the whole reason they're separate — and the reason the **gate** exists.
2. **The gate's value is now concrete.** On this exact failure, a human reviewing the
   rendered plan ("click Schedule … truth: posted") catches the wrong button and
   rejects before any browser action. Human-in-loop gate turns a synthesis miss into a
   caught error, not a bad test run. → Hybrid autonomy is the right default for dense UIs.
3. **The length-parity guard earned its place.** It blocked a structurally-inconsistent
   plan (overlay would have filled fields but the engine pairs by scenario length and
   drops the tail). Defensive, not cosmetic.
4. **gemma-12B is below the bar for dense-UI synthesis.** Next: a stronger synthesis
   model (larger local or a hosted frontier model via the provider layer), and/or
   prompt scaffolding (decompose-then-bind, one-overlay-step-per-scenario-step,
   explicit anti-decoy / "which control submits?" reasoning).
5. **MLX single-model swap thrash confirms the spike-2 infra finding.** The :8089
   server serves one model at a time; each gemma↔Qwen-VL swap reloads ~5–10GB and
   dominates wall-clock (synth on gemma, then a full reload to Qwen-VL for grounding).
   The installer must own a managed sidecar — ideally co-resident grounding + synth
   models or separate ports — not a hand-run swap-on-demand server.

## Follow-up — hosted synthesis (gemini-2.5-flash): dense-UI synthesis now PASSES

Re-ran Part A through the provider layer with a hosted frontier model
(`SYNTH_PROVIDER=google SYNTH_MODEL=gemini-2.5-flash`). Engine grounding/verify
stayed on local Qwen-VL; only synthesis changed.

**Result: `pickedRealCTA=true flowPassed=true 3/3 posted=true`** — full autonomous
PASS on the same dense target that local gemma-12B failed. The button-discrimination
failure (gemma chose the "Schedule" decoy) is **gone**: gemini picked "Post Now".

Two fixes were required to get there:

1. **Provider integration — Gemini 2.5 thinking tax.** First attempt (gemini-2.5-pro)
   returned an *empty* string: 2.5 thinking models spend `maxOutputTokens` on internal
   reasoning, starving the visible answer. Fix (`engine/providers.mjs`): raise the
   output cap and thread a `thinkingBudget` through `askGoogle` → `generationConfig.
   thinkingConfig`. Running gemini-2.5-flash with `thinkingBudget: 0`, `maxTokens: 2048`
   returns the structured plan. (2.5-pro rejects budget 0 — it requires thinking; flash
   allows 0.)
2. **Prompt — compound-action under-decomposition.** gemini's first valid plan picked
   the right button but bundled "fill title *and* caption" into a single fill step
   (`#title` only) → the multi-field gate stayed unsatisfied → `0/2`. Fix
   (`agent/synthesize.mjs` SCHEMA_HINT): **one form field per step**; fill every field a
   disabled CTA depends on before the click. Re-run → clean 3-step plan, full PASS.

**Takeaway:** the dense-UI synthesis ceiling is a **model + prompt** problem, not an
architectural one. The provider abstraction paid off — swapping local→hosted fixed the
weak link with no engine change. Recommended default for dense UIs: a frontier
synthesis model (or a larger local one) behind the same gate; local small-VL stays the
grounding/verify default.

## Not yet proven (next)

- **Stronger synthesis** (larger local model or hosted frontier) on this same dense
  target — does the discrimination failure go away with a better reasoner?
- **Hosted grounding** live (provider layer, needs a key).
- **Gate-edit loop:** operator corrects a wrong-button plan in the gate, re-approves.
- **Installer** clean-machine + managed/co-resident sidecar (kills the swap thrash).

## Reproduce

```bash
cd simman
# MLX serving a synth model + a vision model on :8089
node spike/run-spike3.mjs          # Part A synth (fails), Part B grounding (passes)
# Part B is the independent PASS criterion; Part A failure is reported, non-fatal.
```
