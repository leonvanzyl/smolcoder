# smolcoder

A smol coding agent for the models already running on your machine.

If you have Ollama, LM Studio, oMLX or MTPLX running, you are two commands away from a coding assistant that reads your code, edits files, runs your tests and starts your dev server. No cloud account and no config file. Nothing leaves your machine except requests to the model server you chose. (oMLX and MTPLX have their own API keys; smolcoder reads a local one from the server's own settings and asks you for one on another machine.)

```bash
npm install -g smolcoder
smol
```

## Setup

You need two things.

1. **Node.js 18 or newer** from [nodejs.org](https://nodejs.org).
2. **A local model server.** Either [Ollama](https://ollama.com) with a tool-capable model pulled (`ollama pull qwen3` is a good start), or [LM Studio](https://lmstudio.ai) with a model loaded and its local server running (Developer tab, then Start Server), or on Apple Silicon [oMLX](https://github.com/jundot/omlx) or [MTPLX](https://github.com/youssofal/MTPLX) with its server started.

Then install smolcoder and start it inside a project:

```bash
npm install -g smolcoder
cd your-project
smol
```

`npx smolcoder` works too if you would rather not install anything globally.

smolcoder finds your server, lists the models you already have, and opens a chat. It remembers the model and permission mode you used last time.

All four servers are found the same way, with nothing to set up: on their usual ports, on a port you changed (LM Studio's, oMLX's and MTPLX's are read from their own settings, Ollama's from `OLLAMA_HOST`), inside Docker or Podman containers that publish the port, and on the host machine when smolcoder itself runs in WSL or a container.

If your models run on a different computer, see [Using models on another machine](#using-models-on-another-machine).

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
| `/models` | Switch model, or add models from other machines |
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

## Using models on another machine

The models do not have to run on the computer you code on. A desktop with a big GPU can serve a laptop, and you can add as many machines as you have. Everything below happens inside smolcoder. There is no file to edit and no command to run.

### 1. Let the other machine accept connections

Ollama and LM Studio only answer their own computer until you tell them otherwise. Do this once, on the machine that runs the models.

| Server | What to turn on |
|---|---|
| Ollama (Windows, macOS) | Settings → **Expose Ollama to the network** |
| Ollama (Linux, headless) | Set `OLLAMA_HOST=0.0.0.0` for the service and restart it |
| LM Studio | Developer → Local Server → **Serve on Local Network** |
| oMLX | Settings → Server → **Listen Address**: change it from "127.0.0.1 (Local only)" to the network option. Set `OMLX_API_KEY` on the machine running smolcoder to its API key |
| MTPLX | `mtplx serve --host 0.0.0.0 --api-key <key>`, and set `MTPLX_API_KEY` to the same key on the machine running smolcoder |

On Windows the firewall asks the first time the server listens on the network. Allow it for Private networks.

### 2. Find it from smolcoder

Open the model picker: type `/models` in the terminal, or click the model name in the web UI. Choose **Find models on another machine**.

- **Search my network** shows the range it is about to search, for example `192.168.1.0/24`, then looks for Ollama and LM Studio on it. This takes a few seconds. Every machine it finds is listed with what it runs, such as `gpu-box (192.168.1.50) · Ollama · 12 models`. Pick one and its models join your list. Pick again to add more.
- **Enter an address** is for machines a search cannot reach: a VPN or Tailscale address, another subnet, or a server on the internet. Type an IP (`192.168.1.50`), a name (`gpu-box.local`), a host and port (`gpu-box:4321`) or a URL (`https://llm.example.com`). For a bare IP or name, smolcoder tries both servers' usual ports and works out which one is there.

If no server is running on your own computer, smolcoder offers to find one on another machine at startup instead of exiting.

### 3. Use it like any other model

Models from other machines appear in the picker with the machine's name next to them, below the ones on your own computer. The status line shows where the current model runs, for example `qwen3:32b ollama @ gpu-box`.

- Added machines are remembered and checked every time smolcoder starts. One that is switched off is skipped, and its models come back when it does.
- The model you used last is remembered together with its machine, so the same model name on two machines is never confused.
- In the web UI, sessions on different machines run at the same time. Sessions on the same machine take turns.
- **Network hosts** in the model picker renames or removes a machine. If one stops answering because your router gave it a new address, **Look for it again** finds it and keeps its name.
- Headless runs (`smol -p`) use the machines you already added. They never search the network.

### Before you add a machine

smolcoder sends your code and prompts to the server you choose, and runs the tool calls that come back. A machine found by a search is never used until you pick it, so only pick machines you trust. For an address outside your own network over plain `http://`, smolcoder warns that the traffic is unencrypted and asks again before adding it.

### If nothing is found

- The server on the other machine is not accepting connections yet. Check step 1, and that the machine is awake.
- On macOS, allow your terminal app under System Settings → Privacy & Security → Local Network. Without that, nothing on the network is visible and no error is shown.
- The search covers the private network your computer is on. On a very large network it searches the 254 addresses around your own. Use **Enter an address** for anything further away.
- A server that needs an API key is asked for it when you add it, and the key is saved for that server. A server behind a login page is not supported.

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
