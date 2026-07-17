/**
 * cli/report.mjs — render an engine RunReport for a human in the terminal.
 *
 * Pure: takes the report object returned by runActualFlow/runFlow and returns a
 * string. No I/O, no color codes (kept plain so it's readable in any terminal and
 * easy to snapshot-test).
 */

const GLYPH = { true: '✓', false: '✗' };

/** One-line basis/detail tag for a step. */
function detail(s) {
  const bits = [];
  if (s.passBasis === 'truth') bits.push(`truth:${s.truth === undefined ? '?' : s.truth ? 'pass' : 'fail'}`);
  else if (s.passBasis) bits.push(s.passBasis);
  if (s.how === 'vision') bits.push(`vision→${s.topmost || (s.visionFound ? 'found' : 'not-found')}`);
  if (s.actError) bits.push(`actErr: ${s.actError}`);
  if (!s.pass && s.why) bits.push(`why: ${s.why}`);
  return bits.length ? `  [${bits.join('  ')}]` : '';
}

/**
 * @param {object} report  RunReport ({ scenario, model, flowPassed, stepsPassed, posted, steps })
 * @param {{source?:string}} [opts]
 * @returns {string}
 */
export function renderReport(report, opts = {}) {
  const lines = [];
  const title = `SimMan — scenario "${report.scenario}"${report.model ? `   (${report.model})` : ''}`;
  lines.push(title);
  if (opts.source) lines.push(`  source: ${opts.source}`);

  for (const s of report.steps || []) {
    if (s.fatal) { lines.push(`  ‼ fatal: ${s.fatal}`); continue; }
    const action = String(s.action || '').slice(0, 64);
    lines.push(`  ${GLYPH[!!s.pass]} ${s.i + 1}. ${action}${detail(s)}`);
  }

  lines.push(`  ${'─'.repeat(48)}`);
  // Summarize truth-signal outcomes only when the scenario declared any —
  // an app-agnostic report line (the old `posted=` leaked one app's signal).
  const truthSteps = (report.steps || []).filter((s) => !s.fatal && s.truth !== undefined);
  const truthNote = truthSteps.length
    ? `   truth ${truthSteps.filter((s) => s.truth).length}/${truthSteps.length}`
    : '';
  lines.push(`  ${report.flowPassed ? 'PASS' : 'FAIL'}  ${report.stepsPassed} steps${truthNote}`);
  return lines.join('\n');
}
