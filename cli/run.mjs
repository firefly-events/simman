/**
 * cli/run.mjs — the `simman` CLI.
 *
 * v1 surface (scenario-file-first):
 *   simman run <file.yaml> [--local] [--provider <p>] [--base-url <url>]
 *                          [--no-headless] [--json]
 *
 * Loads a scenario file (Slice 1), resolves a vision provider, runs it through the
 * engine, prints a report, and exits 0 (pass) / 1 (fail) / 2 (error). `simman plan`
 * and `simman doctor` are added in later slices.
 */
import { parseArgs } from 'node:util';
import { loadScenario } from '../engine/scenario.mjs';
import { runActualFlow } from '../engine/flow-runner.mjs';
import { renderReport } from './report.mjs';
import { doctor } from './doctor.mjs';

const USAGE = `simman — selectorless vision-cursor web testing

Usage:
  simman run <scenario.yaml> [options]
  simman doctor [--local] [--fix]

Options:
  --local               use a local MLX vision model (default: hosted)
  --provider <name>     vision provider: google | mlx   (default: google, or mlx with --local)
  --base-url <url>      override the scenario's baseUrl
  --no-headless         run with a visible browser
  --json                print the raw JSON report instead of the human summary
  --fix                 (doctor) auto-install missing playwright browsers
  -h, --help            show this help

Exit codes: 0 pass · 1 fail · 2 error`;

/**
 * Resolve vision provider config for grounding + verify.
 *
 * NOTE: this is the minimal Slice-2 resolver. Slice 4 replaces it with config-file +
 * per-role resolution. The coords mode is per-provider (Slice 0 finding): local Qwen
 * returns pixel coords, gemini returns normalized 0-1000.
 */
function resolveProviders({ local, provider }) {
  const name = provider || (local ? 'mlx' : 'google');
  if (name === 'mlx' || name === 'local') {
    return { coords: 'px', grounding: { provider: 'mlx' }, verify: { provider: 'mlx' } };
  }
  if (name === 'google' || name === 'gemini') {
    if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
      throw cliError('hosted provider needs GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment. Set it, or run with --local.');
    }
    const g = { provider: 'google', model: 'gemini-2.5-flash', thinkingBudget: 0, maxTokens: 2048 };
    return { coords: 'norm', grounding: g, verify: { ...g } };
  }
  throw cliError(`unknown provider "${name}" (supported in v1: google, mlx)`);
}

function cliError(msg) { const e = new Error(msg); e.code = 'CLI_ERROR'; return e; }

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
        'base-url': { type: 'string' },
        headless: { type: 'boolean', default: true },
        json: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
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

  if (values.help || !cmd) { log(USAGE); return values.help ? 0 : 2; }
  if (cmd === 'doctor') return doctor({ local: values.local, fix: values.fix }, { log });
  if (cmd !== 'run') { errLog(`unknown command "${cmd}". ${''}`); errLog(USAGE); return 2; }
  if (!file) { errLog('run: a scenario file path is required'); errLog(USAGE); return 2; }

  let loaded; let providers;
  try {
    loaded = loadScenario(file);
    providers = resolveProviders(values);
  } catch (e) {
    errLog(`error: ${e.message}`);
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
      stepTimeoutMs: 90000,
    });
  } catch (e) {
    errLog(`error: run failed — ${e.message}`);
    return 2;
  }

  if (values.json) log(JSON.stringify(report, null, 2));
  else log(renderReport(report, { source: loaded.source }));

  return report.flowPassed ? 0 : 1;
}
