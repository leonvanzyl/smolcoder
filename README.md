# smolcoder

A smol coding agent for the models already running on your machine.

If you have Ollama or LM Studio running, you are two commands away from a coding assistant that reads your code, edits files, runs your tests and starts your dev server. No API key and no config file. Nothing leaves your machine except requests to your local model server.

```bash
npm install -g smolcoder
smol
```

## Setup

You need two things.

1. **Node.js 18 or newer** from [nodejs.org](https://nodejs.org).
2. **A local model server.** Either [Ollama](https://ollama.com) with a tool-capable model pulled (`ollama pull qwen3` is a good start), or [LM Studio](https://lmstudio.ai) with a model loaded and its local server running (Developer tab, then Start Server).

Then install smolcoder and start it inside a project:

```bash
npm install -g smolcoder
cd your-project
smol
```

`npx smolcoder` works too if you would rather not install anything globally.

smolcoder finds your server, lists the models you already have, and opens a chat. It remembers the model and permission mode you used last time.

## Using it

Type what you want done and press enter. The agent reads files, edits them and runs commands inside your project folder, and says what it is doing as it goes. After it edits files it runs your project's build and test scripts and repairs what fails.

| Key | What it does |
|---|---|
| `/` | Opens the command menu |
| `shift+tab` | Cycles the permission mode: read-only, edit, bypass |
| `esc` | Cancels the running turn, or clears the input |
| `ctrl+c` twice | Quits |

The line under the input shows the mode, the model, the reasoning effort, how full the context window is, and any background tasks.

### Commands

| Command | What it does |
|---|---|
| `/models` | Switch model |
| `/mode` | Set the permission mode (`ro`, `edit`, `bypass`) |
| `/effort` | Set reasoning effort (`off`, `low`, `medium`, `high`, `default`) |
| `/plan` | Show the agent's checklist |
| `/context` | Show context window usage |
| `/compact` | Compact the conversation now |
| `/tasks`, `/logs <id>`, `/stop <id>` | Inspect and stop background tasks such as dev servers |
| `/clear` | Start a fresh conversation |
| `/help`, `/exit` | Help and quit |

### Permission modes

| Mode | Files | Commands |
|---|---|---|
| `ro` | read and search only | none |
| `edit` (default) | read, write, edit | run freely inside the project folder; anything reaching outside it asks you first |
| `bypass` | read, write, edit | never asks |

File access stops at the project folder. In edit mode, a command that reaches outside it (another folder, your home directory, a global install) asks for approval first and says why. This is a text check on the command, not an operating-system sandbox, so use read-only mode on code you do not trust.

### Options

```bash
smol                            # current folder
smol path/to/project            # a specific project
smol --model qwen3              # pick a model by partial name
smol --effort off               # no thinking: fastest for long tool loops
smol --mode bypass              # never ask for approval
smol --ctx 16384                # cap the context window
smol --web                      # browser UI (see below)
smol -p "fix the failing test"  # headless: run one prompt, print the transcript, exit
smol -p "build the app" --verify "npm test"   # headless with an acceptance command
```

With `--verify`, the command has to pass before the run counts as done. Failures go back to the agent to repair, six attempts by default. `--verify-attempts 12` allows more.

## The web UI

`smol --web` opens a browser UI and prints a private link. The server only listens on your machine, and the link carries a random key.

- **Workspaces and sessions.** The sidebar lists your project folders, each with its own sessions. Run several at once and switch between them while they work.
- **Sessions survive restarts.** Past sessions stay in the sidebar and resume with a click. Transcripts live under `~/.smolcoder/sessions/`.
- **Paste screenshots and files.** Paste an image with `ctrl+v` or right-click and choose Paste, drop files onto the chat, or click the paperclip. Images go to the model when it can see them, and the chip warns you when it cannot. Text files are added to your message.
- **Browser and terminal panels.** Preview the dev server the agent started, or open a shell in the workspace, next to the chat.
- **One server for everything.** Running `smol --web` in another folder adds it to the UI that is already open.

## Why it works well with local models

Local models are free and private, but they give you less to work with. The context window is small, generation is slower, and long instructions get lost. smolcoder is built around those limits.

- **It stays out of the model's way.** A short system prompt and eight simple tools (four in read-only mode) leave most of the window for your code.
- **It watches the real window.** It asks the server how much context is actually loaded, shows a meter, and keeps room for the reply. A model that advertises a 128k window is often loaded with 4k, and smolcoder budgets for the 4k.
- **It tidies up before the window fills.** Old file reads and command output go first. Only then does it ask the model for a short handover. Your request and the checklist are never summarized away.
- **It keeps the plan outside the conversation.** The to-do list and the notes for the current step live in smolcoder itself, so they survive any summary.
- **It uses the waiting time.** While a long command runs, the same model can prepare that handover in the background. Coding always comes first.
- **It recovers from hiccups.** A stalled stream, a cut-off reply or a tool call that keeps failing gets retried or stopped with a clear message.

The full mechanics are in [docs/how-it-works.md](docs/how-it-works.md): the context budget, compaction, planning, checks, and how this compares with other agents.

## Tips

- **Give it a memory.** Put your conventions and commands in an `AGENTS.md` file at the project root. It is loaded every session and survives compaction.
- **Turn thinking off for long jobs.** `/effort off` leaves more of each reply for tool calls and code.
- **Let it run things in the background.** Dev servers and watchers run as background tasks. Check them with `/tasks` and `/logs`, stop them with `/stop`.
- **Backend notes.** Benchmarks and Ollama versus LM Studio tuning are in [docs/backend-notes.md](docs/backend-notes.md).

## Contributing

Issues and pull requests are welcome at [github.com/leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder). Clone it, run `npm install`, then `npm test`.

## License

[MIT](LICENSE)
