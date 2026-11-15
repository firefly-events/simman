import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lateValue, native } from '../flow-runner.mjs';

function fakePage(sink) {
  return {
    locator: (selector) => ({ first: () => ({ fill: async (v) => { sink.push({ selector, fill: v }); } }) }),
  };
}

test('a plain fill value is typed as given', async () => {
  assert.equal(await lateValue('123456'), '123456');
  assert.equal(await lateValue('{{waitFile:relative/path}}'), '{{waitFile:relative/path}}');
});

test('fill waits for a waitFile value written while the run is under way', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simman-wait-'));
  const file = join(dir, 'code');
  const sink = [];
  setTimeout(() => { writeFile(file, ''); }, 30);
  setTimeout(() => { writeFile(file, ' 654321\n'); }, 120);
  await native(fakePage(sink), { act: 'fill', args: { selector: '#code', value: `{{waitFile:${file}}}` } }, { waitFilePollMs: 10 });
  assert.deepEqual(sink, [{ selector: '#code', fill: '654321' }]);
});

test('a waitFile value that never arrives fails the step at its deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simman-wait-'));
  await assert.rejects(
    () => lateValue(`{{waitFile:${join(dir, 'never')}}}`, { waitFileTimeoutMs: 60, waitFilePollMs: 10 }),
    /no value arrived before the deadline/,
  );
});
