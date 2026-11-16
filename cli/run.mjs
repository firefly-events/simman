/**
 * cli/run.mjs — the `simman` CLI.
 *
 * v1 surface (scenario-file-first):
 *   simman run <file.yaml> [--local] [--provider <p>] [--base-url <url>]
 *                          [--no-headless] [--json] [--captures <dir>]
 *
 * Loads a scenario file (Slice 1), resolves a vision provider, runs it through the
 * engine, prints a report, and exits 0 (pass) / 1 (fail) / 2 (error). `simman plan`
 * and `simman doctor` are added in later slices.
 */
import { parseArgs } from 'node:util';
import { resolve as resolvePath } from 'node:path';
import { loadScenario } from '../engine/scenario.mjs';
import { runActualFlow } from '../engine/flow-runner.mjs';
import { renderReport } from './report.mjs';
import { doctor } from './doctor.mjs';
import { resolveProviders, missingKeyRoles } from './config.mjs';

const USAGE = `simman — selectorless vision-cursor web testing

Usage:
  simman run <scenario.yaml> [options]
  simman synthesize <url> "<goal>" [options]
  simman doctor [--local] [--fix]

Options:
  --local               use a local MLX vision model (default: hosted)
  --provider <name>     vision provider for all roles: google | mlx
  --config <path>       explicit config file (else autodiscover simman.config.*)
  --coords <px|norm>    override the grounding coordinate convention
  --device <WxH[@scale][,touch]>  emulate a viewport/device context
  --storage-state <file>  load Playwright storage state from this path
  --block <pattern>     abort matching requests (repeatable; * is a glob)
                        e.g. 390x844@3,touch
  --base-url <url>      override the scenario's baseUrl
  --no-headless         run with a visible browser
  --json                print the raw JSON report instead of the human summary
  --captures <dir>      (run) where capture steps save <screen-name>.png
  --fix                (doctor) auto-install missing playwright browsers
  --out <dir>           (synthesize) directory for the saved scenario (default: scenarios/)
  --no-run              (synthesize) save the approved plan without executing it
  -h, --help            show this help

simman synthesize compiles a natural-language goal into a test plan, shows it at
an approval gate (approve / edit in $EDITOR / reject), saves the approved plan as
a plain scenario YAML, and runs it. Nothing executes without approval.

Exit codes: 0 pass · 1 fail · 2 error · 3 rejected at gate`;

/**
 * Run the CLI. Returns a process exit code (does not call process.exit).
 * @param {string[]} argv  args after the node binary + script (process.argv.slice(2))
 * @param {{log?:Function, errLog?:Function}} [io]
 */
export async function run(argv, io = {}) {
  const log = io.log || console.log;
  const errLog = io.errLog || console.error;

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        local: { type: 'boolean', default: false },
        provider: { type: 'string' },
        config: { type: 'string' },
        coords: { type: 'string' },
        device: { type: 'string' },
        'storage-state': { type: 'string' },
        block: { type: 'string', multiple: true },
        'base-url': { type: 'string' },
        headless: { type: 'boolean', default: true },
        json: { type: 'boolean', default: false },
        captures: { type: 'string' },
        fix: { type: 'boolean', default: false },
        out: { type: 'string' },
        'no-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    errLog(e.message);
    errLog(USAGE);
    return 2;
  }

  const { values, positionals } = parsed;
  const [cmd, file] = positionals;

  if (values.coords && !['px', 'norm'].includes(values.coords)) {
    errLog(`--coords must be "px" or "norm"; got "${values.coords}"`); return 2;
  }
  if (values.provider && !['google', 'gemini', 'openai', 'anthropic', 'mlx', 'local'].includes(values.provider)) {
    errLog(`--provider must be one of google | openai | anthropic | mlx; got "${values.provider}"`); return 2;
  }

  if (values.help || !cmd) { log(USAGE); return values.help ? 0 : 2; }
  if (cmd === 'doctor') return doctor({ local: values.local, fix: values.fix }, { log });
  if (cmd === 'synthesize') {
    const { synthesizeCommand } = await import('./synthesize.mjs');
    const [, url, goal] = positionals;
    return synthesizeCommand({ url, goal, values }, io);
  }
  if (cmd !== 'run') { errLog(`unknown command "${cmd}".`); errLog(USAGE); return 2; }
  if (!file) { errLog('run: a scenario file path is required'); errLog(USAGE); return 2; }

  let loaded; let providers;
  try {
    loaded = loadScenario(file);
    providers = resolveProviders({ flags: values });
  } catch (e) {
    errLog(`error: ${e.message}`);
    return 2;
  }

  // The run command uses grounding + verify; fail early if a hosted role lacks its key.
  const missing = missingKeyRoles(providers, ['grounding', 'verify']);
  if (missing.length) {
    errLog(`error: missing API key for hosted role(s): ${missing.join(', ')}. Set GEMINI_API_KEY (or GOOGLE_API_KEY), or run with --local.`);
    return 2;
  }

  const baseUrl = values['base-url'] || loaded.scenario.baseUrl;
  if (!baseUrl) {
    errLog('error: no target URL — set baseUrl in the scenario or pass --base-url');
    return 2;
  }

  let report;
  try {
    report = await runActualFlow({
      scenario: loaded.scenario,
      overlay: loaded.overlay,
      baseUrl,
      headless: values.headless,
      coords: providers.coords,
      grounding: providers.grounding,
      verify: providers.verify,
      ...providers.browser,
      stepTimeoutMs: 90000,
      ...(values.captures ? { capturesDir: resolvePath(values.captures) } : {}),
    });
  } catch (e) {
    errLog(`error: run failed — ${e.message}`);
    return 2;
  }

  if (values.json) log(JSON.stringify(report, null, 2));
  else log(renderReport(report, { source: loaded.source }));

  return report.flowPassed ? 0 : 1;
}
