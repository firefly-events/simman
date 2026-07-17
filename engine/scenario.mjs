/**
 * engine/scenario.mjs — the scenario file format + loader (v1 spine).
 *
 * A SimMan scenario is ONE YAML file describing a flow in authoring-friendly terms.
 * It compiles to exactly the { scenario, overlay } pair the engine consumes, so the
 * file is the canonical authored artifact and the engine input is derived, never
 * hand-written.
 *
 * Canonical format:
 *
 *   id: publish-campaign            # required, kebab id
 *   baseUrl: http://localhost:4175  # optional; the CLI/config may override
 *   steps:                          # required, non-empty
 *     - action: Enter a caption     # what a user does (required)
 *       expected: Post Now enables  # observable result (required)
 *       do: { fill: "#caption", value: "hi" }   # the action sugar (required)
 *       truth: cta_enabled          # optional DOM/network ground-truth signal
 *     - action: Publish the post
 *       expected: the post is published
 *       do: { tapRole: "Post Now" } # role defaults to "button"
 *       truth: posted
 *     - action: Confirm visually
 *       expected: a confirmation shows
 *       do: { vision: "the green Posted! confirmation banner" }
 *
 * `do` is a single-act map. Exactly one of these keys selects the act:
 *   fill:    "<css>"  (+ value: "<text>")          → native fill
 *   tapRole: "<name>" | { role, name }             → native tapRole (role default button)
 *   tapText: "<visible text>"                       → native tapText
 *   goto:    "<abs url>" | "/rel/path"              → native goto
 *   wait:    <ms:int>                               → native wait
 *   vision:  "<plain-language element description>" → vision grounding+click
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { validateBindings, validateTruth } from './bindings.mjs';

const ACT_KEYS = ['fill', 'tapRole', 'tapText', 'goto', 'wait', 'vision'];

function err(msg, source) {
  const e = new Error(`${source ? source + ': ' : ''}${msg}`);
  e.code = 'SCENARIO_INVALID';
  return e;
}

/** Compile one authored step into { scn, ov } (scenario entry + overlay entry). */
function compileStep(step, i, source) {
  const at = `step ${i}`;
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw err(`${at}: must be a mapping`, source);
  if (typeof step.action !== 'string' || !step.action.trim()) throw err(`${at}: "action" is required (string)`, source);
  if (typeof step.expected !== 'string' || !step.expected.trim()) throw err(`${at}: "expected" is required (string)`, source);
  if (!step.do || typeof step.do !== 'object' || Array.isArray(step.do)) throw err(`${at}: "do" is required (mapping)`, source);

  const present = ACT_KEYS.filter((k) => step.do[k] !== undefined);
  if (present.length === 0) throw err(`${at}: "do" must name one act of [${ACT_KEYS.join(', ')}]`, source);
  if (present.length > 1) throw err(`${at}: "do" names multiple acts [${present.join(', ')}]; use exactly one`, source);
  const act = present[0];
  const v = step.do[act];

  let ov;
  if (act === 'fill') {
    if (typeof v !== 'string' || !v.trim()) throw err(`${at}: fill needs a CSS selector string`, source);
    if (step.do.value === undefined) throw err(`${at}: fill needs a "value"`, source);
    ov = { how: 'native', act: 'fill', args: { selector: v, value: String(step.do.value) } };
  } else if (act === 'tapRole') {
    let role = 'button'; let name;
    if (typeof v === 'string') { name = v; }
    else if (v && typeof v === 'object') { role = v.role || 'button'; name = v.name; }
    if (typeof name !== 'string' || !name.trim()) throw err(`${at}: tapRole needs a "name" (string, or { role, name })`, source);
    ov = { how: 'native', act: 'tapRole', args: { role, name } };
  } else if (act === 'tapText') {
    if (typeof v !== 'string' || !v.trim()) throw err(`${at}: tapText needs a visible-text string`, source);
    ov = { how: 'native', act: 'tapText', args: { text: v } };
  } else if (act === 'goto') {
    if (typeof v !== 'string' || !v.trim()) throw err(`${at}: goto needs a url or /path string`, source);
    ov = { how: 'native', act: 'goto', args: /^https?:\/\//.test(v) ? { url: v } : { path: v } };
  } else if (act === 'wait') {
    const ms = Number(v);
    if (!Number.isFinite(ms) || ms < 0) throw err(`${at}: wait needs a non-negative millisecond number`, source);
    ov = { how: 'native', act: 'wait', args: { ms } };
  } else { // vision
    if (typeof v !== 'string' || !v.trim()) throw err(`${at}: vision needs a description string`, source);
    ov = { how: 'vision', target: v };
  }

  if (step.truth !== undefined) {
    // Same rules as the engine's validator: legacy alias string or object form
    // ({ kind: "network"|"element_enabled", ... }). Re-thrown as SCENARIO_INVALID.
    try { validateTruth(step.truth, '(authoring)', i, at); }
    catch (e) { throw err(e.message, source); }
    ov.truth = step.truth;
  }

  return { scn: { action: step.action, expected: step.expected }, ov };
}

/**
 * Parse + compile a scenario document into the engine's { scenario, overlay } shape.
 * Pure (no I/O). Throws SCENARIO_INVALID with a source-labelled message on any problem.
 *
 * @param {string} text   YAML source
 * @param {string} source label for error messages (e.g. the file path)
 * @returns {{scenario:object, overlay:object, source:string}}
 */
export function parseScenario(text, source = '<scenario>') {
  let doc;
  try { doc = yaml.load(text); } catch (e) { throw err(`YAML parse error — ${e.message}`, source); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw err('document must be a mapping', source);
  if (typeof doc.id !== 'string' || !doc.id.trim()) throw err('"id" is required (kebab string)', source);
  if (doc.baseUrl !== undefined && (typeof doc.baseUrl !== 'string' || !doc.baseUrl.trim())) {
    throw err('"baseUrl" must be a non-empty string when present', source);
  }
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) throw err('"steps" is required (non-empty list)', source);

  const compiled = doc.steps.map((s, i) => compileStep(s, i, source));
  const scenario = { id: doc.id, ...(doc.baseUrl ? { baseUrl: doc.baseUrl } : {}), steps: compiled.map((c) => c.scn) };
  const overlay = { scenario: doc.id, steps: compiled.map((c) => c.ov) };

  // Final gate: the result must pass the same validator the engine applies, and the
  // two arrays must pair 1:1 (guaranteed by construction, asserted defensively).
  try { validateBindings(overlay, doc.id); }
  catch (e) { throw err(`compiled overlay failed validation — ${e.message}`, source); }
  if (scenario.steps.length !== overlay.steps.length) {
    throw err(`internal: scenario ${scenario.steps.length} vs overlay ${overlay.steps.length} step mismatch`, source);
  }

  return { scenario, overlay, source };
}

/**
 * Load a scenario file from disk and compile it. Throws SCENARIO_INVALID (with the
 * path as the source label) on a read or parse/validation failure.
 * @param {string} path
 * @returns {{scenario:object, overlay:object, source:string}}
 */
export function loadScenario(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { throw err(`cannot read scenario file — ${e.message}`, path); }
  return parseScenario(text, path);
}
