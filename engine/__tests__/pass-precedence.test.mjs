import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePass } from '../flow-runner.mjs';

test('truth-signal is authoritative when declared (pass)', () => {
  const v = decidePass({ truth: { pass: true }, acted: false, verify: { pass: false } }, { how: 'native' });
  assert.deepEqual(v, { pass: true, basis: 'truth' });
});

test('truth-signal is authoritative when declared (fail)', () => {
  // Even if the act succeeded and vision liked it, a false truth-signal fails the step.
  const v = decidePass({ truth: { pass: false }, acted: true, verify: { pass: true } }, { how: 'native' });
  assert.deepEqual(v, { pass: false, basis: 'truth' });
});

test('native step with no truth-signal passes on act success — vision verify ignored', () => {
  // The spike-4 case: a successful native fill that the noisy VL judge false-failed.
  const v = decidePass({ acted: true, verify: { pass: false } }, { how: 'native' });
  assert.deepEqual(v, { pass: true, basis: 'native-act' });
});

test('native step with no truth-signal fails when the act threw', () => {
  const v = decidePass({ acted: false, verify: { pass: true } }, { how: 'native' });
  assert.deepEqual(v, { pass: false, basis: 'native-act' });
});

test('undefined how is treated as native (act is the signal)', () => {
  const v = decidePass({ acted: true, verify: { pass: false } }, {});
  assert.deepEqual(v, { pass: true, basis: 'native-act' });
});

test('vision step with no truth-signal falls back to vision verify (pass)', () => {
  const v = decidePass({ acted: true, verify: { pass: true } }, { how: 'vision' });
  assert.deepEqual(v, { pass: true, basis: 'vision-verify' });
});

test('vision step with no truth-signal fails when vision verify fails', () => {
  const v = decidePass({ acted: true, verify: { pass: false } }, { how: 'vision' });
  assert.deepEqual(v, { pass: false, basis: 'vision-verify' });
});

test('vision step still honors a declared truth-signal over vision verify', () => {
  const v = decidePass({ truth: { pass: true }, verify: { pass: false } }, { how: 'vision' });
  assert.deepEqual(v, { pass: true, basis: 'truth' });
});
