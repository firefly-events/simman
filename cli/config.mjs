/**
 * cli/config.mjs — provider configuration resolution (Slice 4).
 *
 * Resolves per-role vision providers (grounding / verify / synth) from, in
 * precedence order:
 *   1. CLI flags        (--local, --provider, --coords, --config)
 *   2. config file      (simman.config.{yaml,json} | .simmanrc.{yaml,json}, or --config)
 *   3. built-in defaults (hosted-default posture)
 *
 * Per-role config: { provider, model, endpoint?, apiKey?, coords?, thinkingBudget?, maxTokens? }.
 * API keys come from the environment only (never the config file).
 *
 * Coordinate convention is PER GROUNDING PROVIDER (Slice 0 finding): local Qwen-VL
 * returns pixel coords, gemini returns normalized 0-1000. `coords` therefore defaults
 * to the grounding provider's convention unless explicitly overridden.
 *
 * Recommended hybrid (best accuracy): grounding/verify local Qwen-VL + synth hosted.
 * Default (zero-config): everything hosted gemini.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseDevice, validateStorageState } from '../engine/browser-context.mjs';

const HOSTED_MODEL = 'gemini-2.5-flash';
const LOCAL_ENDPOINT = 'http://127.0.0.1:8089/v1/chat/completions';
const LOCAL_MODEL = 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit';
const ROLES = ['grounding', 'verify', 'synth'];

const KEY_ENVS = {
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

const CONFIG_NAMES = ['simman.config.yaml', 'simman.config.yml', 'simman.config.json', '.simmanrc.yaml', '.simmanrc.json'];

function isLocal(p) { return p === 'mlx' || p === 'local'; }
function providerCoords(p) { return isLocal(p) ? 'px' : 'norm'; }
function keyFor(provider, env) { for (const k of (KEY_ENVS[provider] || [])) if (env[k]) return env[k]; return undefined; }

/** Load a config file (explicit path, or autodiscovered in cwd). Returns {path, data}. */
export function loadConfigFile(explicit, cwd = process.cwd()) {
  const candidates = explicit ? [explicit] : CONFIG_NAMES.map((n) => join(cwd, n));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); }
    catch (e) { throw cfgErr(`cannot read config ${p} — ${e.message}`); }
    try { return { path: p, data: (p.endsWith('.json') ? JSON.parse(text) : yaml.load(text)) || {} }; }
    catch (e) { throw cfgErr(`config ${p} — ${e.message}`); }
  }
  return { path: null, data: {} };
}

function cfgErr(msg) { const e = new Error(msg); e.code = 'CONFIG_INVALID'; return e; }

/**
 * Resolve provider config for all roles.
 * @param {{flags?:object, env?:object, cwd?:string}} [o]
 *   flags: { local, provider, coords, config }
 * @returns {{grounding, verify, synth, coords, configPath}}
 */
export function resolveProviders({ flags = {}, env = process.env, cwd = process.cwd() } = {}) {
  const { path: configPath, data } = loadConfigFile(flags.config, cwd);
  const forceLocal = !!flags.local;

  const build = (role) => {
    const fileRole = data[role] || {};
    const provider = forceLocal ? 'mlx' : (fileRole.provider || flags.provider || data.provider || 'google');
    const cfg = { provider };
    if (isLocal(provider)) {
      cfg.endpoint = fileRole.endpoint || data.endpoint || LOCAL_ENDPOINT;
      cfg.model = fileRole.model || LOCAL_MODEL;
    } else {
      cfg.model = fileRole.model || HOSTED_MODEL;
      cfg.apiKey = keyFor(provider, env);
      if (provider === 'google' || provider === 'gemini') { cfg.thinkingBudget = 0; cfg.maxTokens = 2048; }
    }
    return cfg;
  };

  const out = {};
  for (const r of ROLES) out[r] = build(r);
  out.coords = flags.coords || data.coords || providerCoords(out.grounding.provider);
  out.configPath = configPath;
  out.browser = resolveBrowserOptions({ flags, data, env, cwd });
  return out;
}

/** Resolve browser emulation/auth/routing options after provider config is loaded. */
export function resolveBrowserOptions({ flags = {}, data = {}, env = process.env } = {}) {
  const deviceValue = flags.device !== undefined ? flags.device : data.device;
  const device = deviceValue !== undefined
    ? parseDevice(deviceValue)
    : {
      viewport: {
        width: Number(env.VIEWPORT_W ?? 1280),
        height: Number(env.VIEWPORT_H ?? 800),
      },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
  const selectedState = flags['storage-state'] !== undefined
    ? flags['storage-state']
    : data.storageState;
  const selectedBlocks = flags.block !== undefined ? flags.block : data.block;
  return {
    ...device,
    ...(selectedState !== undefined ? { storageState: validateStorageState(selectedState) } : {}),
    block: selectedBlocks === undefined ? [] : (Array.isArray(selectedBlocks) ? selectedBlocks.map(String) : [String(selectedBlocks)]),
  };
}

/**
 * Names of roles whose hosted provider is missing its API key. Empty = all good.
 * @param {object} resolved  output of resolveProviders
 * @param {string[]} roles   roles to check (e.g. ['grounding','verify'])
 */
export function missingKeyRoles(resolved, roles) {
  return roles.filter((r) => {
    const c = resolved[r];
    return c && !isLocal(c.provider) && !c.apiKey;
  });
}
