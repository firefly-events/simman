# SimMan

![CI](https://github.com/firefly-events/simman/actions/workflows/ci.yml/badge.svg)

**Simulated Manual** — selectorless, vision-grounded, real-cursor testing for web.

> **Status: alpha (0.x)** — APIs and scenario schema may change between minor releases.

Instead of CSS selectors, a multimodal model is the **eyes** and a real cursor is the
**hands**: screenshot → model grounds pixel coordinates → real click → model judges
"did the expected result happen," with DOM/network truth-signals authoritative when
declared. Catches pixel/visual failures that DOM-based tools can't see.

**Model-agnostic.** SimMan is not tied to one model. We've tested primarily with
**Google Gemini** (hosted) and **Qwen2.5-VL** (local via MLX), but any capable
multimodal model that can ground coordinates from an image should work — providers are
pluggable per role (grounding / verify / synth). Grounding is the demanding job; pick a
model strong at precise spatial localization.

> Web-first. Hosted **Google Gemini** by default (zero local setup) — or run fully
> local on Apple Silicon with MLX Qwen. A Firefly Events product.

SimMan applies the same Gemini visual-grounding that powers Google's own AI pointer —
to autonomous UI testing. (We use the Gemini API directly; not affiliated with Google.)

## What works today

- **`simman run <scenario.yaml>`** — authored YAML → real browser (Playwright) →
  vision grounding → hybrid pass/fail report
- **`simman doctor`** — preflight providers and browser
- Pluggable vision providers: hosted Gemini (zero-config default) or local MLX/Qwen
  (offline, Apple Silicon)

## Architecture — three layers

1. **`engine/`** — deterministic runner. Takes a **structured** scenario + overlay,
   drives the browser, vision-grounds, verifies, returns a hybrid pass/fail report.
   No LLM in the core; testable headless. _(hardened — 99 tests green)_
2. **`agent/`** — synthesis layer (LLM). Compiles intent into the engine's
   structured input: given a URL + a natural-language goal, explores the page,
   decomposes into steps, decides native-vs-vision, declares truth-signals.
   _(roadmap — not yet wired to the CLI; see [Roadmap](#roadmap--experimental))_
3. **`gate/`** — approval gate. The synthesized test plan is rendered
   human-readable and **must be approved before any browser action runs**. Makes
   autonomous synthesis safe: agent proposes, human disposes.
   _(roadmap — not yet wired to the CLI; see [Roadmap](#roadmap--experimental))_

`installer/` — local setup/doctor that makes the optional local stack (Playwright
browsers, `mlx-vlm`, Qwen2.5-VL weights, MLX sidecar) install cleanly. _(stub)_

## Prerequisites

Always:
- Node ≥ 20.19
- `npx playwright install chromium` (the browser SimMan drives)

Hosted (default — recommended for zero setup):
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)

Local (optional — private/offline, Apple Silicon only):
- `pip install mlx-vlm` &nbsp;# vision-capable server — NOT `mlx-lm` (text-only)
- Qwen2.5-VL-7B-4bit weights (~5GB, pulled to the HF cache on first run)
- start the sidecar: `python -m engine.mlx_sidecar start` (serves on :8089)

## Quickstart

### Zero-install (npx)

```bash
export GEMINI_API_KEY=...
npx simman run scenario.yaml --base-url http://localhost:3100
npx simman doctor
```

### Global install

```bash
npm install -g simman

export GEMINI_API_KEY=...
simman run scenarios/example.yaml --base-url http://localhost:3100
simman run scenarios/example.yaml --json     # machine-readable RunReport
simman doctor                                 # preflight providers + browser

# Exit codes: 0 pass · 1 fail · 2 error
```

### From source / development

```bash
git clone https://github.com/firefly-events/simman.git
cd simman
npm install
npm link                                      # puts `simman` on PATH
npx playwright install chromium
export GEMINI_API_KEY=...
simman run scenarios/example.yaml --base-url http://localhost:3100
```

A scenario is one authored YAML — `id`, optional `baseUrl`, and `steps` of
`{ action, expected, do, truth? }`. See `scenarios/example.yaml` and
`docs/overlay-schema.md` for the compiled engine format.

> **Known alpha limitation — truth signals.** The two built-in truth signals
> (`posted`, `cta_enabled`) currently match patterns from the app SimMan was
> extracted from (a specific API route and button label), so they will not fire
> against arbitrary apps yet. User-configurable truth signals (declare your own
> URL pattern / element matcher in the scenario) are the top roadmap item.
> Vision-based verification works everywhere today.

```bash
npm test            # 99 tests — engine + cli + gate, headless, no API key needed
```

## Roadmap / experimental

The following modules are scaffolded but **not yet wired to the CLI**:

- **`agent/`** — goal → plan synthesis: given a URL + natural-language goal, an LLM
  explores the page, decomposes into steps, decides native-vs-vision, declares
  truth-signals. See `agent/README.md`.
- **`gate/`** — approval gate: synthesized test plan is rendered human-readable and
  requires explicit approve / edit / reject before any browser action runs.
  See `gate/README.md`.

Future flow: `bare goal + URL → agent explores → synthesized plan → APPROVAL GATE →
engine executes → hybrid report`.
