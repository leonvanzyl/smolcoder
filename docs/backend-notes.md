# Backend notes and benchmarks

Measurements and tuning notes behind smolcoder's Ollama and LM Studio support. Numbers are from one machine and one model, so treat them as a guide rather than gospel.

## Backend notes: Ollama vs LM Studio

Measured head-to-head with identical qwen3.8-27B Q4_K_M weights on one RTX 5090
(the model is a hybrid recurrent `qwen35` build; Ollama 0.33, LM Studio 0.4.21):

| | Ollama | LM Studio |
|---|---|---|
| prompt processing (6.7k-token cold prompt) | ~3,300 tok/s | ~3,000–3,400 tok/s |
| generation, 400 tokens of prose, thinking off | ~120 tok/s | ~68 (4 slots + MTP) / ~76 (1 slot, no MTP) tok/s |
| generation, 1,200 tokens of JavaScript, thinking off | ~170 tok/s | ~110 (1 slot + MTP) / ~76 (no MTP) tok/s |
| one agent step (plan + write call), thinking off | 0.9 s | 1.5–1.8 s |
| one agent step with thinking, same prompt | 0.8–10 s (38–3,500 reasoning chars) | 1.8–85 s (250–19,000 reasoning chars) |

The engine is the same llama.cpp on both, so the differences come from what the
harness sends and from load settings:

- **Reasoning effort was the whole story behind "LM Studio is slow".** LM Studio's
  API takes `reasoning_effort` none/minimal/low/medium/high/xhigh, but each model only
  supports some of them and a value the model lacks is silently replaced by the
  model's *default* — which for current qwen3.x builds is **xhigh**, the maximum.
  Asking for `high` therefore produced 8,000-token thinking bursts before single
  tool calls. smolcoder now reads the model's supported levels and default from
  `/api/v1/models`, sends `none` for `off` (measured: fully disables thinking), and
  snaps other levels to the nearest one the model has (`high` → `medium` on qwen;
  ties go to the cheaper level). The status line shows the mapping (`high → medium`,
  `default → xhigh`), and a warning is printed when the default is the maximum.
  On Ollama, `off` is a real `think: false` and any other level is `think: true`
  (levels only exist for gpt-oss there).
- **Thinking is unpredictable on local models.** The same prompt at the same level
  thought for 250 characters one run and 19,000 the next. For long tool loops,
  `--effort off` is the reliable setting on both backends; `low`/`medium` are fine
  for questions and planning.
- **Generation is ~1.5× faster on Ollama** with default settings (Ollama also
  drafts 4 tokens per step with the model's MTP head; LM Studio drafts 2). On LM
  Studio, keep MTP speculative decoding ON for coding — it took code generation from
  76 to ~110 tok/s (it slightly slows prose, which is what most benchmarks measure) —
  and load with a single slot, which is another ~10%:
  `lms load <model> --context-length 65536 --parallel 1 --speculative-draft-mtp`.
  Prompt caching works on both (only the new tail of the prompt is processed).
- **Ollama keeps the model resident** for 30 minutes between calls (its own default
  unloads after 5 min — a long approval pause used to cost a 10–20 s reload).
  Override with `SMOLCODER_KEEP_ALIVE=1h`.
- **Reasoning traces are not replayed** for finished turns (the qwen templates drop
  them anyway); only the current turn's traces travel with the tool loop. On a
  thinking model this is the largest single prompt-size saving.

## End-to-end: the same Minecraft build on both backends

One headless run each (`smol -p "<prompt>" --mode bypass --effort off`), same
model weights, same prompt (procedural voxel terrain, first-person controls, block
place/remove, three.js from a CDN, then serve it). Nobody typed "continue".

| | Ollama | LM Studio (1 slot, MTP on) |
|---|---|---|
| wall clock | 64 s | 85 s |
| tool calls | 20 (5 files) | 14 (3 files) |
| tokens generated | 9.4k @ 171 tok/s | 7.4k @ 96 tok/s |
| plan | 6/6 done | 3/3 done |
| syntax warnings from the write hook | 0 | 0 |
| result in the browser | loads, no console errors; one mesh-winding bug | loads, no console errors; terrain not visible |

Both agents finished on their own, checked their files with `node --check`, and
started a static server to prove the page served. Reproduce with `bench/run.sh`
(the prompt is `bench/minecraft-prompt.txt`; every headless run ends with a
`[stats]` JSON line on stderr). Both first drafts had one real bug
(this is a 27B model writing a voxel engine with thinking off); each was fixed with
a second headless turn carrying a one-paragraph, symptom-only bug report:

| fix turn | Ollama | LM Studio |
|---|---|---|
| wall clock | 42 s | 100 s |
| tool calls | 27 (reads, searches, 3 edits, node one-liners) | 27 (7 reads, 3 edits, 10 commands, 6 plan) |
| tokens generated | 4.8k @ 165 tok/s | 6.9k @ 79 tok/s |
| outcome | solid terrain; face vertex order fixed | terrain renders; spawn height + camera pitch fixed |

### The same build with reasoning on (`--effort high`)

`high` resolves to `medium` on this LM Studio model (its levels are off/low/medium/xhigh;
ties snap to the cheaper neighbour) and to `think: true` on Ollama.

| | Ollama (`think: true`) | LM Studio (`high → medium`) |
|---|---|---|
| wall clock | 84 s | 289 s (about a third of it a port-collision detour caused by the test setup) |
| tool calls | 16 | 28 |
| tokens generated | 10.6k @ 146 tok/s, ~2.6k of them reasoning | 22.5k @ 84 tok/s, ~12.2k of them reasoning |
| plan | 4/4 | 5/5 |
| result in the browser | correct on the first try: terrain, hills, controls, no console errors | correct on the first try: terrain, hills, controls, no console errors |

Reasoning bought correctness: both first drafts worked, where both effort-off drafts had
needed a bug-fix turn. The price is time — the model's per-step thinking is where the
backends differ most (Ollama's `think: true` produced a quarter as many reasoning
tokens as LM Studio's `medium`), and LM Studio's default `xhigh` would have been far
slower still. Note that the two effort-off runs plus their fix turns (106 s on Ollama,
185 s on LM Studio) still beat the reasoning runs on wall clock.

### Forcing compaction

The same build with the window capped at 12k tokens (`--ctx 12000`, output budget
3k) is the stress test for everything above: Ollama finished the whole game in
104 s and 28 tool calls with context management kicking in five times, the plan
reported 5/5, and the page rendered. On LM Studio the same run went through a tier-1
eviction (7.4k → 5.1k tokens) and then a real tier-2 compaction (7.5k → 2.1k tokens:
system prompt + plan + model-written hand-over notes + the working tail), after which
the model carried on with the remaining steps — syntax check, serve, summarize. (That
LM Studio build parses and serves but throws a runtime TypeError on load — a file
assembled in five pieces under a 3k output cap is where a 27B model starts to slip,
and a parse check cannot catch runtime errors.) Two things made the runs work at all:

- when a whole-file `write_file` overflows the output cap, the model is told the call
  was **not executed** and coached to write the file in parts (first part with
  `write_file`, then `edit_file` appends) — before that coaching existed the model
  retried the same oversized write three times in a row;
- the plan and the hand-over notes are re-injected after every compaction, so the
  model resumes at the right step instead of starting over.

