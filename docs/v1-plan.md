# SimMan v1 — plan ("local dev tool")

**Status:** PLANNED 2026-06-16 · spikes complete (1, 2, 3/3b, 4) · branch `spike/synthesis-gate-engine-loop`

## What v1 is

A developer runs SimMan locally against a dev URL and gets a deterministic
pass/fail report. Selectorless: a vision model is the eyes, a real cursor the hands;
DOM/network truth-signals are authoritative when declared, vision is the fallback.

**v1 "done":** on a clean machine, `npm i` + one API key + `simman run plans/x.yaml`
produces a correct pass/fail report. Nothing more.

## Locked decisions (this plan's spine)

| Fork | Choice | Consequence |
| --- | --- | --- |
| Provider posture | **Hosted-default, local opt-in** | Install = `npm i` + `GEMINI_API_KEY`. No mandatory 5GB weights, no required sidecar. `--local` flips to MLX. |
| Primary surface | **Scenario-file-first** | `simman run plans/x.yaml` is the spine. `simman plan "<goal>" <url>` is a scaffolding aid that emits a reviewable YAML file — synth is NOT the core loop. |
| Ceiling | **Local dev tool** | Interactive, local dev URL, human-readable report. **OUT:** CI/unattended, Hive integration, hosted-unattended gate policy. |

## What's already built (spikes — productize, don't rebuild)

- **engine/** — `runActualFlow` / `runFlow`: native primitives + two-pass vision
  grounding (scroll-to-center), hybrid V&V with `decidePass` precedence
  (truth-signal → native-act → vision-verify). Proven on simple + dense UIs. 56 tests.
- **agent/** — `synthesize`: goal+URL → validated scenario+overlay. Proven autonomous
  (gemini-2.5-flash) on a dense UI; local gemma-12B insufficient.
- **gate/** — `renderPlan` / `approveOrThrow` / `applyEdits` / `gateReview` +
  `interactiveDecider`. Edit-loop proven end-to-end (spike 4).
- **engine/providers.mjs** — pluggable vision backends (mlx/openai/anthropic/google),
  per-role config, gemini thinking-budget handling.

v1 is mostly CLI + config + installer + docs glue over proven layers, plus ONE
validation spike.

## ⚠️ Headline risk — hosted grounding is unproven

Every passing grounding result used **local Qwen-VL**. Hosted-default makes a hosted
VL the zero-config grounding model, and grounding (exact pixel coords) is the *hard*
job hosted frontier models are weakest at. This is the one thing that could undercut
the hosted-default choice. **Slice 0 de-risks it before we commit the defaults.**
Regardless of outcome, docs recommend the **hybrid** (local grounding + hosted synth)
as the "best accuracy" config; hosted-only grounding is the convenience default.

## Slices (ordered)

### Slice 0 — Hosted-grounding validation (DE-RISK FIRST)
- Spike: measure a hosted VL (gemini-2.5-flash / and/or gpt-4o) grounding accuracy on
  `spike/target/dense.html` vs local Qwen-VL — does it click the right CTA among
  lookalikes, below the fold?
- **Output = a decision:** is hosted grounding good enough to be the default, or does
  grounding default to `local-if-available, hosted-fallback`? Feeds Slice 4 defaults.
- Gate: do not finalize provider defaults until this lands.

### Slice 1 — Scenario file format + loader (the spine)
- Canonical YAML: a scenario (`id`, `baseUrl`, `steps[{action, expected}]`) + an
  overlay (`steps[StepEntry]`), one file. `loadScenario(path) → {scenario, overlay}`
  (js-yaml already a dep), validated through `validateBindings` + length-parity.
- Fixtures (`plans/*.yaml`), actionable errors on malformed input. Tests.

### Slice 2 — `simman run plans/x.yaml` + report
- `bin/simman` CLI. `run <file>`: loadScenario → `runActualFlow` → render report
  (pass/fail, per-step `passBasis`, posted). Non-zero exit on failure.
- Flags: `--headless`, `--base-url`, `--provider`/`--local`.
- This is the v1 critical-path deliverable.

### Slice 3 — `simman doctor` (installer/preflight)
- Checks: node ≥20.19; **playwright browsers installed for SimMan's PINNED version**
  (the spike-1 cross-version-cache finding); API key present; if `--local`, MLX
  reachable. `doctor --fix` runs `playwright install chromium`.
- Light because hosted-default — no mandatory weights.

### Slice 4 — Provider config + hosted default
- Config (`simman.config.{json,yaml}` + env): provider per role (synth/ground/verify),
  keys from env, `--local` flag. Defaults per Slice 0. Bake gemini `thinkingBudget:0`
  + `maxTokens` (spike-3b). `--local` flips all roles to MLX.

### Slice 5 — `simman plan` synth scaffolding + gate
- `plan "<goal>" <url>` → `synthesize` → `gateReview` (interactive approve/reject/edit)
  → write a reviewable YAML file. Authored-first: synth produces a *draft you commit*,
  not a thing that auto-runs. Reuses agent/ + gate/ as-is.

### Slice 6 — Local MLX opt-in: managed sidecar (STRETCH)
- `--local`/config spawns + health-checks a **managed single-purpose** MLX sidecar
  (kills the swap-thrash seen across spikes); `doctor` pulls weights on demand.
- Optional (hosted is default) → defer to v1.1 if the timeline tightens.

### Slice 7 — Docs + examples + README (throughout)
- Quickstart (hosted, one key), example scenario files, providers guide (drafted),
  doctor guide. State the **recommended hybrid config** vs the zero-config default.

## Sequencing

```
0 ─ validate ─┐
              ▼
1 spine → 2 run+report → 3 doctor → 4 providers → 5 plan/gate → 6 local (stretch)
              └────────────── 7 docs (continuous) ──────────────┘
```
Critical path to "clean-machine `simman run` works": **1 → 2 → 3 → 4**. Slice 0 runs
in parallel and gates only Slice 4's defaults. Slice 5 (synth/gate) layers on top.

## Risks

| | Risk | Sev | Mitigation |
| --- | --- | --- | --- |
| R1 | Hosted grounding accuracy below local | HIGH | Slice 0 spike; recommend hybrid; local-fallback default if it fails |
| R2 | Playwright browser-version drift | MED | `doctor` installs for the pinned version (spike-1 finding) |
| R3 | Hosted per-step verify cost/latency | LOW | Acceptable for local dev; truth-signals reduce reliance on vision verify |
| R4 | Gate UX in a terminal | LOW | `interactiveDecider` already spike-tested |

## Out of scope (v1)

CI/unattended runs, machine-readable report + `--no-gate` policy, Hive discovery seam /
run-as-agent, cross-browser, auth flows beyond env keys, click-recording to author
scenarios.

## First move

Land **Slice 0** (hosted-grounding validation) — it's cheap (reuse `run-spike3.mjs`
Part B with a hosted grounding provider) and it's the only thing that can invalidate
the hosted-default posture. Then build the 1→2→3→4 critical path.
