import test from 'node:test';
import assert from 'node:assert/strict';

import { planToAuthoredYaml } from '../synthesize.mjs';
import { parseScenario } from '../../engine/scenario.mjs';

// A representative synthesized plan exercising every act + both truth forms.
const scenario = {
  id: 'compose-post',
  steps: [
    { action: 'Open the compose page', expected: 'the compose form is shown' },
    { action: 'Fill the caption', expected: 'Post Now enables' },
    { action: 'Pick the audience', expected: 'the audience menu closes' },
    { action: 'Click Post Now', expected: 'the post is submitted' },
    { action: 'Wait for the toast', expected: 'a confirmation toast appears' },
  ],
};
const overlay = {
  scenario: 'compose-post',
  steps: [
    { how: 'native', act: 'goto', args: { path: '/compose' } },
    { how: 'native', act: 'fill', args: { selector: '#caption', value: 'hello' }, truth: { kind: 'element_enabled', name: 'Post Now' } },
    { how: 'native', act: 'tapRole', args: { role: 'menuitem', name: 'Everyone' } },
    { how: 'vision', target: 'the primary Post Now button', truth: { kind: 'network', match: '/api/posts', method: 'POST' } },
    { how: 'native', act: 'wait', args: { ms: 500 } },
  ],
};

test('planToAuthoredYaml: round-trips through parseScenario', () => {
  const text = planToAuthoredYaml(scenario, overlay, { baseUrl: 'http://localhost:3100' });
  const loaded = parseScenario(text, '<round-trip>');

  assert.equal(loaded.scenario.id, 'compose-post');
  assert.equal(loaded.scenario.baseUrl, 'http://localhost:3100');
  assert.equal(loaded.scenario.steps.length, scenario.steps.length);
  assert.deepEqual(loaded.scenario.steps.map((s) => s.action), scenario.steps.map((s) => s.action));

  // Overlay semantics must survive the round trip.
  assert.deepEqual(loaded.overlay.steps[0], { how: 'native', act: 'goto', args: { path: '/compose' } });
  assert.equal(loaded.overlay.steps[1].args.selector, '#caption');
  assert.deepEqual(loaded.overlay.steps[1].truth, { kind: 'element_enabled', name: 'Post Now' });
  assert.deepEqual(loaded.overlay.steps[2].args, { role: 'menuitem', name: 'Everyone' });
  assert.equal(loaded.overlay.steps[3].how, 'vision');
  assert.equal(loaded.overlay.steps[3].target, 'the primary Post Now button');
  assert.deepEqual(loaded.overlay.steps[3].truth, { kind: 'network', match: '/api/posts', method: 'POST' });
  assert.deepEqual(loaded.overlay.steps[4].args, { ms: 500 });
});

test('planToAuthoredYaml: tapRole with default button role collapses to string sugar', () => {
  const text = planToAuthoredYaml(
    { id: 'x', steps: [{ action: 'a', expected: 'b' }] },
    { scenario: 'x', steps: [{ how: 'native', act: 'tapRole', args: { role: 'button', name: 'Save' } }] },
  );
  assert.match(text, /tapRole: Save/);
  const loaded = parseScenario(text, '<t>');
  assert.deepEqual(loaded.overlay.steps[0].args, { role: 'button', name: 'Save' });
});

test('planToAuthoredYaml: legacy string truth passes through', () => {
  const text = planToAuthoredYaml(
    { id: 'x', steps: [{ action: 'a', expected: 'b' }] },
    { scenario: 'x', steps: [{ how: 'native', act: 'tapText', args: { text: 'Go' }, truth: 'posted' }] },
  );
  const loaded = parseScenario(text, '<t>');
  assert.equal(loaded.overlay.steps[0].truth, 'posted');
});

test('planToAuthoredYaml: unknown act throws instead of writing a broken file', () => {
  assert.throws(() => planToAuthoredYaml(
    { id: 'x', steps: [{ action: 'a', expected: 'b' }] },
    { scenario: 'x', steps: [{ how: 'native', act: 'hover', args: {} }] },
  ), /cannot reverse-compile/);
});
