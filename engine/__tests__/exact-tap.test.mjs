import { test } from 'node:test';
import assert from 'node:assert/strict';

import { native } from '../flow-runner.mjs';

// A page with "Sign in with Google" BEFORE the real "Sign in" button.
function loginPage(clicked) {
  const buttons = ['Sign in with Google', 'Sign in'];
  const locator = (matches) => ({
    count: async () => matches.length,
    click: async () => { clicked.push(matches[0]); },
    first: () => ({ click: async () => { clicked.push(matches[0]); } }),
  });
  const find = (name, exact) => buttons.filter((b) => (exact ? b === name : name.test(b)));
  return {
    getByRole: (_role, { name, exact }) => locator(find(name, exact === true)),
    getByText: (name, o = {}) => locator(find(name, o.exact === true)),
  };
}

test('tapRole prefers the exact name over an earlier partial match', async () => {
  const clicked = [];
  await native(loginPage(clicked), { act: 'tapRole', args: { role: 'button', name: 'Sign in' } });
  assert.deepEqual(clicked, ['Sign in']);
});

test('tapText prefers the exact text and still falls back to a partial match', async () => {
  const clicked = [];
  await native(loginPage(clicked), { act: 'tapText', args: { text: 'Sign in' } });
  await native(loginPage(clicked), { act: 'tapText', args: { text: 'Google' } });
  assert.deepEqual(clicked, ['Sign in', 'Sign in with Google']);
});

test('tapRole treats punctuation literally when exact accessible name exists', async () => {
  const clicked = [];
  const buttons = ['Confirm ['];
  const locator = (matches) => ({
    count: async () => matches.length,
    first: () => ({ waitFor: async () => {}, click: async () => { clicked.push(matches[0]); } }),
    click: async () => { clicked.push(matches[0]); },
  });
  const page = {
    getByRole: (_role, { name, exact }) => locator(buttons.filter((b) => exact ? b === name : name.test(b))),
    getByText: (name, o = {}) => locator(buttons.filter((b) => o.exact ? b === name : name.test(b))),
  };
  await native(page, { act: 'tapRole', args: { role: 'button', name: 'Confirm [' } });
  assert.deepEqual(clicked, ['Confirm [']);
});

test('tapRole waits on role locators when the named control has not rendered yet', async () => {
  let appeared = false;
  const clicked = [];
  const locator = (kind) => ({
    count: async () => kind === 'exact' && appeared ? 1 : 0,
    first: () => ({
      waitFor: async () => { appeared = true; },
      click: async () => { clicked.push(kind); },
    }),
    click: async () => { clicked.push(kind); },
    filter() { return this; },
    or(other) { return locator(`union(${kind},${other.kind})`); },
  });
  const page = {
    getByRole: (_role, { name, exact }) => locator(exact ? 'exact' : 'partial'),
    getByText: () => locator('text'),
  };
  await native(page, { act: 'tapRole', args: { role: 'button', name: 'Late access' } });
  assert.deepEqual(clicked, ['exact']);
});
