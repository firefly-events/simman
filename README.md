# SimMan

**Simulated Manual** — selectorless, vision-grounded, real-cursor testing for web.

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

## Status

Early. Extracted from the `plugin-hive` `actual-manual` tier into its own product.
Engine hardened (tests green); `agent/` (plan synthesis) and `gate/` (approval) are
scaffolded next. Hive consumes SimMan as an optional external dependency via the CLI.

## Architecture — three layers

1. **`engine/`** — deterministic runner. Takes a **structured** scenario + overlay,
   drives the browser, vision-grounds, verifies, returns a hybrid pass/fail report.
   No LLM in the core; testable headless. _(seeded — hardened, tests green)_
2. **`agent/`** — synthesis layer (LLM). Compiles intent into the engine's
   structured input: given a URL + a natural-language goal, explores the page,
   decomposes into steps, decides native-vs-vision, declares truth-signals. _(stub)_
3. **`gate/`** — approval gate. The synthesized test plan is rendered
   human-readable and **must be approved before any browser action runs**. Makes
   autonomous synthesis safe: agent proposes, human disposes. _(stub)_

Flow: `bare goal + URL → agent explores → synthesized plan → APPROVAL GATE →
engine executes → hybrid report`.

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

## Two faces

- **Standalone** — `@`-agent / CLI / slash-command. Bare goal + URL; the agent
  synthesizes the plan, the gate surfaces it, the engine runs it.
- **Hive** — joins a Hive test team via a specialist-trigger when UI work is
  detected; Hive keeps only a thin detect-or-fail-fast seam pointing here.

## Quickstart

```bash
# 1. Get the code (not on npm — clone or download the repo)
git clone https://github.com/firefly-events/simman.git
cd simman

# 2. Install
npm install
npx playwright install chromium
export GEMINI_API_KEY=...          # or run --local with an MLX sidecar

# Run a scenario (hosted Gemini by default):
simman run scenarios/example.yaml --base-url http://localhost:3100
simman run scenarios/example.yaml --json     # machine-readable RunReport
simman doctor                                 # preflight providers + browser

# Exit codes: 0 pass · 1 fail · 2 error
```

A scenario is one authored YAML — `id`, optional `baseUrl`, and `steps` of
`{ action, expected, do, truth? }`. See `scenarios/example.yaml` and
`docs/overlay-schema.md` for the compiled engine format.

```bash
npm test            # 99 tests — engine + cli + gate, headless, no API key needed
```

See `docs/scope.md` for the full product definition and open decisions.
