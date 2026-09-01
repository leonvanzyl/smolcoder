# tiny-coder

A tiny, zero-config CLI coding agent for **local models**. Ollama and LM Studio only — and because it supports only those, it can make them first-class: no base URLs, no API keys, no config files, no setup questions. Start it and code.

```bash
npm install -g tiny-coder
tiny-coder
```

Works on Windows, macOS, and Linux. Zero runtime dependencies.

## The TUI

tiny-coder opens straight into a session — the last model you used (or the first one detected) is picked automatically. Everything is changed in-session:

- **`/` slash commands** with an autocomplete menu: `/models` (switch model, type to filter), `/mode`, `/effort`, `/tasks`, `/compact`, …
- **shift+tab** cycles read-only → write → yolo
- **esc** cancels a running turn; **ctrl+c ×2** quits
- The status line under the input shows mode · model · effort · context fill · running background tasks, live.
- `/effort` maps to Ollama's `think` parameter and LM Studio's `reasoning_effort`. `off` disables thinking on qwen3-class models — a real speedup. Models that don't support it fall back silently.

For scripts and automations there is a headless mode that prints the transcript and exits: `tiny-coder -p "prompt"` (reasoning noise suppressed, exit code reflects success).

## Why

Most coding harnesses treat local models as an afterthought: you configure endpoints by hand, and then they inject huge system prompts, dozens of tools, MCP servers and skills into a model with a small context window. tiny-coder is built the other way around:

- **Zero config.** Probes the standard Ollama (`127.0.0.1:11434`, or `$OLLAMA_HOST`) and LM Studio (`127.0.0.1:1234`) endpoints and lists whatever models you already have. Docker-hosted Ollama with the usual port mapping is picked up automatically.
- **Tiny context footprint.** A two-paragraph system prompt, exactly seven flat tools, hard caps on every tool output, and no MCP, no skills, no subagents.
- **Context windows handled properly.** For Ollama, tiny-coder respects the server's own configured context length (the Ollama app's setting) — it preloads the model and reads the effective window from `/api/ps`, sending an explicit `num_ctx` only on old Ollama versions where the silent tiny default would truncate prompts, or when you pass `--ctx`. For LM Studio it reads the loaded context length from `/api/v0/models` and budgets within it. Real token usage reported by the backend drives a live context meter and automatic compaction (old tool output is evicted first — nearly free — and the conversation is summarized only when that's not enough).
- **Small-model-friendly tools.** Flat string parameters, an example call in every description, and error messages written as coaching (a failed edit shows the closest real snippet to copy). The edit tool forgives whitespace drift — the difference between usable and unusable local editing.

## Modes

| Mode | Files | Commands |
|------|-------|----------|
| `ro` (read-only) | read/search only | none |
| `write` (default) | read/write/edit | each command asks y/n (or **a**lways-allow that program for the session) |
| `yolo` | read/write/edit | no approval prompts |

The mode decides which tools *exist* — in read-only mode the model is never even told a write tool exists. File tools are sandboxed to the workspace folder (symlink escapes included). Commands run with the workspace as their working directory.

## The plan — a compass for small models

For multi-step tasks the agent keeps a to-do list via a `plan` tool (`set` / `done` / `add` / `show`). It's not a gimmick copied from the big harnesses — it's built for small context windows:

- The list lives in the **harness**, not in a file or the transcript, so rendering it costs zero tokens and **compaction can never destroy it** — after every compaction the checklist is re-injected, so the model wakes up looking at its map.
- Every `done` result answers "what's next" in ~10 tokens, continuously re-focusing the model.
- If the model tries to stop with steps unfinished, the harness pushes back once — attacking the classic local-model failure of quitting halfway.
- You see it live: a checklist block in the TUI whenever it changes, `plan 2/4` in the status bar, `/plan` to reprint it, and checklist updates on stderr in headless runs.

## AGENTS.md memory

If the workspace contains an `AGENTS.md`, its contents are injected right after the system prompt (size-capped at ~2k tokens) and survive compaction. Put your project conventions, commands, and quirks there.

## Tools the model gets

`read_file` · `write_file` · `edit_file` · `list_files` · `search` · `plan` · `run_command` · `task`

`task` manages background processes (dev servers, watchers): `start`, `list`, `logs`, `stop`. Background tasks are non-blocking, keep a ring buffer of recent output, show up in the status line, and are killed when tiny-coder exits. You can inspect them yourself with `/tasks`, `/logs <id>`, `/stop <id>`.

## Usage

```bash
tiny-coder                        # current folder, remembers your last model & mode
tiny-coder path/to/project        # a specific workspace
tiny-coder --mode yolo            # no approval prompts
tiny-coder --model qwen3          # pick a model by (partial) name
tiny-coder --ctx 16384            # cap the context window (Ollama: sets num_ctx)
tiny-coder -p "fix the failing test"   # one-shot, non-interactive
```

In a session: `/mode`, `/model`, `/context`, `/compact`, `/tasks`, `/logs <id>`, `/stop <id>`, `/clear`, `/help`, `/exit`. `Ctrl+C` cancels a running turn.

## Backend notes: Ollama vs LM Studio

Measured head-to-head with identical qwen3.8-27B Q4 weights:

- **Ollama is the smoother agentic backend**, not because of a different engine
  (both run llama.cpp) but because it gives the harness more control: per-request
  context sizing, a real thinking off-switch (`think: false`), native tool-call
  parsing (~0.5s to a completed call vs ~2s), and ~2× faster generation with
  default settings (~180 vs ~80 tok/s on the same GPU).
- **`/effort off` now works on both.** Ollama disables thinking natively. LM Studio's
  `reasoning_effort` cannot disable thinking, so for qwen-family models tiny-coder
  appends the `/no_think` soft switch to the latest user message (measured: 9.8s → 1.0s
  for the same request).
- **LM Studio tips**: load the model with a bigger context (`lms load <model>
  --context-length 32768` or more — tiny-coder budgets to whatever is loaded), and
  consider `--parallel 1` (default 4 slots costs ~20% generation speed when you only
  run one session). Prompt caching works well on both backends.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) with at least one tool-capable model pulled (e.g. `ollama pull qwen3`), **or** LM Studio with its local server running (Developer tab → Start Server).

## License

MIT
