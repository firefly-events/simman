# gate/ — approval gate

The safety primitive. A synthesized test plan MUST pass through here before any
browser action runs.

Responsibility: render the plan from `agent/` human-readable — ordered steps, what
each step will click/fill, what it will verify, which truth-signals are
authoritative — and require an explicit **approve / edit / reject** before handing
the structured plan to `engine/`.

The human approves, edits, or rejects the plan before any browser action runs.

Nothing the agent infers reaches a real cursor without passing this gate.

Implemented: `render.mjs` (renderPlan / approveOrThrow) + `edit.mjs` (edit loop).
Wired into `simman synthesize` as an interactive TTY gate (approve / edit in $EDITOR / reject).
