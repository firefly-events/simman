import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { native } from '../flow-runner.mjs';

const HTML = `<!doctype html>
<table style="display:none"><tr><td><a href="#desk" onclick="window.hit='desktop'">Ava Miller</a></td></tr></table>
<ul><li><a href="#phone" onclick="window.hit='phone'">Ava Miller</a></li></ul>
<label>Month <select id="m"><option value="">Month</option><option value="3">March</option><option value="4">April</option></select></label>
<input id="name">`;

test('taps reach the visible copy and fill chooses a select option', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip(`no browser: ${error.message}`); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(HTML);
    await native(page, { act: 'tapText', args: { text: 'Ava Miller' } });
    assert.equal(await page.evaluate(() => window.hit), 'phone');
    await native(page, { act: 'tapRole', args: { role: 'link', name: 'Ava Miller' } });
    assert.equal(await page.evaluate(() => window.hit), 'phone');
    await native(page, { act: 'fill', args: { selector: '#m', value: 'March' } });
    assert.equal(await page.$eval('#m', (el) => el.value), '3');
    await native(page, { act: 'fill', args: { selector: '#m', value: '4' } });
    assert.equal(await page.$eval('#m', (el) => el.value), '4');
    await native(page, { act: 'fill', args: { selector: '#name', value: 'Leo' } });
    assert.equal(await page.$eval('#name', (el) => el.value), 'Leo');
  } finally {
    await browser.close();
  }
});

test('tapRole falls back to the exact text when no element has that role', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip(`no browser: ${error.message}`); return; }
  try {
    const page = await browser.newPage();
    await page.setContent('<details><summary>Rename</summary><input name="name"></details>');
    await native(page, { act: 'tapRole', args: { role: 'button', name: 'Rename' } });
    assert.equal(await page.$eval('details', (el) => el.open), true);
  } finally {
    await browser.close();
  }
});
