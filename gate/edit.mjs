/**
 * gate/ — edit loop.
 *
 * The approval gate is not just approve/reject: when synthesis gets a plan wrong
 * (e.g. picks a decoy button, or under-fills a multi-field gate), a human can EDIT
 * the plan in the gate and then approve. That turns a synthesis miss into a
 * correctable plan instead of a hard reject — hybrid autonomy.
 *
 * Two pieces:
 *   applyEdits({scenario, overlay}, edits) — pure; applies paired edit ops and
 *                                            re-validates. Throws on an invalid result.
 *   gateReview({scenario, overlay, decide}) — render → decide(approve|reject|edit) →
 *                                             apply → re-render, until approve/reject.
 *
 * scenario.steps[i] and overlay.steps[i] are paired by index and driven by the
 * engine 1:1, so every edit op operates on BOTH arrays together — they can never
 * drift out of length or order.
 */
import { validateBindings } from '../engine/bindings.mjs';
import { renderPlan, approveOrThrow } from './render.mjs';

function clone(x) { return JSON.parse(JSON.stringify(x)); }

/** Infer the `how` discriminator for an operator-supplied overlay step. */
function inferHow(step) {
  if (!step || typeof step !== 'object') return step;
  if (!step.how) step.how = step.act ? 'native' : (step.target ? 'vision' : step.how);
  return step;
}

/**
 * Re-validate an edited plan the same way the engine will consume it:
 *  - overlay validates against the scenario id (bindings validator)
 *  - scenario.steps and overlay.steps pair 1:1 (same length)
 * Throws a GATE_EDIT_INVALID error describing the first problem.
 */
function revalidate(scenario, overlay) {
  overlay.scenario = scenario.id;
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    const e = new Error('gate edit: scenario.steps must be a non-empty array');
    e.code = 'GATE_EDIT_INVALID';
    throw e;
  }
  try {
    validateBindings(overlay, scenario.id);
  } catch (err) {
    const e = new Error(`gate edit: overlay invalid after edit — ${err.message}`);
    e.code = 'GATE_EDIT_INVALID';
    throw e;
  }
  if (scenario.steps.length !== overlay.steps.length) {
    const e = new Error(
      `gate edit: scenario has ${scenario.steps.length} step(s) but overlay has ${overlay.steps.length}; they must pair 1:1`,
    );
    e.code = 'GATE_EDIT_INVALID';
    throw e;
  }
}

/**
 * Apply a list of edit ops to a plan and return a NEW validated plan. Pure — the
 * input is never mutated. Each op operates on the paired (scenario, overlay) step
 * at the same index.
 *
 * Ops:
 *   { op: 'replace', i, overlay?, scenario? } — overwrite step i's overlay and/or
 *                                               scenario entry (shallow-merge of
 *                                               provided fields).
 *   { op: 'insert',  i, overlay, scenario }   — insert a paired step before index i
 *                                               (i === length appends).
 *   { op: 'remove',  i }                       — drop the paired step i.
 *   { op: 'reorder', order: number[] }         — permute both arrays by `order`
 *                                               (a permutation of 0..n-1).
 *
 * @returns {{scenario:object, overlay:object}}
 */
export function applyEdits(plan, edits = []) {
  const scenario = clone(plan.scenario);
  const overlay = clone(plan.overlay);
  scenario.steps = scenario.steps || [];
  overlay.steps = overlay.steps || [];

  for (const edit of edits) {
    const { op } = edit;
    if (op === 'replace') {
      const { i } = edit;
      if (i < 0 || i >= overlay.steps.length) throw mkInvalid(`replace: index ${i} out of range`);
      if (edit.overlay) overlay.steps[i] = inferHow({ ...overlay.steps[i], ...edit.overlay });
      if (edit.scenario) scenario.steps[i] = { ...scenario.steps[i], ...edit.scenario };
    } else if (op === 'insert') {
      const i = edit.i ?? overlay.steps.length;
      if (i < 0 || i > overlay.steps.length) throw mkInvalid(`insert: index ${i} out of range`);
      if (!edit.overlay || !edit.scenario) throw mkInvalid('insert: requires both overlay and scenario step');
      overlay.steps.splice(i, 0, inferHow(clone(edit.overlay)));
      scenario.steps.splice(i, 0, clone(edit.scenario));
    } else if (op === 'remove') {
      const { i } = edit;
      if (i < 0 || i >= overlay.steps.length) throw mkInvalid(`remove: index ${i} out of range`);
      overlay.steps.splice(i, 1);
      scenario.steps.splice(i, 1);
    } else if (op === 'reorder') {
      const { order } = edit;
      assertPermutation(order, overlay.steps.length);
      overlay.steps = order.map((j) => overlay.steps[j]);
      scenario.steps = order.map((j) => scenario.steps[j]);
    } else {
      throw mkInvalid(`unknown edit op "${op}"`);
    }
  }

  revalidate(scenario, overlay);
  return { scenario, overlay };
}

function mkInvalid(msg) {
  const e = new Error(`gate edit: ${msg}`);
  e.code = 'GATE_EDIT_INVALID';
  return e;
}

function assertPermutation(order, n) {
  if (!Array.isArray(order) || order.length !== n) throw mkInvalid(`reorder: order must list all ${n} indices`);
  const seen = new Set(order);
  if (seen.size !== n) throw mkInvalid('reorder: order has duplicates');
  for (const j of order) if (!Number.isInteger(j) || j < 0 || j >= n) throw mkInvalid(`reorder: bad index ${j}`);
}

/**
 * Run the gate as an edit loop. Repeatedly render the plan and ask `decide` what
 * to do; apply edits and re-render until the operator approves or rejects.
 *
 * @param {object} args
 *   scenario, overlay — the synthesized plan
 *   decide(ctx)       — async/sync. ctx = { scenario, overlay, rendered, round }.
 *                       Returns { action: 'approve'|'reject'|'edit', edits?, reason? }.
 *   approver          — label recorded on approval (default 'human')
 *   maxRounds         — safety cap on edit rounds (default 25)
 *   onRender(text)    — optional sink for the rendered plan each round
 * @returns {Promise<{scenario, overlay, approved:true, approver, edited:boolean, rounds:number}>}
 * @throws GATE_REJECTED on reject, GATE_EDIT_INVALID on an un-appliable edit, after
 *         exhausting maxRounds throws GATE_EDIT_LOOP.
 */
export async function gateReview({ scenario, overlay, decide, approver = 'human', maxRounds = 25, onRender }) {
  let cur = { scenario: clone(scenario), overlay: clone(overlay) };
  let edited = false;
  for (let round = 1; round <= maxRounds; round++) {
    const rendered = renderPlan(cur.scenario, cur.overlay);
    if (onRender) onRender(rendered);
    const decision = await decide({ scenario: cur.scenario, overlay: cur.overlay, rendered, round });
    const action = decision?.action;
    if (action === 'approve') {
      approveOrThrow({ scenario: cur.scenario, overlay: cur.overlay, approved: true, approver });
      return { ...cur, approved: true, approver, edited, rounds: round };
    }
    if (action === 'reject') {
      approveOrThrow({ scenario: cur.scenario, overlay: cur.overlay, approved: false, approver });
    }
    if (action === 'edit') {
      cur = applyEdits(cur, decision.edits || []); // throws GATE_EDIT_INVALID on bad edit
      edited = true;
      continue;
    }
    throw mkInvalid(`decide returned unknown action "${action}"`);
  }
  const e = new Error(`gate edit: not resolved after ${maxRounds} rounds`);
  e.code = 'GATE_EDIT_LOOP';
  throw e;
}

/**
 * Interactive readline decider for real CLI use. Presents the plan and accepts:
 *   a / approve          — approve and run
 *   r / reject           — block execution
 *   e <json-edits>       — apply edit ops (a JSON array of ops), then re-render
 *
 * Returns a `decide` function suitable for gateReview({ decide }).
 * (The spikes/tests use a scripted decider instead; this is the human path.)
 */
export function interactiveDecider({ input = process.stdin, output = process.stdout } = {}) {
  return async ({ rendered }) => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input, output });
    try {
      output.write(`\n${rendered}\n`);
      const ans = (await rl.question('gate> approve (a) / reject (r) / edit <json> (e ...): ')).trim();
      if (ans === 'a' || ans === 'approve') return { action: 'approve' };
      if (ans === 'r' || ans === 'reject') return { action: 'reject' };
      if (ans === 'e' || ans.startsWith('e ') || ans.startsWith('edit ')) {
        const json = ans.replace(/^(e|edit)\s*/, '').trim();
        let edits = [];
        if (json) {
          try { edits = JSON.parse(json); } catch { output.write('invalid edit JSON — ignoring\n'); }
        }
        return { action: 'edit', edits };
      }
      output.write('unrecognized — treating as reject\n');
      return { action: 'reject' };
    } finally {
      rl.close();
    }
  };
}
