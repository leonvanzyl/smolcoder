# Complex local-model lifecycle test — 13 September 2026

This exercise uses the production harness to build and repair **Block Meadow**, a Minecraft-inspired Three.js/Vite game, in `playground/block-meadow`. It tests a substantially larger task than the earlier [context smoke test](audit-2026-09-13.md#validation-and-limits).

## Setup and attribution

- Windows, Ollama 0.33.3, `qwen3.8:latest`: the installed 27.3B Q4_K_M model. This is a small-context experiment with a 27B model, **not evidence about 4B-model quality**.
- Explicit 8,192- and 16,384-token allocations. Most runs disabled thinking. One broad repair with thinking enabled also stalled.
- The production `Agent`, context manager, providers, plan, permissions and tools executed the work. The benchmark wrapper adds logging, saved state, heartbeats and a run deadline; it does not substitute another coding model.
- The local model wrote the application implementation and its geometry regression checks. Codex supplied the task, inspected failures, wrote independent behavioral acceptance tests and browser automation, and gave increasingly specific repair feedback, including actual module APIs and movement conventions. Repairs used both saved-session continuation and fresh, focused sessions over the same files.
- This was **supervised completion**, not an unattended one-prompt success. The unsuccessful attempts are retained in local logs. No source changes to the generated game were silently made by the supervising coding agent.

## What the larger task exposed

The initial 8k attempts repeatedly read the same modules after compaction. One run made 51 coding requests and 26 summary requests before the unchanged-read guard stopped it. The first 16k build created the game modules but stopped with inconsistent imports and method calls: 64 coding requests, 76 tool calls and three applied summaries in 203 seconds. Enabling reasoning for a broad repair did not solve this; it consumed 23,928 generated tokens and stopped after 281 seconds without completing the repair.

Focused repair requests were more productive. For example, the build integration repair completed in 31 seconds, and an 8k repair to start the game loop and bind its resize handler completed in nine seconds with nine tool calls. These timings are individual observed runs with different tasks, histories and warm-model state; they are not matched performance comparisons.

Browser execution was essential. Passing the build initially concealed a div passed as a canvas, a missing game-loop start, wrong Player method calls, white terrain, a missing block-edit method, reversed movement and incompatible save formats. A later repair introduced an undefined identifier inside geometry construction; an import-only test missed it, so the model added a test that actually builds geometry. Independent physics tests caught stale grounded state, body-overlap errors and landing inside thick terrain.

## Harness changes driven by the run

| Observed failure | Change |
|---|---|
| Fresh source was discarded merely to reach the soft compaction target | Preserve the newest complete tool group when it fits the hard input budget. |
| Large reads displaced related modules | Return contiguous context-sized pages with exact continuation lines. |
| Earlier file-write arguments consumed the working window | Remove old successfully applied write/edit bodies from model history; keep execution receipts and the newest group. |
| Reasoning displaced useful source | Drop older reasoning before recent tool results; after an empty reasoning-limited reply, announce one action-only continuation and restore the chosen effort afterwards. |
| Long commands swallowed the handover facts budget | Preserve bounded recent commands and their exit outcomes; size the narrative separately. |
| Repeated inspection without progress | Fingerprint unchanged observations, coach the model, then stop with a recoverable diagnosis. Reminders do not change the fingerprints. |
| Reconstructed APIs drifted across summaries | Add a bounded, verbatim working checkpoint to the current plan step. Label model-authored notes as advisory; current files remain authoritative. |
| Failed replacements led to repeated full-file reads | Return a specific bounded source range; do not tell the model to replace a whole method using an incomplete suggested snippet. |
| `npm test \| head` hid failure, and large logs lost their final errors | Enable Bash `pipefail`; retain both beginning and end of command output. |
| Generated playground tests leaked into the harness suite | Discover harness tests explicitly under `test/`. |
| Context bookkeeping flooded terminal output | Use a transient context spinner and a single resulting status instead of duplicate pre/post messages. |

Checkpoints reduce dependence on repeated summaries but do not guarantee faithful notes. This model still invented interfaces in some checkpoints. The successful path required executable checks and focused feedback, not trusting those notes as facts.

## Final validation

- **Harness:** 82 passed, one Windows symlink-permission skip, zero failures. The earlier audit started at 52 passing tests.
- **Generated game:** eight independent behavioral tests plus the model's geometry construction test passed; Vite's production build passed. The acceptance checks were strengthened after the Player coordinate convention changed to require actual travel toward each collision wall, preventing a vacuous non-penetration pass.
- **Browser:** 13 check groups passed in headless Chrome with no page exceptions. These include all WASD directions at four camera angles, grounded jumping, five hotbar selections, target/mining, adjacent placement, refusal to place inside the player, resizing, repeated pause/resume, exact saved position/selection/edits/camera restoration, both dismissing and accepting New World, and corrupt-save recovery. Debug teleport only arranges test positions; keyboard and mouse events perform the interactions against live game state.
- **Recovery against the live Ollama adapter:** all four injected conditions passed. No partial tool call executed; the action-only continuation disabled thinking for one request and restored it afterwards. Cancellation settled in one millisecond in this run, and the following turn completed. This is a measured client cancellation result, not a server shutdown timing guarantee.
- The local model server was not restarted or observed to crash. Generated-game exceptions were captured and repaired during the exercise. The final game is a 48×48×32 voxel world with exposed-face meshes, hills, trees, water, block editing and local saves.
- The README's four Mermaid diagrams were rendered, and its local links and JSON examples checked.

## Reproduce and inspect

From the repository root, after `npm install`:

```bash
npm run build
mkdir -p playground/voxel-trial
node bench/lifecycle-runner.cjs playground/voxel-trial bench/minecraft-lifecycle-prompt.txt playground/voxel-logs --backend=ollama --model=qwen3.8:latest --ctx=16384 --effort=off
node bench/lifecycle-report.cjs playground/voxel-logs
```

Use an installed tool-capable model name. Logs must be outside the generated workspace. Each run records timestamped request counts, actual token usage, tool arguments/results, compaction events, progress heartbeats and the final outcome. `state.json` is saved after tools and compaction; add `--resume` with the same log directory and a feedback prompt file to continue it. `--max-minutes=15` is the default cancellable run deadline. A failed or cancelled run exits nonzero. A `completed` outcome means the model ended its turn; independently verify the generated application.

For the existing local artifact:

```bash
node --test bench/block-meadow-checks.mjs
cd playground/block-meadow
npm test
npm run build
npm run dev -- --host 127.0.0.1 --port 4187
```

The acceptance script is specific to this generated project's interfaces. The original [build prompt](../bench/minecraft-lifecycle-prompt.txt) can generate a different implementation on a fresh run. Playground projects, screenshots and detailed transcripts are ignored by Git; the benchmark prompt, runner, report generator and independent acceptance checks are retained in the repository.

With the game server running, [the browser checks](../bench/block-meadow-browser.cjs) can be run with `node bench/block-meadow-browser.cjs`. Supply Playwright through `PLAYWRIGHT_PATH` or an existing local installation, and optionally select a Chrome executable with `CHROME_PATH`. `BLOCK_MEADOW_URL` defaults to `http://127.0.0.1:4187`; `BLOCK_MEADOW_LOG_DIR` selects the screenshot/JSON output folder. This creates an isolated browser session and exercises its local save data.

The local [fault-injection runner](../bench/live-recovery.cjs) proxies Ollama without stopping the user's server:

```bash
node bench/live-recovery.cjs playground/recovery-trial qwen3.8:latest
```

It checks a temporary 503, an incomplete tool-call stream, a simulated exhausted reasoning budget, cancellation during a stalled response, and continuation. Run inference tests serially when sharing one GPU; scheduling is per harness process, not a machine-wide lock.

## Limits

There is no matched Claude Code, Codex or OpenCode benchmark here. No claim is made that the harness improves the model's underlying reasoning ability or guarantees unattended completion. LM Studio remains covered by adapter/load/stream regression tests; this complex live run used Ollama. The browser checks exercise a desktop keyboard/mouse game and are not a cross-browser or graphics-performance benchmark. The harness's shell permission scan is not an operating-system sandbox.
