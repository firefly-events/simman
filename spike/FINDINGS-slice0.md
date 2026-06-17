# Slice 0 — hosted-grounding validation

**Date:** 2026-06-16 · **Verdict: PASS — hosted grounding is a viable default** · branch `main`

## Question

v1's posture is hosted-default, but every passing grounding result used LOCAL Qwen-VL,
and grounding (exact pixel coords) is the hard job hosted frontier models are weakest
at. Can a hosted VL ground the real CTA among lookalikes, below the fold? This is the
one thing that could invalidate hosted-default.

## Method

The spike-3 Part B flow on `spike/target/dense.html`: fill title + caption natively,
then a **vision** tap on "Post Now" with a decoy blue "Boost Post" adjacent and the CTA
below the fold. Verdict uses ground truth independent of vision verify:
`posted` (network POST fired) + `groundedRealCTA` (only the real Post Now POSTs).
Baseline = local Qwen-VL (1 run); hosted = gemini-2.5-flash (3 trials).

## Result — PASS (3/3 hosted)

| provider | coords | posted | realCTA | topmost | grounding raw |
| --- | --- | --- | --- | --- | --- |
| local Qwen-VL | px | true | true | BUTTON | `{x:544,y:723}` |
| gemini-2.5-flash #1 | norm | true | true | BUTTON | `{x:449,y:890}` |
| gemini-2.5-flash #2 | norm | true | true | BUTTON | `{x:449,y:890}` |
| gemini-2.5-flash #3 | norm | true | true | BUTTON | `{x:449,y:890}` |

Hosted grounding hit the **real** Post Now (not the adjacent decoy), below the fold,
every trial — and deterministically (identical coords at temperature 0). The real
cursor landed on `topmost=BUTTON` and the network POST fired.

## Decision

**Hosted grounding is reliable enough to be the v1 default** → the hosted-default
posture stands; **R1 (the plan's HIGH risk) is downgraded to LOW.**

## Key config finding — coordinate convention is per-provider

The grounding coordinate space differs by model and MUST be configured per provider:
- **local Qwen-VL → pixel coords** (`coords: 'px'`, maps `x/W * viewport`).
- **gemini → normalized 0-1000** (`coords: 'norm'`, maps `x/1000 * viewport`).

Run with the wrong mode and the click lands in the wrong place. v1's provider config
(Slice 4) must carry a `coords` mode alongside each grounding provider, not a single
global default. The locate() prompt already adapts its hint to the mode; the engine
already supports both — this is a defaults/config requirement, not new engine work.

## Caveats (still open, per the v1 plan)

- One controlled dense target. Real-site grounding robustness (ambiguous, dynamic,
  scrolling pages) is still unproven — tracked as a v1 plan caveat, not a Slice 0 gate.
- gemini at temp 0 is deterministic, so the 3 trials confirm stability, not
  independent-sample variance. A noisier or busier page may scatter more.

## Feeds

- **Slice 4 (provider config):** hosted grounding default is viable; config must set
  `coords` per provider (px for local, norm for gemini).
- **v1 plan R1:** HIGH → LOW.
