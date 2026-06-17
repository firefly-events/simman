import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, gateReview } from '../edit.mjs';

// A valid 2-step base plan (fill caption → publish).
function basePlan() {
  return {
    scenario: {
      id: 'publish',
      steps: [
        { action: 'Enter a caption', expected: 'Post Now enables' },
        { action: 'Click Post Now', expected: 'post is published' },
      ],
    },
    overlay: {
      scenario: 'publish',
      steps: [
        { how: 'native', act: 'fill', args: { selector: '#caption', value: 'hi' }, truth: 'cta_enabled' },
        { how: 'native', act: 'tapRole', args: { role: 'button', name: 'Post Now' }, truth: 'posted' },
      ],
    },
  };
}

// The spike-3 gemma failure shape: a single run-on step that taps the "Schedule" decoy.
function wrongPlan() {
  return {
    scenario: { id: 'publish', steps: [{ action: 'Fill fields and click Schedule to publish', expected: 'published' }] },
    overlay: {
      scenario: 'publish',
      steps: [{ how: 'native', act: 'tapRole', args: { role: 'button', name: 'Schedule' }, truth: 'posted' }],
    },
  };
}

test('applyEdits replace: fix the wrong button name', () => {
  const out = applyEdits(basePlan(), [
    { op: 'replace', i: 1, overlay: { args: { role: 'button', name: 'Publish' } } },
  ]);
  assert.equal(out.overlay.steps[1].args.name, 'Publish');
  assert.equal(out.overlay.steps[1].truth, 'posted'); // unspecified fields preserved
});

test('applyEdits insert: add a missing paired step', () => {
  const out = applyEdits(basePlan(), [
    {
      op: 'insert', i: 0,
      scenario: { action: 'Enter a title', expected: 'title accepted' },
      overlay: { how: 'native', act: 'fill', args: { selector: '#title', value: 'T' } },
    },
  ]);
  assert.equal(out.scenario.steps.length, 3);
  assert.equal(out.overlay.steps.length, 3);
  assert.equal(out.overlay.steps[0].args.selector, '#title');
});

test('applyEdits insert appends when i === length', () => {
  const p = basePlan();
  const out = applyEdits(p, [
    {
      op: 'insert', i: 2,
      scenario: { action: 'Wait', expected: 'settled' },
      overlay: { how: 'native', act: 'wait', args: { ms: 100 } },
    },
  ]);
  assert.equal(out.overlay.steps.length, 3);
  assert.equal(out.overlay.steps[2].act, 'wait');
});

test('applyEdits remove drops the paired step', () => {
  const out = applyEdits(basePlan(), [{ op: 'remove', i: 0 }]);
  assert.equal(out.scenario.steps.length, 1);
  assert.equal(out.overlay.steps[0].act, 'tapRole');
});

test('applyEdits reorder permutes both arrays together', () => {
  const out = applyEdits(basePlan(), [{ op: 'reorder', order: [1, 0] }]);
  assert.equal(out.overlay.steps[0].act, 'tapRole');
  assert.equal(out.scenario.steps[0].action, 'Click Post Now');
});

test('applyEdits infers missing how on an operator step', () => {
  const out = applyEdits(basePlan(), [
    { op: 'replace', i: 1, overlay: { how: undefined, act: 'tapText', args: { text: 'Post Now' }, truth: 'posted' } },
  ]);
  assert.equal(out.overlay.steps[1].how, 'native');
});

test('applyEdits is pure — original plan untouched', () => {
  const p = basePlan();
  const snapshot = JSON.stringify(p);
  applyEdits(p, [{ op: 'remove', i: 0 }, { op: 'replace', i: 0, overlay: { args: { role: 'button', name: 'X' } } }]);
  assert.equal(JSON.stringify(p), snapshot);
});

test('applyEdits rejects an edit that produces an invalid overlay', () => {
  assert.throws(
    () => applyEdits(basePlan(), [{ op: 'replace', i: 0, overlay: { how: 'native', act: 'bogus-act', args: {} } }]),
    (e) => e.code === 'GATE_EDIT_INVALID',
  );
});

test('applyEdits rejects an out-of-range index', () => {
  assert.throws(() => applyEdits(basePlan(), [{ op: 'replace', i: 9, overlay: {} }]),
    (e) => e.code === 'GATE_EDIT_INVALID');
});

test('applyEdits rejects a non-permutation reorder', () => {
  assert.throws(() => applyEdits(basePlan(), [{ op: 'reorder', order: [0, 0] }]),
    (e) => e.code === 'GATE_EDIT_INVALID');
});

test('gateReview approves immediately', async () => {
  const r = await gateReview({ ...basePlan(), decide: () => ({ action: 'approve' }) });
  assert.equal(r.approved, true);
  assert.equal(r.edited, false);
  assert.equal(r.rounds, 1);
});

test('gateReview reject throws GATE_REJECTED', async () => {
  await assert.rejects(
    gateReview({ ...basePlan(), decide: () => ({ action: 'reject' }) }),
    (e) => e.code === 'GATE_REJECTED',
  );
});

test('gateReview: edit a bad plan into a good one, then approve', async () => {
  // Reproduce the gemma miss, then have the operator rebuild it correctly and approve.
  let step = 0;
  const decide = () => {
    step += 1;
    if (step === 1) {
      // Replace the single "Schedule" step with a proper caption-fill, then append the publish.
      return {
        action: 'edit',
        edits: [
          {
            op: 'replace', i: 0,
            scenario: { action: 'Enter a caption', expected: 'Post Now enables' },
            overlay: { how: 'native', act: 'fill', args: { selector: '#caption', value: 'hi' }, truth: 'cta_enabled' },
          },
          {
            op: 'insert', i: 1,
            scenario: { action: 'Click Post Now', expected: 'published' },
            overlay: { how: 'native', act: 'tapRole', args: { role: 'button', name: 'Post Now' }, truth: 'posted' },
          },
        ],
      };
    }
    return { action: 'approve' };
  };
  const r = await gateReview({ ...wrongPlan(), decide });
  assert.equal(r.approved, true);
  assert.equal(r.edited, true);
  assert.equal(r.rounds, 2);
  assert.equal(r.overlay.steps.length, 2);
  assert.equal(r.overlay.steps[1].args.name, 'Post Now'); // decoy fixed
});

test('gateReview maxRounds guards an endless-edit decider', async () => {
  await assert.rejects(
    gateReview({
      ...basePlan(), maxRounds: 3,
      decide: () => ({ action: 'edit', edits: [] }), // never approves
    }),
    (e) => e.code === 'GATE_EDIT_LOOP',
  );
});
