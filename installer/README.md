# installer/ — local setup + doctor (stub)

Makes the heavyweight, platform-specific prerequisite stack install cleanly so
SimMan "just works" locally.

Planned `setup` / `doctor` responsibilities:
1. Assert macOS on Apple Silicon (MLX is Apple-only).
2. Create/locate a venv and pin `mlx-lm`.
3. `playwright install chromium`.
4. Warm the Qwen2.5-VL-7B-4bit weights (flagged; ~5GB to the HF cache).
5. Write resolved config (host/port/model).
6. Health check via the engine's `probe_ready` / `probeReady` — green before exit.

Form factor (Python CLI vs brew vs npm) is an open decision; Python CLI leads
because the MLX sidecar lifecycle is already Python. See `../docs/scope.md`.

_Not yet implemented._
