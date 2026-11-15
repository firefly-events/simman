import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTruth, validateBindings } from '../bindings.mjs';
import { evalTruthSignal, matchesNetworkTruth, LEGACY_TRUTH_ALIASES } from '../flow-runner.mjs';
import { parseScenario } from '../scenario.mjs';

// ── validateTruth ─────────────────────────────────────────────────────────────

test('truth: legacy string aliases accepted', () => {
  validateTruth('posted', 's', 0);
  validateTruth('cta_enabled', 's', 0);
});

test('truth: unknown string alias rejected', () => {
  assert.throws(() => validateTruth('submitted', 's', 0), /unknown truth signal/);
});

test('truth: network object form accepted', () => {
  validateTruth({ kind: 'network', match: '/api/orders' }, 's', 0);
  validateTruth({ kind: 'network', match: '/api/orders', method: 'POST' }, 's', 0);
});

test('truth: network requires match', () => {
  assert.throws(() => validateTruth({ kind: 'network' }, 's', 0), /requires "match"/);
  assert.throws(() => validateTruth({ kind: 'network', match: '  ' }, 's', 0), /requires "match"/);
});

test('truth: element_enabled requires selector or name', () => {
  validateTruth({ kind: 'element_enabled', name: 'Post Now' }, 's', 0);
  validateTruth({ kind: 'element_enabled', selector: '#submit' }, 's', 0);
  validateTruth({ kind: 'element_enabled', role: 'button', name: 'Save' }, 's', 0);
  assert.throws(() => validateTruth({ kind: 'element_enabled' }, 's', 0), /requires "selector".*or "name"/);
  assert.throws(() => validateTruth({ kind: 'element_enabled', role: 'button' }, 's', 0), /requires "selector".*or "name"/);
});

test('truth: unknown kind rejected', () => {
  assert.throws(() => validateTruth({ kind: 'cookie', match: 'x' }, 's', 0), /"kind" must be one of/);
  assert.throws(() => validateTruth(42, 's', 0), /must be a known alias string or an object/);
  assert.throws(() => validateTruth([], 's', 0), /must be a known alias string or an object/);
});

test('truth: object form validates inside a full overlay', () => {
  validateBindings({
    scenario: 'x',
    steps: [
      { how: 'native', act: 'fill', args: { selector: '#a', value: 'v' }, truth: { kind: 'element_enabled', name: 'Save' } },
      { how: 'vision', target: 'the save button', truth: { kind: 'network', match: '/api/save', method: 'POST' } },
    ],
  }, 'x');
});

test('element_enabled does not let an enabled partial match override a disabled exact role match', async () => {
  const makeLocator = (kind) => ({
    count: async () => kind === 'exact' ? 1 : 2,
    first: () => ({ waitFor: async () => {} }),
    evaluateAll: async () => kind !== 'exact',
  });
  const page = {
    getByRole: (_role, options = {}) => makeLocator(options.exact ? 'exact' : 'partial'),
  };
  assert.equal(await evalTruthSignal(page, { kind: 'element_enabled', role: 'button', name: 'Save' }, { requests: [] }), false);
});

// ── matchesNetworkTruth (pure request matcher) ────────────────────────────────

test('network matcher: substring + method', () => {
  const spec = { kind: 'network', match: '/api/orders', method: 'POST' };
  assert.equal(matchesNetworkTruth(spec, { url: 'https://x.dev/api/orders?id=1', method: 'POST' }), true);
  assert.equal(matchesNetworkTruth(spec, { url: 'https://x.dev/api/orders', method: 'GET' }), false);
  assert.equal(matchesNetworkTruth(spec, { url: 'https://x.dev/api/users', method: 'POST' }), false);
});

test('network matcher: method omitted matches any method', () => {
  const spec = { kind: 'network', match: '/api/orders' };
  assert.equal(matchesNetworkTruth(spec, { url: 'https://x.dev/api/orders', method: 'GET' }), true);
  assert.equal(matchesNetworkTruth(spec, { url: 'https://x.dev/api/orders', method: 'DELETE' }), true);
});

test('network matcher: method compare is case-insensitive', () => {
  const spec = { kind: 'network', match: '/api', method: 'post' };
  assert.equal(matchesNetworkTruth(spec, { url: 'https://x.dev/api', method: 'POST' }), true);
});

test('legacy aliases resolve to object specs', () => {
  assert.equal(LEGACY_TRUTH_ALIASES.posted.kind, 'network');
  assert.equal(LEGACY_TRUTH_ALIASES.cta_enabled.kind, 'element_enabled');
});

// ── authored scenario YAML with object truth ──────────────────────────────────

test('scenario: object truth compiles into the overlay', () => {
  const { overlay } = parseScenario(`
id: order-flow
steps:
  - action: Fill the email
    expected: Submit enables
    do: { fill: "#email", value: "a@b.com" }
    truth:
      kind: element_enabled
      name: Submit
  - action: Click Submit
    expected: the order is placed
    do: { tapText: "Submit" }
    truth:
      kind: network
      match: /api/orders
      method: POST
`, '<test>');
  assert.deepEqual(overlay.steps[0].truth, { kind: 'element_enabled', name: 'Submit' });
  assert.deepEqual(overlay.steps[1].truth, { kind: 'network', match: '/api/orders', method: 'POST' });
});

test('scenario: bad object truth fails compile with location', () => {
  assert.throws(() => parseScenario(`
id: x
steps:
  - action: a
    expected: b
    do: { tapText: "Go" }
    truth: { kind: network }
`, '<test>'), /SCENARIO|requires "match"/);
});
