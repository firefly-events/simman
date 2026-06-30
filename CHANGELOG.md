# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
