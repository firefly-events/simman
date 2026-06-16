/**
 * Vision provider abstraction.
 *
 * SimMan is not prescriptive about model or host. One `askVision()` surface,
 * pluggable backends:
 *   - mlx       — local OpenAI-compatible server (default; e.g. mlx_lm.server)
 *   - openai    — OpenAI hosted (gpt-4o family), OPENAI_API_KEY
 *   - anthropic — Anthropic hosted (Claude vision), ANTHROPIC_API_KEY
 *   - google    — Google Gemini, GOOGLE_API_KEY / GEMINI_API_KEY
 *
 * Per-role config: grounding and verify can use different providers. Grounding
 * (exact pixel coords) is the hard job — local spatial-VL models are purpose-built
 * for it; hosted frontier models are strong at verify/VQA but looser at precise
 * grounding. Defaults reflect that; override per role freely.
 */

const DEFAULT_LOCAL_ENDPOINT =
  process.env.SIMMAN_MLX_URL || 'http://127.0.0.1:8089/v1/chat/completions';
const DEFAULT_LOCAL_MODEL =
  process.env.SIMMAN_MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';
const DEFAULT_TIMEOUT_MS = Number(process.env.SIMMAN_VISION_TIMEOUT_MS ?? 60000);

/**
 * Curated local models, by role. The installer offers these; not hardcoded into
 * the engine. Grounding models must be spatial-VL; verify can reuse them.
 */
export const RECOMMENDED_LOCAL_MODELS = {
  grounding: [
    { id: 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit', note: 'default — strong pixel grounding, ~5GB' },
    { id: 'mlx-community/Qwen2.5-VL-32B-Instruct-4bit', note: 'higher accuracy, heavier (~18GB)' },
    { id: 'mlx-community/Qwen2.5-VL-3B-Instruct-4bit', note: 'lightweight/faster, lower accuracy' },
  ],
  verify: [
    { id: 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit', note: 'reuse the grounding model' },
    { id: 'mlx-community/gemma-4-12B-it-qat-4bit', note: 'alt general VQA judge' },
  ],
};

/**
 * Hosted defaults per provider when a model is not specified. Grounding entries
 * carry a caveat: hosted precise-grounding is not guaranteed.
 */
const HOSTED_DEFAULT_MODELS = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.0-flash',
};

const envKey = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
};

/**
 * Resolve a role's effective provider config from a global opts bag + an optional
 * per-role override block. Back-compatible: legacy { mlx, model } maps to the
 * local provider.
 *
 * @param {object} opts  engine opts ({ provider, model, endpoint|mlx, apiKey, timeoutMs, grounding?, verify? })
 * @param {'grounding'|'verify'} role
 */
export function resolveProviderConfig(opts = {}, role) {
  const roleOverride = (role && opts[role]) || {};
  const merged = {
    provider: roleOverride.provider ?? opts.provider ?? 'mlx',
    model: roleOverride.model ?? opts.model,
    endpoint: roleOverride.endpoint ?? opts.endpoint ?? opts.mlx,
    apiKey: roleOverride.apiKey ?? opts.apiKey,
    timeoutMs: roleOverride.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return merged;
}

function withTimeout(timeoutMs) {
  return { signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS) };
}

async function postJson(url, headers, body, timeoutMs, label) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...withTimeout(timeoutMs),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`${label} timeout after ${timeoutMs}ms (${url})`);
    }
    throw e;
  }
  if (!r.ok) throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── Adapters ──────────────────────────────────────────────────────────────────

// OpenAI-compatible chat/completions (covers local MLX + OpenAI hosted).
// b64 null/empty → text-only (synthesis from a DOM/a11y summary, no screenshot).
async function askOpenAICompat({ endpoint, apiKey, model, b64, text, timeoutMs, maxTokens = 300 }) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const content = b64
    ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }, { type: 'text', text }]
    : [{ type: 'text', text }];
  const body = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  const j = await postJson(endpoint, headers, body, timeoutMs, 'openai-compat');
  return j.choices?.[0]?.message?.content ?? '';
}

// Anthropic Messages API.
async function askAnthropic({ apiKey, model, b64, text, timeoutMs, maxTokens = 300 }) {
  if (!apiKey) throw new Error('anthropic provider requires ANTHROPIC_API_KEY');
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const content = b64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }, { type: 'text', text }]
    : [{ type: 'text', text }];
  const body = {
    model: model || HOSTED_DEFAULT_MODELS.anthropic,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content }],
  };
  const j = await postJson('https://api.anthropic.com/v1/messages', headers, body, timeoutMs, 'anthropic');
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') ?? '';
}

// Google Gemini generateContent.
async function askGoogle({ apiKey, model, b64, text, timeoutMs, maxTokens = 300 }) {
  if (!apiKey) throw new Error('google provider requires GOOGLE_API_KEY / GEMINI_API_KEY');
  const m = model || HOSTED_DEFAULT_MODELS.google;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const parts = b64
    ? [{ inline_data: { mime_type: 'image/png', data: b64 } }, { text }]
    : [{ text }];
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
  };
  const j = await postJson(url, {}, body, timeoutMs, 'google');
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') ?? '';
}

/**
 * Unified vision ask. Dispatches to the configured provider.
 *
 * @param {string} b64  base64 PNG screenshot
 * @param {string} text prompt
 * @param {object} cfg  resolved provider config ({ provider, model, endpoint, apiKey, timeoutMs })
 * @returns {Promise<string>}
 */
export async function askVision(b64, text, cfg = {}) {
  const provider = cfg.provider || 'mlx';
  const maxTokens = cfg.maxTokens;
  switch (provider) {
    case 'mlx':
    case 'local':
    case 'openai-compat':
      return askOpenAICompat({
        endpoint: cfg.endpoint || DEFAULT_LOCAL_ENDPOINT,
        apiKey: cfg.apiKey,
        model: cfg.model || DEFAULT_LOCAL_MODEL,
        b64, text, timeoutMs: cfg.timeoutMs, maxTokens,
      });
    case 'openai':
      return askOpenAICompat({
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: cfg.apiKey || envKey('OPENAI_API_KEY'),
        model: cfg.model || HOSTED_DEFAULT_MODELS.openai,
        b64, text, timeoutMs: cfg.timeoutMs, maxTokens,
      });
    case 'anthropic':
      return askAnthropic({
        apiKey: cfg.apiKey || envKey('ANTHROPIC_API_KEY'),
        model: cfg.model, b64, text, timeoutMs: cfg.timeoutMs, maxTokens,
      });
    case 'google':
    case 'gemini':
      return askGoogle({
        apiKey: cfg.apiKey || envKey('GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'),
        model: cfg.model, b64, text, timeoutMs: cfg.timeoutMs, maxTokens,
      });
    default:
      throw new Error(`unknown vision provider: ${provider}`);
  }
}
