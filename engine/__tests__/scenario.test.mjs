import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScenario, loadScenario } from '../scenario.mjs';

const PLANS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plans');

const SIMPLE = `
id: publish-simple
baseUrl: http://localhost:4173
steps:
  - action: Write a caption
    expected: Post Now enables
    do: { fill: "#caption", value: "hi" }
    truth: cta_enabled
  - action: Publish
    expected: published
    do: { tapRole: "Post Now" }
    truth: posted
`;

test('parses a valid scenario into engine scenario+overlay', () => {
  const { scenario, overlay } = parseScenario(SIMPLE, 'inline');
  assert.equal(scenario.id, 'publish-simple');
  assert.equal(scenario.baseUrl, 'http://localhost:4173');
  assert.equal(scenario.steps.length, 2);
  assert.equal(overlay.scenario, 'publish-simple');
  assert.equal(overlay.steps.length, 2);
  assert.deepEqual(scenario.steps[0], { action: 'Write a caption', expected: 'Post Now enables' });
  assert.deepEqual(overlay.steps[0], { how: 'native', act: 'fill', args: { selector: '#caption', value: 'hi' }, truth: 'cta_enabled' });
  assert.deepEqual(overlay.steps[1], { how: 'native', act: 'tapRole', args: { role: 'button', name: 'Post Now' }, truth: 'posted' });
});

test('compiles every act sugar', () => {
  const doc = `
id: acts
steps:
  - { action: a, expected: a, do: { fill: "#x", value: "v" } }
  - { action: b, expected: b, do: { tapRole: "Go" } }
  - { action: c, expected: c, do: { tapRole: { role: link, name: Home } } }
  - { action: d, expected: d, do: { tapText: "Sign in" } }
  - { action: e, expected: e, do: { goto: "https://x.test/page" } }
  - { action: f, expected: f, do: { goto: "/rel" } }
  - { action: g, expected: g, do: { wait: 250 } }
  - { action: h, expected: h, do: { vision: "the blue button" } }
`;
  const { overlay } = parseScenario(doc, 'acts');
  const s = overlay.steps;
  assert.deepEqual(s[0], { how: 'native', act: 'fill', args: { selector: '#x', value: 'v' } });
  assert.deepEqual(s[1], { how: 'native', act: 'tapRole', args: { role: 'button', name: 'Go' } });
  assert.deepEqual(s[2], { how: 'native', act: 'tapRole', args: { role: 'link', name: 'Home' } });
  assert.deepEqual(s[3], { how: 'native', act: 'tapText', args: { text: 'Sign in' } });
  assert.deepEqual(s[4], { how: 'native', act: 'goto', args: { url: 'https://x.test/page' } });
  assert.deepEqual(s[5], { how: 'native', act: 'goto', args: { path: '/rel' } });
  assert.deepEqual(s[6], { how: 'native', act: 'wait', args: { ms: 250 } });
  assert.deepEqual(s[7], { how: 'vision', target: 'the blue button' });
});

test('baseUrl is optional', () => {
  const { scenario } = parseScenario(`
id: no-base
steps:
  - { action: a, expected: a, do: { wait: 1 } }
`, 'x');
  assert.equal('baseUrl' in scenario, false);
});

const cases = [
  ['non-mapping document', 'id: x\n- a\n- b', /must be a mapping|YAML/],
  ['missing id', 'steps:\n  - { action: a, expected: a, do: { wait: 1 } }', /"id" is required/],
  ['empty steps', 'id: x\nsteps: []', /"steps" is required/],
  ['missing action', 'id: x\nsteps:\n  - { expected: a, do: { wait: 1 } }', /"action" is required/],
  ['missing expected', 'id: x\nsteps:\n  - { action: a, do: { wait: 1 } }', /"expected" is required/],
  ['missing do', 'id: x\nsteps:\n  - { action: a, expected: a }', /"do" is required/],
  ['empty do', 'id: x\nsteps:\n  - { action: a, expected: a, do: {} }', /must name one act/],
  ['two acts in do', 'id: x\nsteps:\n  - { action: a, expected: a, do: { wait: 1, fill: "#x", value: v } }', /multiple acts/],
  ['fill without value', 'id: x\nsteps:\n  - { action: a, expected: a, do: { fill: "#x" } }', /fill needs a "value"/],
  ['tapRole without name', 'id: x\nsteps:\n  - { action: a, expected: a, do: { tapRole: { role: button } } }', /tapRole needs a "name"/],
  ['unknown truth signal', 'id: x\nsteps:\n  - { action: a, expected: a, do: { wait: 1 }, truth: bogus }', /unknown truth signal/],
  ['bad wait', 'id: x\nsteps:\n  - { action: a, expected: a, do: { wait: "soon" } }', /wait needs a non-negative/],
];
for (const [name, doc, re] of cases) {
  test(`rejects: ${name}`, () => {
    assert.throws(() => parseScenario(doc, 'src'), (e) => e.code === 'SCENARIO_INVALID' && re.test(e.message));
  });
}

test('error messages carry the source label and step index', () => {
  assert.throws(
    () => parseScenario('id: x\nsteps:\n  - { action: a, expected: a, do: { fill: "#x" } }', 'plans/foo.yaml'),
    (e) => /plans\/foo\.yaml/.test(e.message) && /step 0/.test(e.message),
  );
});

test('loadScenario reads the shipped example fixtures', () => {
  for (const f of ['publish-simple.yaml', 'publish-dense.yaml']) {
    const { scenario, overlay } = loadScenario(join(PLANS, f));
    assert.ok(scenario.steps.length >= 2);
    assert.equal(scenario.steps.length, overlay.steps.length);
    assert.equal(overlay.scenario, scenario.id);
  }
});

test('loadScenario throws SCENARIO_INVALID on a missing file', () => {
  assert.throws(() => loadScenario('/no/such/scenario.yaml'), (e) => e.code === 'SCENARIO_INVALID' && /cannot read/.test(e.message));
});
