# Spike 4 — gate edit loop (hybrid autonomy)

**Date:** 2026-06-16 · **Verdict: PASS** · branch `spike/synthesis-gate-engine-loop`

## Question

When synthesis gets a plan wrong (spike 3: gemma tapped the "Schedule" decoy), the
gate's only move was approve/reject. Can a human instead **edit** the plan in the gate
and then approve, turning a synthesis miss into a passing run — without touching the
engine?

## What was built

`gate/edit.mjs`:
- **`applyEdits(plan, edits)`** — pure. Paired edit ops on the (scenario, overlay)
  step arrays so they can never drift out of length/order: `replace`, `insert`,
  `remove`, `reorder`. Re-validates the result through the engine's own
  `validateBindings` + the length-parity rule; throws `GATE_EDIT_INVALID` on a bad edit.
- **`gateReview({scenario, overlay, decide})`** — render → `decide` (approve | reject |
  edit) → apply → re-render, looping until approve/reject. `decide` is injectable: a
  scripted operator in tests/spikes, a readline prompt for humans.
- **`interactiveDecider()`** — readline `a` / `r` / `e <json-edits>` for real CLI use.

14 unit tests (`gate/__tests__/edit.test.mjs`): every op, immutability, invalid-edit
rejection, non-permutation guard, approve/reject/edit-then-approve, and a maxRounds
loop guard.

## End-to-end result (real engine + dense target)

`spike/run-spike4.mjs` injects the spike-3 miss (one run-on step that taps the
"Schedule" decoy) and drives it through the gate, twice:

- **Part A — REJECT:** operator rejects → `GATE_REJECTED`, **0 browser actions, 0 POSTs.**
  The gate is a real hard stop.
- **Part B — EDIT:** operator rebuilds the plan in-gate (replace the decoy step with a
  title fill, insert the caption fill + the real Post Now tap), approves at round 2 →
  engine runs → **`posted=true`, `postedViaRealCTA=true`.** A synthesis miss became a
  passing live run, no engine change.

```
A: { rejected: true,  postsDuring: 0 }
B: { rounds: 2, edited: true, posted: true, postedViaRealCTA: true, stepsPassed: "2/3" }
totalPosts: 1
```

## Learnings

1. **Hybrid autonomy works.** The gate-edit loop is the bridge between "fully
   autonomous" (fails on dense UIs, spike 3) and "fully manual." Synthesis proposes; a
   human corrects cheaply in the gate; the deterministic engine executes. This is the
   right default posture for anything high-stakes.
2. **Edits stay paired + re-validated.** Because every op touches both step arrays and
   the result re-runs the engine validator, an operator cannot approve a structurally
   broken plan (the silent length-drop bug from spike 2 cannot be reintroduced by hand).
3. **Engine-quality follow-up (out of scope here): native acts shouldn't depend on
   vision verify.** Part B reported `flowPassed=false 2/3` even though `posted=true`:
   the title-fill step declared no truth-signal, so it fell back to the (noisy) vision
   verify and false-failed — the same vision-verify unreliability seen in spike 1.
   Steps with truth-signals passed; the real publish fired. A successful **native**
   Playwright act is itself the signal; vision verify should be advisory for native
   steps, authoritative only for vision steps. File as an engine fix.

## Next

- Engine: native-act steps pass on act success; vision verify advisory (would make
  this flow `3/3`).
- Wire the gate-edit loop into the autonomous spike (3b) so a frontier-synth plan that
  still misses can be hand-corrected before running.
- `interactiveDecider` UX polish for the standalone CLI face.
