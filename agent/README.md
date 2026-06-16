# agent/ — synthesis layer (stub)

LLM layer that compiles **intent → structured flow** for the `engine/` to run.

Responsibility: given a URL + a natural-language goal ("log in, compose a post,
confirm it appears in the feed"), explore the page, decompose into ordered steps,
decide native-vs-vision per step, declare truth-signals, and emit a scenario +
overlay in the format `engine/bindings.mjs` validates.

Hard boundary: the agent NEVER drives the browser directly. It only produces the
structured plan. Execution belongs to `engine/`, and only after `gate/` approval.

Decided: full synthesis from a bare goal (autonomous), made safe by the mandatory
approval gate. See `../docs/scope.md`.

_Not yet implemented._
