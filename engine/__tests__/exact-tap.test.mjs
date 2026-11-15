import { test } from 'node:test';
import assert from 'node:assert/strict';

import { native } from '../flow-runner.mjs';

// A page with "Sign in with Google" BEFORE the real "Sign in" button.
function loginPage(clicked) {
  const buttons = ['Sign in with Google', 'Sign in'];
  const locator = (matches) => ({
    count: async () => matches.length,
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
