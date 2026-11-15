import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { evalTruthSignal } from '../flow-runner.mjs';

const HTML = `<!doctype html><nav><a href="/people">People</a> <a href="/checklist">Checklist</a></nav>
<h1>People</h1><label>Code from the email <input name="code"></label>
<button disabled>Save</button><button>Sign in with Google</button><button>Sign in</button>`;

test('element_enabled finds implicit roles: links, headings, text boxes', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip(`no browser: ${error.message}`); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(HTML);
    const net = { requests: [] };
    const truth = (spec) => evalTruthSignal(page, { kind: 'element_enabled', ...spec }, net);
    assert.equal(await truth({ role: 'link', name: 'People' }), true);
    assert.equal(await truth({ role: 'heading', name: 'People' }), true);
    assert.equal(await truth({ role: 'textbox', name: 'Code from the email' }), true);
    assert.equal(await truth({ name: 'Sign in' }), true, 'role defaults to button');
    assert.equal(await truth({ role: 'button', name: 'Save' }), false, 'a disabled button is not enabled');
    assert.equal(await truth({ role: 'link', name: 'Wishes' }), false, 'a missing element is false');
  } finally {
    await browser.close();
  }
});
