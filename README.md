# elevateurskills

Give it a high-level software request. A team of specialist AI agents plans,
architects, builds, tests, reviews, and packages a working project — each agent
running a real act → observe → correct loop with tools (write files, run shell,
run tests) inside a sandbox.

Inspired by [Strix](https://github.com/usestrix/strix) (autonomous agents with
real tools in a sandbox), but pointed at software development instead of
security testing.

```
elevateurskills --request "a todo REST API"
```

→ `planner → architect → backend → frontend → qa → reviewer → devops`, with a
frozen contract in the middle so backend and frontend can't drift apart, and a
runnable project in `runs/<id>/workspace/` at the end.

- **Bring your own key. No accounts, no login, no database of users.** You set
  one API key in one file.
- **Agents are tool-loops, not one-shot prompts.** Each sees its own errors and
  fixes them until a real validation gate passes (server boots, tests pass,
  build succeeds).
- **DeepSeek, OpenAI, and Anthropic are equal first-class providers.** Pick one
  with `ELEVATE_LLM=provider/model`; set only that provider's key. Built on the
  Vercel AI SDK, so tool-calling is identical across all three.

---

## Screenshots

<!-- TODO: add screenshots of the new UI into docs/screenshots/ and update paths below -->
![Splash screen](docs/screenshots/splash.png)
![Pipeline running](docs/screenshots/tui-running.png)
![Agent tree + usage](docs/screenshots/tui-sidebar.png)

---

## Quickstart

**1. Pick a provider and paste its API key into `.env`.**

On first run the tool copies `.env.example` to `.env` for you. Open `.env`,
choose the active model, and set the key for *that* provider only:

```
# Pick ONE active model: provider/model  (provider ∈ deepseek | openai | anthropic)
ELEVATE_LLM=deepseek/deepseek-chat

# Set the key for the provider you chose (only that one is required)
DEEPSEEK_API_KEY=sk-your-deepseek-key
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

DeepSeek is shown here because it's the cheapest way to try the whole pipeline,
but the three providers are equal — switch by changing `ELEVATE_LLM` and setting
the matching key. Everything else has a working default.

**2. Install and run.**

```bash
npm install
npm run build
npm link          # makes `elevateurskills` a global command (dev)
elevateurskills --request "a todo REST API"
```

`node dist/cli.js --request "..."` also works and needs no link. Or run
straight from TypeScript without building:

```bash
npm run dev -- --request "a todo REST API"
```

### Installing the command

- **Local dev — `npm link`:** symlinks this repo onto your PATH, so
  `elevateurskills` runs the code you're editing. Undo with `npm unlink -g
  elevateurskills`.
- **Use it like a normal tool — `npm install -g .`** (from the repo root):
  installs a copy globally.
- **Windows:** npm puts an `elevateurskills.cmd` (plus a `.ps1` and a bash
  shim) on your PATH, so `elevateurskills` works in cmd, PowerShell, and Git
  Bash alike — no extra setup.

The command resolves its `.env`, `agents/`, and `runs/` relative to the
package, so you can invoke it from any directory.

On an interactive terminal you get a live dashboard: a splash, then a scrollable
transcript of the active agent (🧠 thinking, 📋 plan, ⚙ tool calls, gate
results, `── handoff ──` dividers) on the left, an agent tree and a
model/usage box (tokens + rough cost) on the right, and a steer input box at
the bottom. Type an instruction and press Enter to steer the running agent;
**PgUp/PgDn** scroll; **esc** stops, **ctrl-q** quits. Piped or CI output falls
back to clean timestamped log lines — force that anywhere with `--plain`.

The pipeline pauses at a checkpoint between stages so you can inspect the
Architect's frozen contract before Backend and Frontend build on it —
**[c]** continue, **[r]** retry the stage, **[q]** quit (single keypress, no
Enter). Pass `--auto` to run straight through.

---

## What you get back

A run produces a self-contained directory:

```
runs/<run-id>/
  plan.json            the task breakdown
  architecture.json    the FROZEN contract: schema + API + folders
  workspace/           the generated project (backend/, frontend/, docker-compose.yml, ...)
  log/                 per-agent transcripts (for debugging and resume)
  manifest.json        stage status — lets a crashed run resume
```

The generated project defaults to **Node + Express + Prisma + PostgreSQL**
(backend) and **React + Vite** (frontend). The backend uses the repository
pattern with an in-memory implementation for `NODE_ENV=test`, so its test suite
boots the real Express app and hits every endpoint **without needing a live
database**.

---

## How the pipeline works

| Stage | Does | Validation gate |
|-------|------|-----------------|
| **planner** | request → ordered task list → `plan.json` | valid JSON, non-empty tasks |
| **architect** | schema + API + folders → `architecture.json` (**frozen**) | valid contract, health endpoint, Postgres |
| *scaffold* | deterministic: create folders from the contract | — |
| **backend** | Express + Prisma API against the frozen contract | install, `prisma generate`/`validate`, build, tests pass |
| **frontend** | React + Vite UI wired to the contract's endpoints | install, production build succeeds |
| **qa** | hardens the test suite (edge cases, 400/404) | `npm test` passes |
| **reviewer** | lint, dead-code cleanup, fixes | lint + tests pass |
| **devops** | Dockerfiles, docker-compose, CI workflow | required files present and valid |

The **Architect's `architecture.json` is frozen**: backend and frontend both
consume it and must not change it. That single locked contract is what lets the
two sides be built independently without integration hell.

An agent may not report success until its gate passes. On failure the
orchestrator re-spawns it with the failure output as new context, up to
`--max-attempts` times.

### UI is decoupled from logic

The orchestrator and agents never print or know about a UI. They emit a small
set of typed events (`src/core/events.ts`) on an event bus; renderers subscribe
and draw. Two renderers auto-select on `process.stdout.isTTY`:

- **TUI** (`src/ui/tui.tsx`, built with Ink) — a two-column dashboard
  (transcript · agent tree + usage) with a splash and a steer input. Its
  "what to show" logic, including transcript-to-line flattening for the manual
  scroll viewport, is a pure reducer (`src/ui/model.ts`), so it's testable
  without a terminal. Steering and stop/quit flow back through a small control
  object (not the bus, which is logic → UI only).
- **Plain** (`src/ui/plain.ts`) — timestamped one-line-per-event output. The
  always-works fallback for non-TTY, CI, `--auto`, and piped runs.

If Ink fails to mount, the plain renderer takes over instead of crashing the
run. The full, untruncated transcript always goes to `runs/<id>/log/`
regardless of renderer. To swap or remove the UI, you touch only `src/ui/` —
never the pipeline.

### The agent loop

Every specialist runs the same loop (`src/core/loop.ts`): the model is given a
role, a task, and a subset of tools. It calls a tool, sees the **real** result
(including stack traces and failing tests), corrects, and repeats until it stops
calling tools or hits the iteration cap. Tools execute inside a sandbox
(`src/core/sandbox.ts`) — a Docker container when Docker is available, otherwise
a local sandbox confined to the run's `workspace/` directory.

---

## CLI

```
elevateurskills [options]

  -r, --request <text>     high-level software request
  -s, --stack <name>       target stack (default: node-prisma-react)
  --auto                   skip inter-stage checkpoints (autonomous)
  --plain                  force plain line output (no TUI), e.g. for CI/logs
  --resume <run-id>        resume an existing run from its last completed stage
  --stop-after <stage>     stop after a given stage (e.g. architect)
  --only <stages>          run only a subset, comma-separated
  --backend <mode>         sandbox: auto | docker | local (default: auto)
  --i-understand-local     consent to run model-generated commands on your host
  --max-attempts <n>       gate retries per stage (default: 2)
  --model <agent=spec>     per-agent model override (repeatable)
```

Examples:

```bash
# Inspect the frozen contract, then stop
elevateurskills --request "a URL shortener" --stop-after architect

# Autonomous, mixing providers: a stronger model for the architect only
elevateurskills --request "a booking API" --auto \
  --model architect=anthropic/claude-opus-4-8 --model backend=deepseek/deepseek-chat

# Resume a run that stopped
elevateurskills --resume 20260706-230126-tpx6
```

---

## Configuration

Everything lives in one `.env` at the repo root:

```
# Pick ONE active model: provider/model  (provider ∈ deepseek | openai | anthropic)
ELEVATE_LLM=deepseek/deepseek-chat

# Set the key for the provider you chose (only that one is required)
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Optional: override base URL for local / OpenAI-compatible endpoints
# LLM_API_BASE=
```

`ELEVATE_LLM` is `provider/model`. To switch providers you change that one line
and set the matching key — nothing else:

```bash
ELEVATE_LLM=deepseek/deepseek-chat      # DEEPSEEK_API_KEY
ELEVATE_LLM=openai/gpt-5.1              # OPENAI_API_KEY
ELEVATE_LLM=anthropic/claude-sonnet-5   # ANTHROPIC_API_KEY
```

The default model id for each provider lives in one place —
`src/core/models.ts` (`MODELS`) — with a "verify these" note, since model names
change over time. On startup the tool checks that the chosen provider's key is
present and, if not, exits naming the exact env var to set.

Per-agent overrides can cross providers: `--model architect=anthropic/claude-opus-4-8`
runs the Architect on Anthropic while the rest of the pipeline stays on your
active provider. Each model resolves its own provider's key, so you'll need both
keys set for a mixed run. To make an override the default, add it to
`AGENT_MODEL_DEFAULTS` in `src/core/models.ts`.

`LLM_API_BASE` is optional and applies to whichever provider is active — use it
to point at a local or OpenAI-compatible endpoint (e.g. an OpenAI-compatible
gateway, or LM Studio via `ELEVATE_LLM=openai/...`).

### Adding a provider

Each provider is one small adapter in `src/core/llm.ts` (built on the Vercel AI
SDK, which keeps tool-calling identical across providers). To add a fourth:

1. Install its AI SDK package, e.g. `npm install @ai-sdk/google`.
2. In `src/core/models.ts`: add the provider id to `ProviderId` / `PROVIDERS`,
   a default model to `MODELS`, and its key env var to `KEY_ENV`.
3. In `src/core/llm.ts`: import its `create*` factory and add one `case` to the
   `switch` in `modelInstance()`.

That's the entire surface — everything else (key preflight, per-agent overrides,
the CLI) is driven off those config maps.

### Adding an agent

1. Write `agents/<name>/role.md` — the system prompt. Define its input/output
   contract and its validation gate in prose.
2. Register it in `src/core/agents.ts`: give it a tool subset, a `buildTask`
   (what it receives), and a `gate` (how success is proven).
3. Add its name to `PIPELINE` in the position it should run.

The four things that define an agent — role prompt, tool subset, I/O contract,
validation gate — are exactly those three touch points.

---

## Sandbox

Agents run real shell commands, so where those commands run matters. Two
backends, selected by `--backend docker|local|auto` (default `auto`: Docker if
the daemon is reachable, else local).

### Docker backend (recommended, real isolation)

Each command runs in a throwaway container built from `sandbox/Dockerfile`
(Node 20 + Postgres client + Chromium libs), hardened by default:

- only the run's `workspace/` is mounted; the working dir is that mount
- all Linux capabilities dropped, `no-new-privileges`, memory/CPU/pids capped
- the host environment is **never** passed in — only the generated project's own
  vars (e.g. `DATABASE_URL`) are injected, and every provider key
  (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) is filtered out so
  project code can never see it
- default bridge network (outbound for `npm`/`prisma`), never the host network
- per-command timeout that kills the container

Use Docker for anything untrusted or unattended.

### Local backend (fallback — NOT real isolation)

When Docker is absent, commands run **on your machine**. This is guarded, but
the guards are best-effort, not a security boundary:

- **path confinement:** all file tools resolve through `realpath` and reject
  anything (including symlinks) that escapes `runs/<id>/workspace`
- **command screening:** a denylist refuses obviously dangerous commands
  (`sudo`, `rm -rf` outside the workspace, `curl|wget | sh`, global installs,
  `shutdown`/`mkfs`, redirects writing outside cwd, …); an allowlist runs the
  expected toolchain without friction; anything else needs an interactive
  confirm, and is **refused** under `--auto`
- **environment stripping:** commands get a minimal env with `HOME` redirected
  to a scratch dir; every provider key (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`), `LLM_API_BASE`, `ELEVATE_LLM` and other secrets are
  never present
- **consent:** the first local run asks you to type `yes`; `--auto` + local is
  refused unless you pass `--i-understand-local`

If you're running untrusted requests or leaving it unattended, use
`--backend docker`.

---

## Contributing

- The whole thing is small TypeScript with no framework. Start at
  `src/core/loop.ts` (the agent loop), `src/core/orchestrator.ts` (the
  pipeline), and `src/core/agents.ts` (the registry).
- Keep provider logic inside `src/core/llm.ts` and nowhere else.
- New tools go in `src/core/tools/` and are added to `ALL_TOOLS`.
- Verify changes end to end: `npm run smoke:llm` (one completion),
  `npm run smoke:loop` (a two-tool agent writes and runs a file), and
  `npm run smoke:tui` (renders the dashboard from synthetic events).
- UI work lives entirely in `src/ui/`. Add or change rendering there; if you
  need new data on screen, add a field to an event in `src/core/events.ts` and
  emit it from the orchestrator — the renderers stay pure consumers.

## License

Apache-2.0. See [LICENSE](LICENSE).
