# Vision providers

SimMan is **not** prescriptive about model or host. The vision calls (grounding +
verify) route through a pluggable provider layer (`engine/providers.mjs`). Use
local models or any of the hosted APIs — per role, mix freely.

## Providers

| provider | host | auth (env) | notes |
| --- | --- | --- | --- |
| `mlx` | local OpenAI-compatible server (e.g. `mlx_vlm.server`) | none | recommended for **grounding** |
| `openai` | OpenAI hosted | `OPENAI_API_KEY` | gpt-4o family |
| `anthropic` | Anthropic hosted | `ANTHROPIC_API_KEY` | Claude vision |
| `google` | Google Gemini | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Gemini vision |

Local is not MLX-only — any OpenAI-compatible local server (Ollama, LM Studio,
vLLM) works via `provider: 'mlx'` with a custom `endpoint`.

## Two jobs, different difficulty

- **Grounding** — return exact pixel coordinates of a target. The *hard* job.
  Local spatial-VL models (Qwen2.5-VL) are purpose-built for it. Frontier hosted
  models are strong at VQA but historically **looser at precise pixel coords** —
  use them for grounding only after validating on your UI.
- **Verify** — judge pass/fail from a screenshot. Hosted frontier models excel.

CLI default: **hosted Gemini** (zero local setup — set `GEMINI_API_KEY`). Pass `--local` to switch to local MLX for grounding.

## Configuring per role

Pass to `runActualFlow(options)` (or the engine `opts`):

```js
await runActualFlow({
  scenario, overlay, baseUrl,
  provider: 'mlx',                                 // global default
  grounding: { provider: 'mlx',                    // the hard job → local VL
    endpoint: 'http://127.0.0.1:8089/v1/chat/completions',
    model: 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit' },
  verify:    { provider: 'anthropic',              // VQA → hosted, if a key is set
    model: 'claude-sonnet-4-6' },
});
```

`grounding` / `verify` override the global `provider`/`model`. Omit everything →
the global `provider` default (`mlx` at the API level; CLI uses hosted Gemini when
`GEMINI_API_KEY` is set). Legacy `mlxEndpoint` / `mlxModel` still work for the local path.

## Recommended local models

Curated in `RECOMMENDED_LOCAL_MODELS` (`engine/providers.mjs`); the installer will
offer these rather than hardcoding one:

- **grounding:** `Qwen2.5-VL-7B-Instruct-4bit` (default), `-32B` (higher accuracy),
  `-3B` (lighter/faster)
- **verify:** reuse the grounding model, or a general VQA model

## Status

Local (`mlx`) path is validated end-to-end (spike 1). Hosted adapters
(`openai`/`anthropic`/`google`) are code-complete to each API's documented shape
but **untested live** — no keys were present at build time. Smoke-test each before
relying on it, especially for grounding.
