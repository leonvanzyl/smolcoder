# tiny-coder — TODO

## Done
- [x] **AGENTS.md memory files** — injected after the system prompt, size-capped (~2k tokens),
  survives compaction. Pirate-tested on Ollama and LM Studio.
- [x] **Plan tool** — harness-held checklist (set/done/add/show), TUI + web rendering,
  compaction re-injection, quit-halfway nudge. Proven in real runs on both backends.
- [x] **Web UI** (`--web`) — TUI twin over SSE, localhost + URL token.

## Outstanding
- [ ] **Human pass on the terminal TUI** — puppet-tested (16/16) and the web twin is
  visually verified, but no human has driven the real terminal UI yet (logo, slash menu,
  shift+tab, pickers, approval prompt, esc-cancel mid-stream).
- [ ] **Force a real tier-2 compaction** — eviction + compaction logic is unit-tested, but
  no real model run has grown big enough to trigger the summarize path (run with a small
  `--ctx` on a long task to exercise it).
- [ ] **Markdown rendering in the web page** — model output renders as plain text.
- [ ] **Web `/models` switch under a real model** — works against the mock; wants one
  real-model pass.
- [ ] **Plan persistence across sessions** (write/restore from the workspace?).
- [ ] **npm publish** — the `tiny-coder` name is available; needs a repo + first release.
