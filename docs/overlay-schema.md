# Actual-Manual Overlay Schema

**Status:** canonical reference for `actual-manual` flow-binding overlays  
**Loader:** [`engine/bindings.mjs`](../engine/bindings.mjs)

## Purpose

The flow-bindings overlay is the **thin annotation layer** that tells the vision-cursor
runner *how* to actuate each step of a SimMan scenario. It does not duplicate or replace the
scenario — the scenario (`action` + `expected`) remains the contract; the overlay only
specifies the actuation method.

Design anchor: design-discussion.md §3.5 — "Zero new scenario schema."

## File Location

```text
scenarios/flow-bindings/<scenario-id>.json
```

One overlay file per scenario, co-located with the scenario's YAML. The scenario id is the
stable key; the overlay file is named to match.

## Top-Level Shape

```json
{
  "scenario": "<scenario-id>",
  "steps": [ <step-entry>, ... ]
}
```

`steps` is parallel to the scenario's `steps` array: index 0 of the overlay maps to index 0
of the scenario. The array must be the same length as the scenario's `steps`.

## Step Entry Shape

Every step entry has a required `how` field:

```
how: "native" | "vision"
```

### `how: "native"`

Native steps are executed by the platform runner (Playwright web / Maestro mobile) using
deterministic primitives.

```json
{
  "how": "native",
  "act": "<act>",
  "args": { ... },
  "setup": [ <primitive>, ... ],
  "truth": "<truth-signal>"
}
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `how` | yes | `"native"` |
| `act` | yes | One of: `goto \| fill \| tapRole \| tapText \| wait` |
| `args` | yes | Act-specific argument map (see below) |
| `setup` | no | Ordered list of native primitives run *before* the action |
| `truth` | no | Authoritative truth-signal for step verification (see below) |

#### `act` Reference

| `act` | `args` shape | Meaning |
|-------|-------------|---------|
| `goto` | `{ "url": string }` | Navigate to URL |
| `fill` | `{ "selector": string, "value": string }` | Fill input matching CSS selector |
| `tapRole` | `{ "role": string, "name"?: string }` | Tap element by ARIA role (+ optional accessible name) |
| `tapText` | `{ "text": string }` | Tap element whose visible text matches |
| `wait` | `{ "ms"?: number, "selector"?: string }` | Wait for duration (ms) or for selector to appear |

### `how: "vision"`

Vision steps are actuated by the vision-cursor (Qwen2.5-VL grounding + real pointer click).
The model locates the target from a screenshot; the runner does not use selectors.

```json
{
  "how": "vision",
  "target": "<label describing the UI element>",
  "setup": [ <primitive>, ... ],
  "truth": "<truth-signal>"
}
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `how` | yes | `"vision"` |
| `target` | yes | Human-readable label the model uses to ground and click |
| `setup` | no | Native primitives run before the vision action |
| `truth` | no | Authoritative truth-signal for step verification |

## `setup[]` — Pre-action Primitives

`setup` is an optional list of native primitives executed in order before the step's main
action. Use it when a CTA must be enabled or a precondition satisfied before the primary
gesture.

Each setup item is a native primitive (same `act`/`args` shape as a native step, without
`how`):

```json
"setup": [
  { "act": "fill", "args": { "selector": "[data-testid=caption-input]", "value": "Hello" } }
]
```

## `truth` — Authoritative Verification Signal

`truth` is optional and, when present, is the **authoritative backstop** for
step verification. Vision verify runs alongside; if they diverge, the truth-signal wins and
the divergence is recorded.

This is necessary because vision cannot reliably read enabled/disabled state, and ephemeral
toasts vanish before a screenshot can capture them.

### Object form (preferred)

Declare your own app's ground truth per step:

```yaml
# network: the app fired a matching request (success API call observed)
truth:
  kind: network
  match: /api/orders        # URL substring
  method: POST              # optional; any method when omitted

# element_enabled: a matching element exists, is visible, and not disabled
truth:
  kind: element_enabled
  name: Submit              # visible/accessible text (or use selector)
  role: button              # optional; default button-like elements
  # selector: "#submit"     # css alternative to role/name
```

| Kind | Verification method |
|------|---------------------|
| `network` | A request whose URL contains `match` (and matches `method`, if given) was observed during the run |
| `element_enabled` | An element matched by `selector` or `role`+`name` exists, is visible (width > 0, opacity > 0.1), and is not disabled / `aria-disabled` |

### Legacy string aliases (deprecated)

| Value | Equivalent object form |
|-------|------------------------|
| `posted` | `{ kind: network, match: /api/social/post, method: POST }` |
| `cta_enabled` | `{ kind: element_enabled, role: button, name: post now }` |

These match the app SimMan was extracted from; prefer the object form for your own app.

## Validation Rules

The loader (`loadBindings`) validates and throws on:

- `scenario` is missing or not a non-empty string
- `steps` is missing or not a non-empty array
- Any step has an unknown `how` (not `native` or `vision`)
- A `native` step is missing `act` or `args`
- A `native` step has an unknown `act`
- A `vision` step is missing `target`
- Any step declares `truth` with an unknown alias, an unknown `kind`, a `network` truth without `match`, or an `element_enabled` truth without `selector`/`name`
- Any setup item is missing `act` or has an unknown `act`

Errors name the `scenarioId` and the step index (e.g., `scenario "flayr-campaign-compose" step 2`).

## Worked Example — `flayr-campaign-compose`

```json
{
  "scenario": "flayr-campaign-compose",
  "steps": [
    {
      "how": "native",
      "act": "goto",
      "args": { "url": "https://app.flayr.com/campaigns/new" }
    },
    {
      "how": "native",
      "act": "fill",
      "args": { "selector": "[data-testid=caption-input]", "value": "Summer drop 🌊" },
      "truth": "cta_enabled"
    },
    {
      "how": "vision",
      "target": "Post Now button",
      "setup": [
        {
          "act": "fill",
          "args": { "selector": "[data-testid=caption-input]", "value": "Summer drop 🌊" }
        }
      ],
      "truth": "posted"
    }
  ]
}
```

**Step 0** — native goto navigates to the compose page.  
**Step 1** — native fill types the caption; `truth: cta_enabled` is the authoritative check
that the Post Now CTA became active.  
**Step 2** — vision grounding clicks Post Now (selectorless, pixel-grounded); `setup` re-fills
the caption in case of prior page reset; `truth: posted` catches the network event
authoritatively even if the confirmation toast has already dismissed.
