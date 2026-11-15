import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { evalTruthSignal } from '../flow-runner.mjs';

const HTML = `<!doctype html><nav><a href="/people">People</a> <a href="/checklist">Checklist</a></nav>
<h1>People</h1><label>Code from the email <input name="code"></label>
<button>Save draft</button><button disabled>Save</button><button>Sign in with Google</button><button>Sign in</button>
<button style="display:none">Ready</button><button>Ready</button><div aria-disabled="true"><button>Parent disabled</button></div>`;

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
    assert.equal(await truth({ role: 'button', name: 'Ready' }), true, 'a hidden duplicate does not mask a visible enabled match');
    assert.equal(await truth({ role: 'button', name: 'Parent disabled' }), false, 'an aria-disabled ancestor disables the role');
    assert.equal(await truth({ role: 'link', name: 'Wishes' }), false, 'a missing element is false');
  } finally {
    await browser.close();
  }
});
