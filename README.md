# SimMan

**Simulated Manual** — selectorless, vision-grounded, real-cursor testing for web.

Instead of CSS selectors, a local vision model (Qwen2.5-VL) is the **eyes** and a
real cursor is the **hands**: screenshot → model grounds pixel coordinates → real
click → model judges "did the expected result happen," with DOM/network
truth-signals authoritative when declared. Catches pixel/visual failures that
DOM-based tools can't see.

> Local-only, Apple Silicon, web-first. A Firefly Events product (seed stage).

## Status

Seed / spike. Extracted from the `plugin-hive` `actual-manual` tier
(`feat/actual-manual-tier`), now its own thing. Not yet packaged or published.

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

`installer/` — local setup/doctor that makes the prerequisite stack (Playwright
browsers, `mlx-lm`, Qwen2.5-VL weights, MLX sidecar) install cleanly. _(stub)_

## Prerequisites (provisioned by `installer/`, not yet automated)

- macOS on Apple Silicon
- `pip install mlx-lm`
- `playwright install chromium`
- Qwen2.5-VL-7B-4bit weights (~5GB, pulled to the HF cache on first run)

## Two faces

- **Standalone** — `@`-agent / CLI / slash-command. Bare goal + URL; the agent
  synthesizes the plan, the gate surfaces it, the engine runs it.
- **Hive** — joins a Hive test team via a specialist-trigger when UI work is
  detected; Hive keeps only a thin detect-or-fail-fast seam pointing here.

## Engine quickstart (today)

```bash
npm install
npm test            # node --test engine/__tests__/*.test.mjs
```

See `docs/scope.md` for the full product definition and open decisions, and
`docs/overlay-schema.md` for the structured overlay format the engine consumes.
