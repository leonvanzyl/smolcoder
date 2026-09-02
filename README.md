# smolcoder

A smol coding agent for the models already running on your machine.

If you have Ollama or LM Studio installed, you are two commands away from an AI pair programmer that reads your code, edits files, runs your tests and starts your dev server, all without an API key, a config file, or a single question about base URLs.

```bash
npm install -g smolcoder
smol
```

That is the whole setup. smolcoder finds your local server, lists the models you already have, and drops you into a session.

## Why you might like it

Most coding agents are built for big cloud models and treat local ones as an afterthought. They ship huge system prompts, dozens of tools and plugin systems, then wonder why a 7B model with a 16k window gets lost. smolcoder goes the other way.

- **Zero config.** It probes the standard Ollama and LM Studio ports and uses whatever it finds. Docker-hosted Ollama with the usual port mapping works too.
- **Built for small context windows.** A two-paragraph system prompt, seven flat tools, and hard caps on every tool output. Nothing else competes for the model's attention.
- **Context handled for you.** It reads the real token counts from the backend, shows a live context meter, and compacts old tool output before it ever has to summarise your conversation.
- **Small-model-friendly tools.** Every tool has an example call in its description, error messages coach the model toward the fix, and the edit tool forgives whitespace drift. That last one is the difference between a local model that can edit files and one that cannot.
- **A plan the model cannot lose.** For multi-step work the agent keeps a checklist that lives in the harness, not the transcript, so it survives compaction and keeps the model on track.
- **Runs anywhere Node runs.** Windows, macOS and Linux. Zero runtime dependencies.

## Setup

You need two things.

1. **Node.js 18 or newer.** Get it from [nodejs.org](https://nodejs.org) if you do not have it.
2. **A local model server**, either:
   - [Ollama](https://ollama.com) with a tool-capable model pulled, for example `ollama pull qwen3`, or
   - [LM Studio](https://lmstudio.ai) with a model loaded and its local server running (Developer tab, then Start Server).

Then install and start:

```bash
npm install -g smolcoder
cd your-project
smol
```

Prefer not to install anything globally? `npx smolcoder` works too.

## Your first session

smolcoder opens straight into a chat with the last model you used, or the first one it detects. Type what you want done and press enter. The agent reads files, makes edits, and runs commands inside your project folder, telling you what it is doing as it goes.

A few keys worth knowing from the start:

| Key | What it does |
|---|---|
| `/` | Opens the slash-command menu with autocomplete |
| `shift+tab` | Cycles the permission mode: read-only, edit, bypass |
| `esc` | Cancels the running turn, or clears the input |
| `ctrl+c` twice | Quits |

The status line under the input shows the current mode, model, reasoning effort, how full the context window is, and any background tasks you have running.

## Slash commands

| Command | What it does |
|---|---|
| `/models` | Switch model. Type to filter the list. |
| `/mode` | Set the permission mode (`ro`, `edit`, `bypass`) |
| `/effort` | Set reasoning effort (`off`, `low`, `medium`, `high`, `default`) |
| `/plan` | Show the agent's current checklist |
| `/context` | Show context window usage |
| `/compact` | Compact the conversation now |
| `/tasks`, `/logs <id>`, `/stop <id>` | Inspect and stop background tasks such as dev servers |
| `/clear` | Start a fresh conversation |
| `/help`, `/exit` | Help and quit |

## Modes

The mode decides which tools the model even knows about. In read-only mode it is never told a write tool exists.

| Mode | Files | Commands |
|---|---|---|
| `ro` | read and search only | none |
| `edit` (default) | read, write, edit | runs freely inside the project folder. Anything reaching outside it asks you first. |
| `bypass` | read, write, edit | never asks |

File tools are sandboxed to the project folder, symlinks included. In edit mode each command is scanned before it runs, and paths outside the folder, home-directory or temp-directory references, and global package installs all trigger an approval prompt that shows the reason. This is a text scan rather than an OS sandbox, so a script the model runs could still reach outside. Use read-only mode for code you do not trust, and bypass when you want no prompts at all.

## Handy options

```bash
smol                            # current folder, remembers your last model and mode
smol path/to/project            # a specific project
smol --model qwen3              # pick a model by partial name
smol --effort off               # no thinking: the fastest setting for long tool loops
smol --mode bypass              # never ask for approval
smol --ctx 16384                # cap the context window
smol --web                      # browser UI with a workspace sidebar (see below)
smol -p "fix the failing test"  # headless: run one prompt, print the transcript, exit
```

Headless mode is for scripts and automation. It suppresses reasoning noise and the exit code tells you whether the run succeeded.

## The web UI

`smol --web` serves a local browser UI and prints a private URL (it carries a random key, and the server only listens on localhost). You can run it from anywhere, including your home folder: the page has a sidebar of your workspaces, and every workspace keeps its own list of sessions.

- **Many projects, many sessions.** Open a folder from the sidebar, start as many sessions as you like, and switch between them while they work. A dot next to each session shows whether it is busy, idle, or waiting for you to approve a command. Sessions you are not looking at keep streaming in the background.
- **Sessions survive restarts.** Transcripts are saved under `~/.smolcoder/sessions/`, so past sessions stay in the sidebar and can be resumed with a click, model and all. Close a session to stop it, delete it to forget it.
- **One server for everything.** Running `smol --web` from a second folder adds that folder to the already-running UI instead of starting another server.
- **A browser panel.** The globe icon opens a resizable panel on the right with browser tabs. Dev servers the agent starts show up as suggestions, so previewing the app it is building is one click.
- **A terminal panel.** The terminal icon (or ctrl+`) opens a shell in the current workspace, right next to the chat. It streams output without a TTY, which means interactive programs such as `vim` will not work there, but `npm test`, `git status` and friends do. The terminal, browser tabs and chat all live in the same panel, in tabs.
- `ctrl+b` hides and shows the sidebar.

## Tips

**Turn thinking off for long tasks.** `/effort off` disables reasoning on qwen3-class models, which makes each step several times faster. Thinking helps with planning and tricky bugs, but for a twenty-step build the model rarely needs it. Models without a thinking switch fall back silently.

**Give the agent a memory.** If your project has an `AGENTS.md` file, its contents are injected after the system prompt and survive compaction. Put your conventions, commands and quirks there.

**Let it run things in the background.** The agent can start dev servers and watchers as background tasks, check their logs, and stop them. They show up in the status line and are killed when smolcoder exits.

**Curious about the numbers?** Benchmarks, Ollama versus LM Studio tuning notes, and what happens when the context window is squeezed are all in [docs/backend-notes.md](docs/backend-notes.md).

## Contributing

Issues and pull requests are welcome at [github.com/leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder). Clone it, run `npm install`, then `npm test`.

## License

[MIT](LICENSE)
