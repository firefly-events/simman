/**
 * cli/doctor.mjs — `simman doctor`: preflight checks for a clean machine.
 *
 *   simman doctor            # hosted-default checks
 *   simman doctor --local    # also require a reachable local MLX sidecar
 *   simman doctor --fix      # auto-install playwright browsers if missing
 *
 * Required checks failing → exit 1. Each check returns { name, status, detail, fix? }
 * where status is 'ok' | 'warn' | 'fail' | 'skip'. Checks are individually exported
 * for testing; the network + browser checks accept injected impls.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MIN_NODE = [20, 19];
const MLX_URL = process.env.MLX_URL || 'http://127.0.0.1:8089/v1/models';

function cmp(a, b) { return a[0] - b[0] || (a[1] || 0) - (b[1] || 0); }

/** Node runtime version meets the engines floor. */
export function checkNode(versionString = process.versions.node) {
  const [maj, min] = versionString.split('.').map(Number);
  const ok = cmp([maj, min], MIN_NODE) >= 0;
  return {
    name: 'node runtime', required: true,
    status: ok ? 'ok' : 'fail',
    detail: `node ${versionString} (need >= ${MIN_NODE.join('.')})`,
  };
}

/**
 * Playwright's Chromium is installed FOR THE PINNED playwright version — the spike-1
 * finding: a global browser cache built by a different playwright version does not
 * satisfy the pinned one. We ask playwright where it WOULD launch from and check that
 * binary exists.
 */
export async function checkPlaywright(loadChromium = async () => (await import('playwright')).chromium) {
  let chromium;
  try { chromium = await loadChromium(); }
  catch (e) {
    return { name: 'playwright', required: true, status: 'fail', detail: `playwright not installed — ${e.message}`, fix: 'npm install' };
  }
  let path;
  try { path = chromium.executablePath(); }
  catch (e) {
    return { name: 'playwright chromium', required: true, status: 'fail', detail: `cannot resolve chromium path — ${e.message}`, fix: 'npx playwright install chromium' };
  }
  const ok = !!path && existsSync(path);
  return {
    name: 'playwright chromium', required: true,
    status: ok ? 'ok' : 'fail',
    detail: ok ? `installed (${path.split('/').slice(-4, -1).join('/')})` : 'chromium not installed for this playwright version',
    fix: ok ? undefined : 'npx playwright install chromium',
  };
}

/** A hosted vision key is present (required unless --local). */
export function checkProvider(env = process.env, { local = false } = {}) {
  if (local) {
    return { name: 'vision provider', required: false, status: 'skip', detail: 'local mode — hosted key not required' };
  }
  const which = env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' : null;
  return which
    ? { name: 'hosted vision key', required: true, status: 'ok', detail: `${which} set` }
    : { name: 'hosted vision key', required: true, status: 'fail', detail: 'no GEMINI_API_KEY / GOOGLE_API_KEY', fix: 'export GEMINI_API_KEY=… (or run with --local)' };
}

/** Local MLX sidecar reachable — required only in --local mode, else informational. */
export async function checkMlx({ local = false, fetchImpl = globalThis.fetch, url = MLX_URL, timeoutMs = 2500 } = {}) {
  if (!local) return { name: 'local MLX sidecar', required: false, status: 'skip', detail: 'hosted mode — MLX not required' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal });
    return r.ok
      ? { name: 'local MLX sidecar', required: true, status: 'ok', detail: `reachable at ${url}` }
      : { name: 'local MLX sidecar', required: true, status: 'fail', detail: `${url} returned HTTP ${r.status}` };
  } catch (e) {
    return { name: 'local MLX sidecar', required: true, status: 'fail', detail: `unreachable at ${url} — ${e.name === 'AbortError' ? 'timeout' : e.message}`, fix: 'start an MLX server on :8089' };
  } finally { clearTimeout(t); }
}

const GLYPH = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

/**
 * Run doctor. Returns a process exit code (0 ok / 1 required-failure). Does not exit.
 * @param {{local?:boolean, fix?:boolean}} flags
 * @param {{log?:Function, env?:object, runFix?:Function, deps?:object}} [io]
 */
export async function doctor(flags = {}, io = {}) {
  const log = io.log || console.log;
  const env = io.env || process.env;
  const deps = io.deps || {};

  log('SimMan doctor');
  let checks = [
    checkNode(),
    await checkPlaywright(deps.loadChromium),
    checkProvider(env, flags),
    await checkMlx({ local: flags.local, fetchImpl: deps.fetchImpl }),
  ];

  // --fix: attempt the recorded fix for failing browser install (the only safe auto-fix).
  if (flags.fix) {
    const pw = checks.find((c) => c.name === 'playwright chromium' && c.status === 'fail');
    if (pw) {
      log('  → fixing: installing playwright chromium…');
      const runFix = io.runFix || (() => execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' }));
      try { runFix(); checks = checks.map((c) => c === pw ? { ...c, status: 'ok', detail: 'installed via --fix' } : c); }
      catch (e) { log(`  → fix failed: ${e.message}`); }
    }
  }

  for (const c of checks) {
    log(`  ${GLYPH[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status === 'fail') log(`      fix: ${c.fix}`);
  }

  const failed = checks.filter((c) => c.required && c.status === 'fail');
  log(`  ${'─'.repeat(40)}`);
  log(failed.length ? `  NOT READY — ${failed.length} required check(s) failed` : '  OK — ready to run');
  return failed.length ? 1 : 0;
}
