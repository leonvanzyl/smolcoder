# smolcoder — TODO

## Done
- [x] **AGENTS.md memory files** — injected after the system prompt, size-capped (~2k tokens),
  survives compaction. Pirate-tested on Ollama and LM Studio.
- [x] **Plan tool** — harness-held checklist (set/done/add/show), TUI + web rendering,
  compaction re-injection, quit-halfway nudge. Proven in real runs on both backends.
- [x] **Web UI** (`--web`) — TUI twin over SSE, localhost + URL token.
- [x] **Markdown rendering in the web page.**
- [x] **Reasoning effort that means what it says on LM Studio** — reads the model's supported
  levels and default from `/api/v1/models`, sends `none` for off, snaps other levels to what the
  model has. (Previously "high" fell back to the model default — `xhigh` on qwen3.x — and "off"
  did nothing on models without the `/no_think` switch.)
- [x] **Speed readout** — every turn ends with tool count, tokens generated, tok/s; headless runs
  print a `[stats]` JSON line for scripted backend comparisons.
- [x] **Post-write syntax check hook** — JS/JSON/HTML-inline-script/Python parse errors come back on
  the write_file/edit_file result with a line number.
- [x] **Compaction v2** — structured hand-over notes written with thinking off, old reasoning traces
  not replayed, stale reads of overwritten files evicted immediately.
- [x] **Ollama keep_alive** — the model stays resident 30 min between calls (`SMOLCODER_KEEP_ALIVE`).
- [x] **Unit tests** — `npm test` (node:test, no deps).
- [x] **Real tier-2 compaction on a live model** — `bench/run.sh mc-compact <model> off --ctx 12000`:
  tier-1 eviction then a hand-over-notes compaction (7.5k → 2.1k tokens) on LM Studio, five
  compactions on Ollama; both finished the build with the plan intact. Headless logs show the tier.
- [x] **Cut-off tool calls are coached** — an oversized write_file that overflows the output cap
  now gets "not executed, write it in parts" instead of a generic "continue".

## Outstanding
- [ ] **Human pass on the terminal TUI** — puppet-tested and the web twin is visually verified, but
  no human has driven the real terminal UI in a while (logo, slash menu, shift+tab, pickers,
  approval prompt, esc-cancel mid-stream).
- [ ] **Plan persistence across sessions** (write/restore from the workspace?).
- [ ] **Per-backend effort memory** — one saved effort for both backends is awkward now that the
  levels differ (`high` → `medium` on qwen/LM Studio, `→ thinking on` on Ollama).
- [ ] **npm publish** — package `smolcoder`, command `smol`; repo at github.com/leonvanzyl/smolcoder. First release pending.
