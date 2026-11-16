/**
 * cli/synthesize.mjs — `simman synthesize <url> "<goal>"`.
 *
 * The autonomous loop, human-gated:
 *   1. explore   — open the page, capture interactables + screenshot
 *   2. synthesize — LLM compiles the goal into a { scenario, overlay } plan
 *   3. GATE      — plan rendered human-readable; approve / edit ($EDITOR) / reject.
 *                  Nothing the agent infers reaches a real cursor without approval.
 *   4. save      — approved plan written to scenarios/<id>.yaml (authored format,
 *                  re-loadable by `simman run` with no further LLM involvement)
 *   5. run       — execute immediately through the engine (skip with --no-run)
 *
 * Exit codes: 0 pass (or saved with --no-run) · 1 run failed · 2 error · 3 rejected at gate
 */
import { writeFileSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

import { synthesize } from '../agent/synthesize.mjs';
import { renderPlan, approveOrThrow } from '../gate/render.mjs';
import { validateBindings } from '../engine/bindings.mjs';
import { parseScenario } from '../engine/scenario.mjs';
import { runActualFlow } from '../engine/flow-runner.mjs';
import { renderReport } from './report.mjs';
import { resolveProviders, missingKeyRoles } from './config.mjs';

/**
 * Reverse-compile an engine { scenario, overlay } pair back into the authored
 * scenario YAML shape (the `do` sugar). The saved file round-trips through
 * parseScenario, so the artifact a human reviews is the artifact that runs.
 */
export function planToAuthoredYaml(scenario, overlay, { baseUrl } = {}) {
  const steps = scenario.steps.map((s, i) => {
    const b = overlay.steps[i];
    const step = { action: s.action, expected: s.expected };
    if (b.how === 'vision') {
      step.do = { vision: b.target };
    } else {
      const a = b.args || {};
      switch (b.act) {
        case 'fill':
          step.do = { fill: a.selector, value: a.value ?? a.text ?? '' };
          break;
        case 'tapRole':
          step.do = (!a.role || a.role === 'button')
            ? { tapRole: a.name }
            : { tapRole: { role: a.role, name: a.name } };
          break;
        case 'tapText':
          step.do = { tapText: a.text ?? a.name };
          break;
        case 'goto':
          step.do = { goto: a.url ?? a.path };
          break;
        case 'wait':
          step.do = { wait: a.ms ?? 300 };
          break;
        default:
          throw new Error(`cannot reverse-compile unknown act "${b.act}"`);
      }
    }
    if (b.truth !== undefined) step.truth = b.truth;
    return step;
  });

  const doc = { id: scenario.id, ...(baseUrl ? { baseUrl } : {}), steps };
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function replayCommand(outPath, values, browser) {
  const args = ['run', outPath];
  if (values.config) args.push('--config', values.config);
  if (values.local) args.push('--local');
  if (values.provider) args.push('--provider', values.provider);
  if (values.coords) args.push('--coords', values.coords);
  if (values.headless === false) args.push('--no-headless');
  if (browser?.viewport) {
    const { width, height } = browser.viewport;
    const scale = browser.deviceScaleFactor ?? 1;
    const device = `${width}x${height}${scale !== 1 ? `@${scale}` : ''}${browser.hasTouch ? ',touch' : ''}`;
    args.push('--device', device);
  }
  if (browser?.storageState) args.push('--storage-state', browser.storageState);
  for (const pattern of browser?.block || []) args.push(`--block=${pattern}`);
  return `simman ${args.map(shellQuote).join(' ')}`;
}

/** Open the plan JSON in $EDITOR; return the edited { scenario, overlay } (validated). */
function editInEditor(plan, { errLog }) {
  const dir = mkdtempSync(join(tmpdir(), 'simman-gate-'));
  const file = join(dir, `${plan.scenario.id || 'plan'}.json`);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  try {
    writeFileSync(file, JSON.stringify({ scenario: plan.scenario, overlay: plan.overlay }, null, 2));
    const res = spawnSync(editor, [file], { stdio: 'inherit' });
    if (res.error) throw new Error(`cannot launch editor "${editor}": ${res.error.message}`);
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    if (!edited?.scenario?.steps || !edited?.overlay?.steps) {
      throw new Error('edited plan must keep { scenario: { steps }, overlay: { steps } }');
    }
    edited.overlay.scenario = edited.scenario.id;
    validateBindings(edited.overlay, edited.scenario.id);
    if (edited.scenario.steps.length !== edited.overlay.steps.length) {
      throw new Error(`scenario has ${edited.scenario.steps.length} step(s) but overlay has ${edited.overlay.steps.length}; they must pair 1:1`);
    }
    return { scenario: edited.scenario, overlay: edited.overlay };
  } catch (e) {
    errLog(`edit rejected: ${e.message} — keeping previous plan`);
    return plan;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Interactive TTY gate: render → [a]pprove / [e]dit in $EDITOR / [r]eject. */
async function ttyGate(plan, { input, output, errLog, maxRounds = 25 }) {
  const { createInterface } = await import('node:readline/promises');
  let cur = plan;
  for (let round = 1; round <= maxRounds; round++) {
    output.write(`\n${renderPlan(cur.scenario, cur.overlay)}\n\n`);
    const rl = createInterface({ input, output });
    let ans;
    try { ans = (await rl.question('gate> [a]pprove · [e]dit in $EDITOR · [r]eject: ')).trim().toLowerCase(); }
    finally { rl.close(); }
    if (ans === 'a' || ans === 'approve') {
      approveOrThrow({ scenario: cur.scenario, overlay: cur.overlay, approved: true });
      return { ...cur, edited: cur !== plan, rounds: round };
    }
    if (ans === 'r' || ans === 'reject') {
      approveOrThrow({ scenario: cur.scenario, overlay: cur.overlay, approved: false });
    }
    if (ans === 'e' || ans === 'edit') {
      cur = editInEditor(cur, { errLog });
      continue;
    }
    output.write('unrecognized — a / e / r\n');
  }
  const e = new Error(`gate: not resolved after ${maxRounds} rounds`);
  e.code = 'GATE_EDIT_LOOP';
  throw e;
}

/**
 * The `synthesize` subcommand. Returns a process exit code.
 * @param {{url:string, goal:string, values:object}} args   parsed CLI inputs
 * @param {{log?:Function, errLog?:Function, decide?:Function}} [io]
 *   io.decide — optional non-interactive gate (tests): ({scenario, overlay}) =>
 *               { action: 'approve'|'reject', scenario?, overlay? }
 */
export async function synthesizeCommand({ url, goal, values }, io = {}) {
  const log = io.log || console.log;
  const errLog = io.errLog || console.error;

  if (!url || !goal) {
    errLog('synthesize: a target URL and a quoted goal are required');
    errLog('  e.g. simman synthesize http://localhost:3100 "compose a post and publish it"');
    return 2;
  }

  let providers;
  try { providers = resolveProviders({ flags: values }); }
  catch (e) { errLog(`error: ${e.message}`); return 2; }

  // Synthesis needs the synth role now, grounding+verify for the run after approval.
  const neededRoles = values['no-run'] ? ['synth'] : ['synth', 'grounding', 'verify'];
  const missing = missingKeyRoles(providers, neededRoles);
  if (missing.length) {
    errLog(`error: missing API key for hosted role(s): ${missing.join(', ')}. Set GEMINI_API_KEY (or GOOGLE_API_KEY), or run with --local.`);
    return 2;
  }

  log(`SimMan synthesize — exploring ${url}`);
  log(`  goal: ${goal}`);

  let plan;
  try {
    plan = await synthesize({
      url, goal,
      headless: values.headless,
      providerCfg: providers.synth,
      ...providers.browser,
      retries: 2,
    });
  } catch (e) {
    if (e.blocked?.length) {
      const report = {
        scenario: url,
        flowPassed: false,
        stepsPassed: '0/1',
        posted: false,
        blocked: e.blocked,
        steps: [{ i: 0, action: 'exploration', expected: 'page loaded', acted: false, pass: false, why: 'blocked' }],
      };
      if (values.json) log(JSON.stringify(report, null, 2));
      else log(renderReport(report));
      return 1;
    }
    errLog(`error: synthesis failed — ${e.message}`);
    if (e.lastRaw) errLog(`  last model output: ${e.lastRaw.slice(0, 300)}`);
    return 2;
  }

  // ── GATE ── agent proposes, human disposes.
  let approved;
  try {
    if (io.decide) {
      const d = await io.decide({ scenario: plan.scenario, overlay: plan.overlay });
      if (d.action !== 'approve') approveOrThrow({ ...plan, approved: false });
      approved = { scenario: d.scenario || plan.scenario, overlay: d.overlay || plan.overlay };
      validateBindings(approved.overlay, approved.scenario.id);
    } else {
      approved = await ttyGate(
        { scenario: plan.scenario, overlay: plan.overlay },
        { input: process.stdin, output: process.stdout, errLog },
      );
    }
  } catch (e) {
    if (e.code === 'GATE_REJECTED') { errLog('gate: plan rejected — nothing was executed'); return 3; }
    errLog(`error: ${e.message}`);
    return 2;
  }

  // ── SAVE ── authored YAML, round-trip-validated through the real loader.
  const outDir = resolve(values.out || 'scenarios');
  const outPath = join(outDir, `${approved.scenario.id}.yaml`);
  let loaded;
  try {
    const text = planToAuthoredYaml(approved.scenario, approved.overlay, { baseUrl: url });
    loaded = parseScenario(text, outPath); // throws if the artifact wouldn't re-load
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, text);
  } catch (e) {
    errLog(`error: could not save approved plan — ${e.message}`);
    return 2;
  }
  log(`✔ saved ${outPath}`);
  log(`  re-run any time (no LLM synthesis needed): ${replayCommand(outPath, values, providers.browser)}`);

  if (values['no-run']) {
    if (values.json) log(JSON.stringify({ scenario: approved.scenario.id, blocked: plan.blocked || [] }, null, 2));
    else if (plan.blocked?.length) log(`  exploration blocked: ${plan.blocked.length} request(s)`);
    return 0;
  }

  // ── RUN ── through the engine, exactly as `simman run` would.
  log('▶ running…');
  let report;
  try {
    report = await runActualFlow({
      scenario: loaded.scenario,
      overlay: loaded.overlay,
      baseUrl: url,
      headless: values.headless,
      coords: providers.coords,
      grounding: providers.grounding,
      verify: providers.verify,
      ...providers.browser,
      stepTimeoutMs: 90000,
    });
    if (plan.blocked?.length) report.blocked = [...plan.blocked, ...(report.blocked || [])];
  } catch (e) {
    errLog(`error: run failed — ${e.message}`);
    return 2;
  }

  if (values.json) log(JSON.stringify(report, null, 2));
  else log(renderReport(report, { source: outPath }));
  return report.flowPassed ? 0 : 1;
}
