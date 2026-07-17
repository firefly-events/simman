# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-16

### Added

- **`simman synthesize <url> "<goal>"`** — the autonomous loop, human-gated: the
  agent explores the page and compiles the goal into a test plan; an interactive
  approval gate (approve / edit in `$EDITOR` / reject) blocks execution until a
  human signs off; the approved plan is saved as plain scenario YAML and run.
  `--no-run` saves without executing; exit code 3 = rejected at gate.
- **User-defined truth signals** (object form): `{ kind: network, match, method? }`
  observes the app's own API calls; `{ kind: element_enabled, selector? | role?/name? }`
  checks real DOM enabled-state. Authoritative over the vision judge when declared.
  Legacy `posted` / `cta_enabled` string aliases still parse (deprecated).
- `--out <dir>` flag for where synthesized scenarios are saved.
- CLI validates `--coords` and `--provider` values at parse time.

### Changed

- Report footer now summarizes declared truth-signal outcomes (`truth n/m`)
  instead of the app-specific `posted=` field.
- 116 tests (from 99): truth-signal validation, network matcher, synthesized-plan
  YAML round-trip.

### Removed

- Legacy standalone CLI (`main()`) inside `engine/flow-runner.mjs` — superseded by
  `simman run` since 0.1.0.

## [0.1.1] - 2026-07-16

### Security

- Bumped Playwright to ^1.61.1 (past GHSA-7mvr-c777-76hp — browser binaries
  previously downloaded without SSL certificate verification).
- Gemini API key is now sent via the `x-goog-api-key` header instead of the URL
  query string, keeping it out of proxy and TLS-inspection logs.

### Changed

- `.env` / `.env.*` files are now gitignored.
- README documents the truth-signal alpha limitation (built-in `posted` /
  `cta_enabled` signals match the origin app's patterns; user-configurable
  signals are the top roadmap item).

## [0.1.0] - 2025-06-29

### Added

- **`simman run <scenario.yaml>`** — run an authored YAML scenario through a real
  Playwright browser with vision grounding (Gemini hosted or local MLX/Qwen).
- **`simman doctor`** — preflight check for providers, API keys, and Playwright browser
  installation; `--fix` flag auto-installs missing Chromium.
- Pluggable vision provider layer (`engine/providers.mjs`): `google` (Gemini),
  `openai`, `anthropic`, and `mlx` (local OpenAI-compatible server). Per-role
  overrides for grounding vs. verify.
- Flow-bindings overlay schema and validator (`engine/bindings.mjs`) with fail-fast
  error codes for mismatched or malformed overlays.
- Hybrid pass/fail report: DOM/network truth-signals are authoritative when declared;
  vision judge for steps without explicit truth signals.
- 99 unit tests covering engine, CLI, and gate modules — headless, no API key needed.
- `docs/overlay-schema.md` — canonical reference for the flow-bindings overlay format.
- `docs/providers.md` — provider configuration guide.
- `scenarios/example.yaml` — annotated example scenario.
- `simman.config.example.yaml` — reference configuration file.
