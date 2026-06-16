/**
 * agent/ — synthesis layer.
 *
 * Compiles intent → a runnable test plan (scenario + overlay) for the engine.
 * Input: a URL + a natural-language goal. The agent explores the page (DOM
 * interactables + screenshot), asks a model for a structured plan, and validates
 * it against the engine's own bindings validator (retry-on-invalid).
 *
 * Output: { scenario, overlay } — exactly the structured input runActualFlow eats.
 * The agent NEVER drives the browser for the test; execution belongs to engine/,
 * and only after gate/ approval.
 */
import { validateBindings } from '../engine/bindings.mjs';
import { askVision } from '../engine/providers.mjs';

const SCHEMA_HINT = `Return ONLY a JSON object, no prose, no code fences:
{
  "scenario": { "id": "<kebab-id>", "steps": [ { "action": "<what a user does>", "expected": "<observable result>" } ] },
  "overlay":  { "scenario": "<same id>", "steps": [ <one entry per scenario step, same order> ] }
}
Each overlay step is either:
  native:  { "how": "native", "act": "fill"|"tapRole"|"tapText"|"goto"|"wait", "args": {...}, "truth"?: "cta_enabled"|"posted" }
           - fill:    args { "selector": "<css>", "value": "<text>" }
           - tapRole: args { "role": "button", "name": "<accessible name>" }
           - tapText: args { "text": "<visible text>" }
           - goto:    args { "url": "<abs>" } or { "path": "/rel" }
           - wait:    args { "ms": <int> }
  vision:  { "how": "vision", "target": "<plain-language description of the element>", "truth"?: ... }
Rules:
- Allowed acts ONLY: "goto", "fill", "tapRole", "tapText", "wait". Never "click", "type", "press".
- Use the key "act" (not "action") inside overlay steps. "action" belongs only in scenario steps.
- Prefer native with a selector taken from the elements list. Use vision ONLY when no stable selector exists.
- Declare truth "cta_enabled" when a primary button becomes enabled after input; "posted" when an action submits/publishes.
- overlay.steps[i] pairs with scenario.steps[i]; same length, same order. Keep it to the FEWEST meaningful steps (typically 2-4), not micro-steps.

EXAMPLE (different page — match this exact shape):
{"scenario":{"id":"login","steps":[{"action":"Enter email and submit","expected":"the form accepts the email"},{"action":"Click Sign in","expected":"the dashboard is shown"}]},
 "overlay":{"scenario":"login","steps":[{"how":"native","act":"fill","args":{"selector":"#email","value":"a@b.com"},"truth":"cta_enabled"},{"how":"native","act":"tapText","args":{"text":"Sign in"},"truth":"posted"}]}}`;

const ELEMENT_SELECTOR = 'a[href],button,input,textarea,select,[role="button"],[role="link"]';

/** Capture interactable elements + a screenshot for the planner. */
export async function capturePageContext(page, { maxElements = 60 } = {}) {
  const elements = await page.$$eval(
    'a[href],button,input,textarea,select,[role="button"],[role="link"]',
    (els, max) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const v = el.value !== undefined ? el.value : '';
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        role: el.getAttribute('role') || undefined,
        id: el.id || undefined,
        testid: el.getAttribute('data-testid') || undefined,
        name: el.getAttribute('name') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        text: ((el.innerText || v || '').trim().slice(0, 40)) || undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        _vis: r.width > 0 && r.height > 0,
      };
    }).filter((e) => e._vis).slice(0, max).map(({ _vis, ...e }) => e),
    maxElements,
  );
  const screenshot = (await page.screenshot()).toString('base64');
  return { elements, screenshot };
}

/** Suggest the most stable selector for an element (mirrors engine native acts). */
function suggestSelector(e) {
  if (e.testid) return `[data-testid=${e.testid}]`;
  if (e.id) return `#${e.id}`;
  if (e.name) return `[name="${e.name}"]`;
  return null;
}

/**
 * Normalize common model slips before validation:
 * - missing `how` → infer from shape (act ⇒ native, target ⇒ vision)
 * - stringified args → parse
 * Models reliably emit the act/target but often omit the `how` discriminator.
 */
const ACT_ALIAS = { type: 'fill', input: 'fill', enter: 'fill', click: 'tapText', press: 'tapText', tap: 'tapText', navigate: 'goto', open: 'goto' };

function normalizeOverlay(overlay) {
  if (!overlay || !Array.isArray(overlay.steps)) return overlay;
  for (const st of overlay.steps) {
    if (!st || typeof st !== 'object') continue;
    // Models sometimes put the act under "action" (scenario's key) — recover it.
    if (!st.act && typeof st.action === 'string' && !st.target) st.act = st.action;
    // Map common act synonyms to our enum.
    if (st.act && ACT_ALIAS[st.act]) st.act = ACT_ALIAS[st.act];
    // Infer the missing discriminator.
    if (!st.how) st.how = st.act ? 'native' : (st.target ? 'vision' : st.how);
    if (typeof st.args === 'string') {
      try { st.args = JSON.parse(st.args); } catch { /* leave for validator */ }
    }
  }
  return overlay;
}

function parsePlan(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // strip code fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // grab the outermost JSON object
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (!obj || !obj.scenario || !obj.overlay) return null;
    if (!obj.scenario.id) return null;
    // normalize: overlay.scenario must equal scenario.id
    obj.overlay.scenario = obj.scenario.id;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Synthesize a test plan from a goal + URL.
 *
 * @param {object} args
 *   url        — target URL (required if no page given)
 *   goal       — natural-language objective (required)
 *   page       — optional pre-built Playwright Page (caller owns teardown)
 *   headless   — when owning the browser
 *   providerCfg — vision/text provider config ({ provider, model, endpoint, apiKey })
 *   withScreenshot — include a screenshot in the prompt (default true)
 *   retries    — invalid-plan repair attempts (default 1)
 * @returns {Promise<{scenario:object, overlay:object, raw:string, context:object}>}
 */
export async function synthesize({
  url, goal, page, headless = true, providerCfg = {}, withScreenshot = true, retries = 1,
}) {
  if (!goal) throw new Error('synthesize: goal is required');

  let browser;
  let workPage = page;
  if (!workPage) {
    if (!url) throw new Error('synthesize: url is required when no page is given');
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless });
    workPage = await (await browser.newContext()).newPage();
    await workPage.goto(url, { waitUntil: 'domcontentloaded' });
    await workPage.waitForLoadState('networkidle').catch(() => {});
  }

  try {
    const ctx = await capturePageContext(workPage);
    const elementsForPrompt = ctx.elements.map((e) => ({ ...e, suggestedSelector: suggestSelector(e) || undefined }));
    const basePrompt =
      `You are a web UI test planner. Plan how a user would accomplish this goal, ` +
      `then express it as a structured test plan.\n\n` +
      `GOAL: ${goal}\nURL: ${url || '(current page)'}\n\n` +
      `Interactable elements on the page (JSON):\n${JSON.stringify(elementsForPrompt)}\n\n` +
      `${SCHEMA_HINT}`;

    const cfg = { provider: 'mlx', maxTokens: 900, ...providerCfg };
    let lastErr = null;
    let lastRaw = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const prompt = attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous attempt was invalid: ${lastErr}\nReturn corrected JSON only.`;
      const raw = await askVision(withScreenshot ? ctx.screenshot : null, prompt, cfg);
      lastRaw = String(raw);
      const plan = parsePlan(raw);
      if (!plan) { lastErr = 'output was not a valid plan JSON object'; continue; }
      normalizeOverlay(plan.overlay);
      try {
        validateBindings(plan.overlay, plan.scenario.id);
        // The engine drives by scenario.steps and pairs overlay.steps by index —
        // a length mismatch silently drops the tail (e.g. the publish click).
        const ns = plan.scenario.steps?.length ?? 0;
        const no = plan.overlay.steps?.length ?? 0;
        if (ns !== no) {
          lastErr = `scenario has ${ns} step(s) but overlay has ${no}; they must pair 1:1`;
          continue;
        }
        return { scenario: { url, ...plan.scenario }, overlay: plan.overlay, raw, context: ctx };
      } catch (e) {
        lastErr = e.message;
      }
    }
    const err = new Error(`synthesis failed after ${retries + 1} attempt(s): ${lastErr}`);
    err.lastRaw = lastRaw.slice(0, 1200);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
