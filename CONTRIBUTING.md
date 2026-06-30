# Contributing to SimMan

Thank you for your interest in contributing! This guide covers how to set up the project
locally, run tests, and submit changes.

## Development setup

```bash
git clone https://github.com/firefly-events/simman.git
cd simman
npm install
npm link                      # puts `simman` on your PATH for local testing
npx playwright install chromium
```

Set a provider key for manual testing:

```bash
export GEMINI_API_KEY=...     # hosted Gemini (recommended for zero setup)
# or use --local with a running MLX sidecar (see docs/providers.md)
```

## Running tests

```bash
npm test                      # all 99 tests — engine + cli + gate, headless
```

Tests are headless and require no API key. Keep all tests green before opening a PR.

## Project layout

| Directory | Purpose |
|-----------|---------|
| `engine/` | Deterministic runner — no LLM in the core; fully testable |
| `cli/` | CLI entry point (`run`, `doctor`) |
| `agent/` | Synthesis layer — roadmap, not yet wired to CLI |
| `gate/` | Approval gate — roadmap, not yet wired to CLI |
| `docs/` | User-facing documentation |
| `scenarios/` | Example scenarios and flow-binding overlays |

## Branch and PR conventions

- Branch names: `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`.
- Open PRs against `main`. Keep commits focused; squash before merge if needed.
- New behaviour must include tests. Bug fixes should include a regression test.
- Update `CHANGELOG.md` under an `[Unreleased]` section for user-visible changes.

## Code style

- ES modules (`import`/`export`), Node ≥ 20.19.
- No build step — source runs directly.
- Keep new dependencies minimal; prefer the Node stdlib.
