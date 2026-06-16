/**
 * gate/ — approval gate (seed).
 *
 * Renders a synthesized test plan human-readable and blocks execution until
 * approved. Nothing the agent infers reaches a real cursor without passing here.
 *
 * This is the spike seed of the gate layer — intentionally tiny, but the real
 * boundary: renderPlan() for display, approveOrThrow() for the hard stop.
 */

/**
 * Render a scenario + overlay as a human-readable plan for approval.
 * @param {{id:string, baseUrl?:string, steps:Array<{action:string,expected:string}>}} scenario
 * @param {{steps:Array<object>}} overlay
 * @returns {string}
 */
export function renderPlan(scenario, overlay) {
  const lines = [];
  lines.push(`SimMan test plan — scenario "${scenario.id}"`);
  if (scenario.baseUrl) lines.push(`target: ${scenario.baseUrl}`);
  lines.push(`${scenario.steps.length} step(s):`);
  scenario.steps.forEach((s, i) => {
    const b = overlay.steps?.[i] || {};
    let act;
    if (b.how === 'vision') {
      act = `VISION-CLICK → "${b.target}"`;
    } else if (b.act === 'fill') {
      act = `FILL ${b.args?.selector} = ${JSON.stringify(b.args?.value ?? b.args?.text)}`;
    } else {
      act = `${(b.act || '?').toUpperCase()} ${JSON.stringify(b.args || {})}`;
    }
    const truth = b.truth ? `   [truth: ${b.truth}]` : '';
    lines.push(`  ${i + 1}. ${s.action}`);
    lines.push(`       do:     ${act}${truth}`);
    lines.push(`       verify: ${s.expected}`);
  });
  return lines.join('\n');
}

/**
 * Hard stop: throws unless the plan is approved.
 * @param {{scenario:object, overlay:object, approved:boolean, approver?:string}} args
 * @returns {{approved:true, approver:string, steps:number}}
 */
export function approveOrThrow({ scenario, overlay, approved, approver = 'human' }) {
  if (!approved) {
    const e = new Error('SimMan gate: test plan NOT approved — execution blocked');
    e.code = 'GATE_REJECTED';
    throw e;
  }
  return { approved: true, approver, steps: scenario.steps.length };
}
