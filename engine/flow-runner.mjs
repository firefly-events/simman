/**
 * Vision-cursor PARENT executor — ported from spike Arm D commit 7b0ff06.
 *
 * Story: am-4-flow-runner-bridge (actual-manual-tier)
 *
 * Division of labor:
 *   - Native primitives (fill / tapRole / tapText / goto / wait) → Playwright
 *   - Selectorless clicks (how: "vision") → vision grounds pixels + real pointer
 *   - Per-step VERIFY → vision judge (hybrid: truth-signal authoritative when declared)
 *
 * Locked design decisions (do not re-litigate):
 *   1. LOCATE decoupled from "visible" — grounding asks coords-only; 0,0 = absent.
 *   2. Two-pass grounding: fullPage glance → scroll target to center → viewport re-ground → click.
 *      Retry ≤3. DOM-snap OFF by default (SNAP_R=0).
 *   3. Hybrid V&V: truth-signal (cta_enabled=DOM, posted=network) authoritative; vision recorded
 *      alongside; divergence flagged. Vision unreliable for ephemeral toasts / enabled-state.
 *
 * Exports (library surface):
 *   locate(page, label, fullPage, opts) → { found, ix, iy, W, H, raw }
 *   verify(page, expected, opts)        → { pass, why }
 *   settle(page)                        → Promise<void>
 *   visionTap(page, label, opts)        → { found, clicked, topmost, ... }
 *   native(page, step, opts)            → Promise<void>
 *   runFlow(page, scenario, binding, opts) → RunReport
 *
 * Config env vars:
 *   MLX_URL      — MLX completions endpoint (default: http://localhost:8089/v1/chat/completions)
 *   MLX_MODEL    — model id (default: mlx-community/Qwen2.5-VL-7B-Instruct-4bit)
 *   MLX_COORDS   — "abs" (pixel center) | "norm" (0-1000 normalized) (default: abs)
 *   SNAP_R       — DOM-snap search radius in px; 0 = pure vision coords (default: 0)
 *   VIEWPORT_W   — browser viewport width  (default: 1280)
 *   VIEWPORT_H   — browser viewport height (default: 800)
 *   BASE_URL     — app base URL for goto steps using relative paths (default: http://localhost:3100)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { askVision, resolveProviderConfig } from './providers.mjs';
import { createBlockState, installBlockRouting, installRedirectGuard, removeBlockRouting, storageStateError, validateStorageState } from './browser-context.mjs';

// ─── Default config (env-driven; overridable per-call via opts) ──────────────

const DEFAULTS = {
  mlx: process.env.MLX_URL || 'http://localhost:8089/v1/chat/completions',
  model: process.env.MLX_MODEL || 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit',
  coords: process.env.MLX_COORDS || 'abs',
  snapR: Number(process.env.SNAP_R ?? 0),
  viewport: {
    width: Number(process.env.VIEWPORT_W ?? 1280),
    height: Number(process.env.VIEWPORT_H ?? 800),
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3100',
  // Per-MLX-request wall-clock timeout. Without this a wedged sidecar (TCP
  // accepted, response never completes) hangs the whole /test actual run.
  timeoutMs: Number(process.env.MLX_TIMEOUT_MS ?? 30000),
};

// ─── Vision ask (provider-pluggable) ──────────────────────────────────────────
//
// Delegates to the provider layer (providers.mjs). `role` selects per-role config:
// 'grounding' (exact pixel coords — local spatial-VL recommended) vs 'verify'
// (pass/fail VQA — any provider). Back-compatible: legacy opts { mlx, model }
// map to the local provider. Timeout/abort surfaces as a thrown error caught by
// runFlow's per-step try/catch (rec.actError / rec.verify.why).

async function ask(b64, text, opts = {}, role = 'grounding') {
  const cfg = resolveProviderConfig(opts, role);
  // Legacy local defaults when the caller specified neither endpoint nor model.
  if ((cfg.provider === 'mlx' || cfg.provider === 'local')) {
    if (!cfg.endpoint) cfg.endpoint = opts.mlx || DEFAULTS.mlx;
    if (!cfg.model) cfg.model = opts.model || DEFAULTS.model;
  }
  if (cfg.timeoutMs == null) cfg.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  return askVision(b64, text, cfg);
}

// ─── PNG dimension reader (no dep) ───────────────────────────────────────────

function pngSize(buf) {
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// ─── Coordinate mapper ────────────────────────────────────────────────────────

function mapPx(ix, iy, W, H, { coords, viewport } = {}) {
  const vp = viewport || DEFAULTS.viewport;
  if ((coords || DEFAULTS.coords) === 'norm') {
    return [Math.round((ix / 1000) * vp.width), Math.round((iy / 1000) * vp.height)];
  }
  return [Math.round((ix / W) * vp.width), Math.round((iy / H) * vp.height)];
}

function currentViewport(page, opts = {}) {
  // Direct visionTap callers historically use the engine's 1280x800 default;
  // only context-owning flows pass a configured viewport whose live size may
  // have changed after a capture step.
  if (!opts.viewport) return DEFAULTS.viewport;
  try {
    const viewport = typeof page.viewportSize === 'function' ? page.viewportSize() : null;
    if (viewport?.width && viewport?.height) return viewport;
  } catch { /* use the configured fallback */ }
  return opts.viewport || DEFAULTS.viewport;
}

// ─── DOM settle ──────────────────────────────────────────────────────────────

export async function settle(page) {
  await page.evaluate(async () => {
    const t0 = performance.now(); let last = -1, since = performance.now();
    while (performance.now() - t0 < 7000) {
      const h = document.body.scrollHeight;
      if (h !== last) { last = h; since = performance.now(); }
      else if (performance.now() - since >= 1200) return;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
    }
  }).catch(() => {});
}

// ─── Vision LOCATE ────────────────────────────────────────────────────────────
//
// Coords-only grounding — no visibility judgment. The model self-reports visibility
// unreliably (grounded Post Now to ~6px yet flagged it "not visible"). Absent element
// → model returns 0,0 → click hits empty space → verify() catches the failure by
// outcome. This is more manual-faithful than trusting the self-reported flag.

export async function locate(page, label, fullPage, opts = {}) {
  const buf = await page.screenshot({ fullPage: !!fullPage });
  const [W, H] = pngSize(buf);
  const coordHint = (opts.coords || DEFAULTS.coords) === 'norm'
    ? 'x,y = normalized 0-1000 center.'
    : 'x,y = PIXEL center.';
  const raw = await ask(
    buf.toString('base64'),
    `Where is the element described as: "${label}" in this image? Output ONLY JSON {"x":<int>,"y":<int>}. ${coordHint} Output {"x":0,"y":0} only if it is genuinely not present anywhere in the image.`,
    opts,
    'grounding',
  );
  const ints = (String(raw).match(/-?\d+/g) || []).map(Number);
  const ix = ints[0] ?? 0;
  const iy = ints[1] ?? 0;
  return { found: ix > 0 && iy > 0, ix, iy, W, H, raw: String(raw).trim().slice(0, 140) };
}

// ─── Vision VERIFY ────────────────────────────────────────────────────────────
//
// Did the expected result happen? Settle + fullPage screenshot (verdict must not
// depend on scroll position — a human scans the whole visible render).
// Fail-closed: any negative signal → fail. Verify must not pass on ambiguity.

export async function verify(page, expected, opts = {}) {
  await settle(page);
  const buf = await page.screenshot({ fullPage: true });
  const raw = await ask(
    buf.toString('base64'),
    `A tester just performed an action. The EXPECTED result is: "${expected}". ` +
    'Look at the screenshot. Did that expected result actually happen / is it shown now? ' +
    'Reply ONLY JSON {"pass":true|false,"why":"<short reason>"}.',
    opts,
    'verify',
  );
  const s = String(raw);
  const passFalse =
    /"?pass"?\s*[:=]\s*false/i.test(s) ||
    /^\s*```?\s*(json)?\s*false/i.test(s) ||
    /\bnot (shown|visible|present|happen|posted|confirmed|enabled|completed)\b/i.test(s) ||
    /\bno confirmation\b/i.test(s);
  const passTrue =
    /"?pass"?\s*[:=]\s*true/i.test(s) ||
    /\b(confirmed|success|is shown|does appear|did happen|now shows)\b/i.test(s);
  const pass = passFalse ? false : passTrue;
  const why =
    s.match(/"why"\s*:\s*"([^"]+)"/i)?.[1] ||
    s.replace(/```[a-z]*|[{}"]/gi, ' ').trim().slice(0, 140);
  return { pass, why };
}

// ─── Vision TAP ───────────────────────────────────────────────────────────────
//
// Two-pass grounding: viewport-first → if missing, fullPage glance → scroll to center
// → precise viewport re-ground → real pointer click. Retry ≤3 for reflow-happy SPAs.
// DOM-snap OFF by default (SNAP_R=0) — pure manual coords; overlays/z-index apply.

export async function visionTap(page, label, opts = {}) {
  const snapR = opts.snapR ?? DEFAULTS.snapR;

  let g = null;
  const maxAttempts = opts.retryLimit ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const viewport = currentViewport(page, opts);
    await settle(page);
    let loc = await locate(page, label, false, opts);
    if (!loc.found) {
      const full = await locate(page, label, true, opts);
      if (full.found) {
        const scrollH = await page.evaluate(
          () => (document.scrollingElement || document.documentElement).scrollHeight,
        );
        // In normalized mode the model returns 0-1000 coords, NOT pixels —
        // divide by 1000, not the full-page PNG height.
        const coordsMode = opts.coords || DEFAULTS.coords;
        const fracY = coordsMode === 'norm' ? (full.iy / 1000) : (full.iy / full.H);
        const docY = Math.round(fracY * scrollH);
        await page.evaluate(
          (y) => { (document.scrollingElement || document.documentElement).scrollTo({ top: Math.max(0, y), behavior: 'instant' }); },
          docY - Math.round(viewport.height / 2),
        );
        await page.waitForTimeout(400);
        loc = await locate(page, label, false, opts);
      }
    }
    if (loc.found) { g = loc; break; }
  }

  if (!g) return { found: false, clicked: null, topmost: null };

  const viewport = currentViewport(page, opts);
  let [cx, cy] = mapPx(g.ix, g.iy, g.W, g.H, { ...opts, viewport });

  if (snapR > 0) {
    const snap = await page.evaluate(([x, y, r]) => {
      let best = null, bd = Infinity;
      for (const el of document.querySelectorAll('button,[role="button"],a[href]')) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        const dx = Math.max(b.left - x, 0, x - b.right);
        const dy = Math.max(b.top - y, 0, y - b.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2), d: Math.round(d) }; }
      }
      return best && best.d <= r ? best : null;
    }, [cx, cy, snapR]).catch(() => null);
    if (snap) [cx, cy] = [snap.cx, snap.cy];
  }

  const topmost = await page.evaluate(
    ([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${(e.className || '').toString().slice(0, 20)}` : null; },
    [cx, cy],
  ).catch(() => null);

  if (opts.hasTouch) await page.touchscreen.tap(cx, cy);
  else await page.mouse.click(cx, cy);
  await page.waitForTimeout(1500);
  return { ...g, clicked: [cx, cy], topmost };
}

// ─── Native primitive executor ────────────────────────────────────────────────
//
// Mechanical hands — deterministic Playwright primitives. Goto supports both
// absolute URLs (args.url) and relative paths (args.path, prepended with BASE_URL).

// A LATE VALUE: `{{waitFile:<absolute path>}}` as the whole fill value means
// "wait until that file exists, then type its trimmed content". A caller that
// learns a value only while the run is under way (an emailed sign-in code that
// an earlier step requested) writes the file then. Any other string is typed
// as given. The wait is bounded (opts.waitFileTimeoutMs, else
// SIMMAN_WAITFILE_TIMEOUT_MS, else 60 s) and an empty file keeps waiting.
const WAIT_FILE = /^\{\{waitFile:(\/[^{}]+)\}\}$/;

export async function lateValue(value, opts = {}) {
  const match = typeof value === 'string' ? WAIT_FILE.exec(value) : null;
  if (!match) return value;
  const file = match[1];
  const limit = Number(opts.waitFileTimeoutMs ?? process.env.SIMMAN_WAITFILE_TIMEOUT_MS ?? 60000);
  const pollMs = Number(opts.waitFilePollMs ?? 100);
  const until = Date.now() + (Number.isFinite(limit) && limit > 0 ? limit : 60000);
  for (;;) {
    try {
      const text = (await readFile(file, 'utf8')).trim();
      if (text !== '') return text;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= until) throw new Error('waitFile: no value arrived before the deadline');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// VISIBLE FIRST. A responsive page often renders one control twice (a phone
// list and a hidden desktop table); the first DOM match can be the hidden one,
// and clicking it times out. Prefer the first visible match when the locator
// supports filtering, else the plain first match.
function visibleFirst(locator) {
  if (typeof locator?.filter === 'function') {
    try { return locator.filter({ visible: true }).first(); } catch { /* older Playwright */ }
  }
  return locator.first();
}

async function countVisible(locator) {
  if (typeof locator?.count !== 'function') return 0;
  if (typeof locator.filter === 'function') {
    try { return await locator.filter({ visible: true }).count(); } catch { /* fall through */ }
  }
  return locator.count().catch(() => 0);
}

// The exact locator's first visible element when one exists, else the fallback's.
async function exactFirst(exact, fallback) {
  const count = await countVisible(exact).catch(() => 0);
  return count > 0 ? visibleFirst(exact) : visibleFirst(fallback());
}

// FILL A <select> BY ITS OPTION. Playwright's fill refuses a select; a check
// that "fills" Month with "March" means choose that option. Label first, then value.
async function fillOrSelect(page, target, text) {
  const isSelect = typeof target.evaluate === 'function'
    ? await target.evaluate((el) => el.tagName === 'SELECT').catch(() => false)
    : false;
  if (!isSelect) return target.fill(text);
  if (typeof page.waitForFunction === 'function') {
    for (;;) {
      const element = await target.elementHandle();
      let kind;
      try {
        const match = await page.waitForFunction(({ select, wanted }) => {
          if (!select.isConnected) return 'detached';
          const normalized = wanted.trim().replace(/\s+/g, ' ');
          const options = [...select.options].filter((option) => !option.disabled && !option.parentElement?.disabled);
          if (options.some((option) => option.label.trim().replace(/\s+/g, ' ') === normalized)) return 'label';
          if (options.some((option) => option.value === wanted)) return 'value';
          return false;
        }, { select: element, wanted: text });
        try { kind = await match.jsonValue(); }
        finally { await match.dispose(); }
      } finally {
        await element.dispose();
      }
      if (kind === 'detached') continue;
      return kind === 'label' ? target.selectOption({ label: text }) : target.selectOption({ value: text });
    }
  }

  try { await target.selectOption({ label: text }); }
  catch { await target.selectOption({ value: text }); }
}

export async function native(page, step, opts = {}) {
  const base = opts.baseUrl || DEFAULTS.baseUrl;
  const args = step.args || {};
  const activate = (locator) => opts.hasTouch && typeof locator.tap === 'function' ? locator.tap() : locator.click();
  switch (step.act) {
    case 'goto': {
      const url = args.url || (base + (args.path || '/'));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      break;
    }
    case 'fill': {
      // Overlay schema/tests accept `value`; runner historically read `text`.
      // Accept both so a valid overlay never silently fills ''.
      const text = await lateValue(args.text ?? args.value ?? '', opts);
      await fillOrSelect(page, visibleFirst(page.locator(args.selector)), text);
      break;
    }
    case 'tapRole':
      // EXACT NAME FIRST. A pattern match clicks the first element whose name
      // CONTAINS the words: "Sign in" hit "Sign in with Google" above the real
      // Sign in button. The pattern stays as the fallback for a partial name.
      // NO SUCH ROLE: a control without the role (a <summary> that opens a
      // <details> section, a styled <div>) is tapped by its exact visible text.
      {
        const role = args.role || 'button';
        const exact = args.name == null
          ? page.getByRole(role)
          : page.getByRole(role, { name: args.name, exact: true });
        let target = exact;
        if (args.name != null) {
          // Preserve exact-role priority, but wait on a union when no matching
          // role or text is present yet so late accessible-name-only controls
          // still get Playwright's configured action wait.
          if (await countVisible(exact) === 0) {
            let pattern;
            try { pattern = new RegExp(String(args.name), 'i'); }
            catch { pattern = new RegExp(String(args.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
            const partial = page.getByRole(role, { name: pattern });
            const text = typeof page.getByText === 'function' ? page.getByText(args.name, { exact: true }) : null;
            if (await countVisible(partial) > 0) target = partial;
            else if (text && await countVisible(text) > 0) target = text;
            else if (typeof exact.or === 'function' && partial && typeof partial.or === 'function') {
              const candidates = exact.or(partial);
              const waiting = text && typeof candidates.or === 'function' ? candidates.or(text) : candidates;
              const visibleWaiting = typeof waiting.filter === 'function' ? waiting.filter({ visible: true }) : waiting;
              await visibleWaiting.first().waitFor({ state: 'visible' });
              if (await countVisible(exact) > 0) target = exact;
              else if (await countVisible(partial) > 0) target = partial;
              else if (text && await countVisible(text) > 0) target = text;
              else throw new Error(`tapRole could not find a visible ${role} named ${JSON.stringify(args.name)}`);
            } else if (text) target = text;
            else target = partial;
          }
        }
        await activate(visibleFirst(target));
      }
      break;
    case 'tapText': {
      // Tests/overlays use `text`; legacy callers used `name`. Accept both so
      // we never build /undefined/i and click an unintended element.
      const name = args.name ?? args.text;
      if (name == null) throw new Error('tapText requires args.text or args.name');
      await activate(await exactFirst(
        page.getByText(name, { exact: true }),
        () => page.getByText(new RegExp(name, 'i')),
      ));
      break;
    }
    case 'wait':
      await page.waitForTimeout(args.ms || 300);
      break;
    case 'capture': {
      // A full-page PNG of the current screen, named by the scenario, for a
      // caller that compares it with a design (hive-ultra wireframe call-outs).
      if (!opts.capturesDir) throw new Error('capture needs a captures directory (--captures <dir>)');
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(args.name ?? ''))) {
        throw new Error(`capture needs a screen name; got ${JSON.stringify(args.name)}`);
      }
      if (args.width !== undefined || args.height !== undefined) {
        const current = page.viewportSize?.() || opts.viewport || DEFAULTS.viewport;
        await page.setViewportSize({ width: args.width ?? current.width, height: args.height ?? current.height });
      }
      await settle(page);
      await mkdir(opts.capturesDir, { recursive: true });
      const file = join(opts.capturesDir, `${args.name}.png`);
      await writeFile(file, await page.screenshot({ fullPage: true }));
      return { capture: file };
    }
    default:
      throw new Error(`unknown native act: ${step.act}`);
  }
}

// ─── Truth-signal evaluators ──────────────────────────────────────────────────
//
// Object form (preferred):
//   { kind: "network",         match: "<url substring>", method?: "POST" }
//   { kind: "element_enabled", selector?: "<css>", role?: "button", name?: "<text>" }
// Legacy string aliases (deprecated, kept for back-compat):
//   "posted"      ≙ { kind: "network", match: "/api/social/post", method: "POST" }
//   "cta_enabled" ≙ { kind: "element_enabled", role: "button", name: "post now" }

export const LEGACY_TRUTH_ALIASES = {
  posted: { kind: 'network', match: '/api/social/post', method: 'POST' },
  cta_enabled: { kind: 'element_enabled', role: 'button', name: 'post now' },
};

/** Pure request matcher — exported for tests. */
export function matchesNetworkTruth(spec, { url, method }) {
  if (!url || !url.includes(spec.match)) return false;
  if (spec.method && String(method).toUpperCase() !== spec.method.toUpperCase()) return false;
  return true;
}

function resolveTruth(signal) {
  if (typeof signal === 'string') {
    const t = LEGACY_TRUTH_ALIASES[signal];
    if (!t) throw new Error(`unknown truth signal: ${signal}`);
    return t;
  }
  return signal;
}

const TRUTH_WAIT_MS = Number(process.env.SIMMAN_TRUTH_WAIT_MS ?? 3000);

export async function evalTruthSignal(page, signal, networkState) {
  const truth = resolveTruth(signal);

  if (truth.kind === 'network') {
    return networkState.requests.some((r) => !networkState.blockedRequests?.has(r.request) && matchesNetworkTruth(truth, r));
  }

  if (truth.kind === 'element_enabled' && !truth.selector && typeof page.getByRole === 'function') {
    // ROLE LOOKUP THROUGH PLAYWRIGHT. A DOM query for [role="link"] misses a
    // plain <a href> (its role is implicit), and the same for <input>, <h1>,
    // <nav>: every such truth read false on a page that showed the element.
    // getByRole knows implicit roles. Exact name first, then a partial match.
    // Inspect every match so a hidden duplicate cannot mask a visible one.
    // If neither match exists yet, wait once on their union and then recheck
    // exact precedence within the same bounded budget.
    const role = truth.role || 'button';
    const escaped = truth.name ? truth.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
    const exact = truth.name ? page.getByRole(role, { name: truth.name, exact: true }) : page.getByRole(role);
    const partial = escaped ? page.getByRole(role, { name: new RegExp(escaped, 'i') }) : exact;
    const enabledRole = page.getByRole(role, { disabled: false });
    const waitLimit = Number.isFinite(TRUTH_WAIT_MS) ? Math.max(0, TRUTH_WAIT_MS) : 3000;
    const hasMatch = async (locator) => (await countVisible(locator)) > 0;
    const isEligible = async (locator) => {
      const eligible = typeof locator.and === 'function' ? locator.and(enabledRole) : locator;
      return eligible.evaluateAll((elements) => elements.some((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity) > 0.1 && rect.width > 0;
      })).catch(() => false);
    };

    if (await hasMatch(exact)) return isEligible(exact);
    if (partial !== exact && await hasMatch(partial)) return isEligible(partial);
    if (waitLimit > 0 && typeof exact.or === 'function' && partial && typeof partial.or === 'function') {
      const union = exact.or(partial);
      const visibleUnion = typeof union.filter === 'function' ? union.filter({ visible: true }) : union;
      await visibleUnion.first().waitFor({ state: 'visible', timeout: waitLimit }).catch(() => {});
      if (await hasMatch(exact)) return isEligible(exact);
      if (partial !== exact && await hasMatch(partial)) return isEligible(partial);
    }
    return false;
  }

  if (truth.kind === 'element_enabled') {
    return page.evaluate(({ selector, role, name }) => {
      let candidates;
      if (selector) {
        candidates = [...document.querySelectorAll(selector)];
      } else {
        const sel = role === 'button' || !role
          ? 'button,[role="button"],input[type="submit"],input[type="button"]'
          : `[role="${role}"]`;
        candidates = [...document.querySelectorAll(sel)];
      }
      const nameRe = name ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
      const el = candidates.find((x) => !nameRe || nameRe.test(x.textContent || x.value || x.getAttribute('aria-label') || ''));
      if (!el) return false;
      const cs = getComputedStyle(el);
      return (
        !el.disabled &&
        el.getAttribute('aria-disabled') !== 'true' &&
        parseFloat(cs.opacity) > 0.1 &&
        el.getBoundingClientRect().width > 0
      );
    }, { selector: truth.selector || null, role: truth.role || null, name: truth.name || null }).catch(() => false);
  }

  throw new Error(`unknown truth kind: ${truth.kind}`);
}

// ─── Pass precedence (hybrid V&V) ─────────────────────────────────────────────
//
// Decide whether a step passed, and on what basis:
//   1. truth-signal (DOM/network ground-truth) — authoritative when declared.
//   2. native act success — a Playwright fill/tap/goto either succeeds or throws,
//      so for a native step with no truth-signal the act IS the signal. Vision
//      verify is still recorded but only advisory here; the VL judge is noisy on
//      state it can't see (spike 1 / spike 4 false-failed an obviously-good fill).
//   3. vision verify — authoritative only for a vision step with no truth-signal,
//      where a visual judgment is the whole point.
//
// @param {{truth?:{pass:boolean}, acted?:boolean, verify?:{pass:boolean}}} rec
// @param {{how?:string}} b  the overlay step
// @returns {{pass:boolean, basis:'truth'|'native-act'|'vision-verify'}}
export function decidePass(rec, b = {}) {
  if (rec.truth) return { pass: !!rec.truth.pass, basis: 'truth' };
  if (b.how !== 'vision') return { pass: rec.acted === true, basis: 'native-act' };
  return { pass: !!rec.verify?.pass, basis: 'vision-verify' };
}

// ─── Flow runner (core) ───────────────────────────────────────────────────────
//
// Drives a full scenario flow: for each step, run setup primitives → act → verify.
// Returns a RunReport: { flowPassed, stepsPassed, posted, steps, scenario, model }.
//
// @param {import('playwright').Page} page — authenticated, pre-navigated page
// @param {object} scenario — parsed scenario YAML ({ id, steps: [{ action, expected }] })
// @param {object} binding  — validated overlay ({ scenario, steps: [StepEntry] })
// @param {object} [opts]   — { mlx, model, coords, snapR, viewport, baseUrl, onStep }
//   opts.onStep(rec) — optional callback after each step (for streaming progress)

export async function runFlow(page, scenario, binding, opts = {}) {
  // Record requests for network truth-signals. Only url+method are kept, capped
  // so a chatty SPA can't grow the array unbounded during a long flow.
  const blockState = opts.blockState;
  const networkState = { posted: false, requests: [], postRequests: [], blockedRequests: blockState?.blockedRequests };
  const MAX_RECORDED = 1000;

  // Named handler so we can detach it — callers may reuse an authenticated
  // page/context across runs; an anonymous listener would accumulate.
  const onRequest = (req) => {
    if (req.url().includes('/api/social/post') && req.method() === 'POST') networkState.postRequests.push({ url: req.url(), method: req.method(), request: req });
    if (networkState.requests.length < MAX_RECORDED) {
      networkState.requests.push({ url: req.url(), method: req.method(), request: req });
    }
    // Legacy report field (kept for back-compat with the "posted" alias).
  };
  page.on('request', onRequest);

  const report = [];

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const b = (binding.steps && binding.steps[i]) || {};
      const rec = { i, action: step.action, expected: step.expected, how: b.how };
      if (blockState) blockState.active = { i, action: step.action };

      // Setup primitives (pre-action, native only)
      for (const s of (b.setup || [])) {
        await native(page, s, opts);
      }

      // ACT
      try {
        if (b.how === 'vision') {
          rec.vision = await visionTap(page, b.target, opts);
          rec.acted = rec.vision.found;
        } else {
          const out = await native(page, b, opts);
          if (out?.capture) rec.capture = out.capture;
          rec.acted = true;
        }
      } catch (e) {
        rec.acted = false;
        rec.actError = String(e.message || e).split('\n')[0];
      }

      // VERIFY — a capture step is judged by its file, never by a vision verify
      // of its `expected` text, which describes the capture, not the page.
      const isNativeCapture = b.how !== 'vision' && b.act === 'capture';
      if (isNativeCapture) {
        rec.verify = { pass: !!rec.capture, why: rec.capture ? 'capture written' : 'no capture written' };
      } else {
        await page.waitForTimeout(500);
        try {
          rec.verify = await verify(page, step.expected, opts);
        } catch (e) {
          rec.verify = { pass: false, why: 'verify-error: ' + String(e.message || e).slice(0, 80) };
        }
      }

      rec.posted = hasAllowedPost(networkState, blockState);

      // Hybrid V&V: truth-signal is authoritative when declared
      if (b.truth) {
        const tp = await evalTruthSignal(page, b.truth, networkState).catch(() => false);
        rec.truth = { signal: b.truth, pass: !!tp };
        const resolved = resolveTruth(b.truth);
        if (!tp && resolved.kind === 'network' && networkState.requests.some((r) => networkState.blockedRequests?.has(r.request) && matchesNetworkTruth(resolved, r))) {
          rec.why = 'blocked';
        }
      }

      const verdict = isNativeCapture && !rec.capture
        ? { pass: false, basis: 'native-act' }
        : decidePass(rec, b);
      rec.pass = verdict.pass;
      rec.passBasis = verdict.basis;
      report.push(rec);

      if (opts.onStep) opts.onStep(rec);
    }
  } catch (e) {
    report.push({ fatal: String(e.message || e).split('\n')[0] });
  } finally {
    page.off('request', onRequest);
  }

  const steps = report.filter((r) => !r.fatal);
  const passed = steps.filter((r) => r.pass).length;
  const total = scenario.steps.length;

  return {
    scenario: scenario.id,
    model: (opts.grounding?.model || opts.model || DEFAULTS.model).split('/').pop(),
    snap: opts.snapR ?? DEFAULTS.snapR,
    flowPassed: passed === total,
    stepsPassed: `${passed}/${total}`,
    posted: hasAllowedPost(networkState, blockState),
    ...(blockState?.blocked?.length ? { blocked: blockState.blocked } : {}),
    steps: report.map((r) => r.fatal ? r : {
      i: r.i,
      how: r.how,
      acted: r.acted,
      actError: r.actError,
      visionFound: r.vision ? r.vision.found : undefined,
      clicked: r.vision?.clicked,
      topmost: r.vision?.topmost,
      visionVerify: r.verify?.pass,
      truth: r.truth?.pass,
      pass: r.pass,
      passBasis: r.passBasis,
      why: r.why || r.verify?.why,
      ...(r.capture ? { capture: r.capture } : {}),
      action: r.action,
      expected: r.expected,
    }),
  };
}

function hasAllowedPost(networkState, blockState) {
  return networkState.postRequests.some((r) =>
    !networkState.blockedRequests?.has(r.request) && !blockState?.blockedRequestKeys?.has(`${r.method} ${r.url}`));
}

// ─── High-level actual-mode executor ──────────────────────────────────────────
//
// Documented /test actual entry point. Accepts the single-object shape the
// test-mode-actual skill uses, owns Playwright browser/context/page lifecycle
// (close in finally), maps documented option names onto the low-level runFlow
// opts, and returns the same RunReport. The low-level runFlow(page, scenario,
// binding, opts) stays the CLI / caller-owns-page surface.
//
// @param {object} options
//   scenario       — parsed scenario object ({ id, steps })           [required]
//   overlay        — validated binding object ({ scenario, steps })   [required]
//   mlxEndpoint    — MLX completions URL        → opts.mlx
//   mlxModel       — MLX model id               → opts.model
//   snapDom        — boolean; false → snapR 0 (DOM-snap OFF per §3)
//   retryLimit     — vision-tap attempt cap     → opts.retryLimit
//   stepTimeoutMs  — per-MLX-request timeout    → opts.timeoutMs
//   baseUrl/coords/viewport/headless — optional overrides
//   page           — optional pre-built Playwright Page (caller owns teardown)
//   onStep         — optional per-step callback

export async function runActualFlow(options = {}) {
  const {
    scenario, overlay,
    mlxEndpoint, mlxModel,
    snapDom = false, retryLimit, stepTimeoutMs,
    baseUrl, coords, viewport, headless = true,
    page: providedPage, onStep, capturesDir,
    deviceScaleFactor = 1, isMobile = false, hasTouch = false, storageState, block = [],
    // Provider selection (optional). `provider` sets a global default; `grounding`
    // and `verify` are per-role override blocks ({ provider, model, endpoint, apiKey }).
    // Omitted → local MLX defaults, preserving the mlxEndpoint/mlxModel convenience.
    provider, grounding, verify,
  } = options;

  if (!scenario || typeof scenario !== 'object') {
    throw new Error('runActualFlow: options.scenario (parsed scenario object) is required');
  }
  if (!overlay || typeof overlay !== 'object') {
    throw new Error('runActualFlow: options.overlay (validated binding object) is required');
  }

  const selectedStorageState = validateStorageState(storageState);

  const opts = {
    mlx: mlxEndpoint || DEFAULTS.mlx,
    model: mlxModel || DEFAULTS.model,
    coords: coords || DEFAULTS.coords,
    snapR: snapDom ? (DEFAULTS.snapR || 12) : 0,
    viewport: viewport || DEFAULTS.viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    baseUrl: baseUrl || DEFAULTS.baseUrl,
    retryLimit: retryLimit ?? 3,
    timeoutMs: stepTimeoutMs ?? DEFAULTS.timeoutMs,
    onStep,
    capturesDir,
    storageState: selectedStorageState,
    block,
    provider, grounding, verify,
  };

  // Caller supplied a page → run directly; caller owns navigation + teardown.
  if (providedPage) {
    const blockState = createBlockState(block);
    const context = typeof providedPage.context === 'function' ? providedPage.context() : null;
    opts.blockState = blockState;
    try {
      if (context) {
        await installBlockRouting(context, blockState);
        await installRedirectGuard(context, providedPage, blockState);
      }
      return await runFlow(providedPage, scenario, overlay, opts);
    }
    finally { if (context) await removeBlockRouting(context, blockState); }
  }

  // Otherwise own the full Playwright lifecycle.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless });
  let context, blockState;
  try {
    const contextOptions = {
      viewport: opts.viewport,
      deviceScaleFactor: opts.deviceScaleFactor,
      isMobile: opts.isMobile,
      hasTouch: opts.hasTouch,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    };
    try {
      context = await browser.newContext(contextOptions);
    } catch (error) {
      if (opts.storageState) throw storageStateError(opts.storageState);
      throw error;
    }
    blockState = createBlockState(block);
    await installBlockRouting(context, blockState);
    opts.blockState = blockState;
    const page = await context.newPage();
    await installRedirectGuard(context, page, blockState);
    try {
      await page.goto(opts.baseUrl + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
    } catch (error) {
      if (blockState.blocked.length) return blockedNavigationReport(scenario, overlay, opts, blockState);
      throw error;
    }
    return await runFlow(page, scenario, overlay, opts);
  } finally {
    if (context && blockState) await removeBlockRouting(context, blockState);
    await browser.close();
  }
}

function blockedNavigationReport(scenario, binding, opts, blockState) {
  const steps = (scenario.steps || []).map((step, i) => ({
    i,
    how: binding.steps?.[i]?.how,
    acted: false,
    pass: false,
    passBasis: 'native-act',
    why: 'blocked',
    action: step.action,
    expected: step.expected,
  }));
  return {
    scenario: scenario.id,
    model: (opts.grounding?.model || opts.model || DEFAULTS.model).split('/').pop(),
    snap: opts.snapR ?? DEFAULTS.snapR,
    flowPassed: false,
    stepsPassed: `0/${steps.length}`,
    posted: false,
    blocked: blockState.blocked,
    steps,
  };
}
