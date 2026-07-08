# elevateurskills

**One sentence in, a runnable and tested project out — built by a pipeline of specialist AI agents, each with its own tools and validation gate.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)&nbsp;[![Node](https://img.shields.io/badge/Node-%E2%89%A520-3c873a.svg)](package.json)&nbsp;![Providers](https://img.shields.io/badge/LLM-DeepSeek%20%C2%B7%20OpenAI%20%C2%B7%20Anthropic-6b4fbb.svg)&nbsp;[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

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

## Demo

![elevateurskills terminal demo](docs/demo.gif)

<sub>Recorded with <a href="https://github.com/charmbracelet/vhs">vhs</a> — regenerate with <code>vhs docs/demo.tape</code>.</sub>

## Contents

- [Why elevateurskills](#why-elevateurskills)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [What you get back](#what-you-get-back)
- [How the pipeline works](#how-the-pipeline-works)
- [CLI](#cli)
- [Configuration](#configuration)
- [Sandbox](#sandbox)
- [Contributing](#contributing)

## Why elevateurskills

Most AI coding tools are a single agent in one chat loop. elevateurskills is a
pipeline of specialists with hard contracts between them:

- **Frozen contract between backend and frontend.** The Architect emits
  `architecture.json` (schema + API + folders); backend and frontend both
  consume it and neither may change it, so the two sides are built independently
  without drifting apart.
- **Per-agent validation gates with retry.** An agent can't report success until
  a real gate passes (server boots, `prisma generate` + build + tests, the
  production build). On failure the orchestrator re-spawns it with the error as
  new context, up to `--max-attempts` times.
- **Adaptive pipeline that skips agents.** The Architect classifies the request
  into a profile and runs only the agents it needs — an informational site never
  starts a backend, a database, or Docker.
- **Bring your own key, no telemetry, no accounts.** One API key in one `.env`.
  Nothing is sent anywhere except the LLM provider you choose — no login, no user
  database, no phone-home.

---

## Screenshots

<!-- TODO: add screenshots of the new UI into docs/screenshots/ and update paths below -->

<img width="1030" height="567" alt="elevateurskills" src="https://github.com/user-attachments/assets/330ead0d-6d62-46e9-bc9e-c58899c27391" />
<img width="1026" height="601" alt="agent" src="https://github.com/user-attachments/assets/dbc76b8f-15ea-4acf-957f-f580ad7e53ed" />

---

## Requirements

- **Node.js ≥ 20** and **npm**.
- **Docker** — optional but recommended. It gives the agents a real, isolated
  sandbox (see [Sandbox](#sandbox)); without it, commands run in a guarded local
  fallback confined to the run's `workspace/`.
- **Windows:** run under **WSL2** with the repo in the **Linux** filesystem
  (`~/...`, not `/mnt/c/...`) — see the WSL tip in [Sandbox](#sandbox).

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

`node dist/cli.js --request "..."` also works and needs no link.

> **Run the interactive TUI from the built CLI** (`elevateurskills` or `node
> dist/cli.js`), not from `npm run dev`. `npm run dev` executes through **tsx**,
> which prints its own runtime warnings to the terminal — and any stray write
> while the TUI owns the screen bleeds into the frame and makes it jump. Use
> `npm run dev` only for `--plain` output or non-TUI work:
>
> ```bash
> npm run dev -- --request "a todo REST API" --plain
> ```

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
the bottom. Type an instruction and press Enter to steer the running agent.
Scroll the transcript with the **mouse wheel** or **PgUp/PgDn** — scrolling up
freezes the viewport and shows a **▼ N new lines** indicator so incoming output
doesn't yank you to the bottom; **End** (or scrolling back down) re-enables
follow mode, and **Home/End** jump to top/bottom. **esc** stops, **ctrl-q**
quits. Piped or CI output falls back to clean timestamped log lines — force that
anywhere with `--plain`.

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

The generated `docker-compose.yml` publishes only the app ports it needs (the
frontend, and the API if it's called directly) and **never the database port**,
and it sets a unique Compose project name — so `docker compose up` won't collide
with a Postgres already on `5432` or with a previous generation's containers.

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

### Adaptive pipeline (only the agents you need)

The Architect classifies each request into a **profile** and records it in the
frozen contract (`profile`, `requiredAgents`, `needsSandbox`, `needsDatabase`).
The orchestrator then runs **only the required agents** — the rest are marked
`skipped` (a dim `–` in the tree, never spawned, no gate, no tokens) — and the
sandbox is activated **lazily**, only before the first stage that needs to run
commands, and only when the profile needs it.

| Profile | Runs | Backend | Sandbox/Docker |
|---------|------|---------|----------------|
| **static-site** | architect, frontend, reviewer | – | **no** (no-build HTML/CSS/JS) |
| **frontend-app** | architect, frontend, qa, reviewer, devops | – | yes (build/tests) |
| **api-only** | architect, backend, qa, reviewer, devops | ✓ | yes |
| **fullstack** | all | ✓ | yes |

So *"an informational website for a coffee shop"* classifies as **static-site**:
the backend agent is skipped, **Docker is never started** (it runs even with no
Docker installed), and the frontend gate just validates that the site's
`index.html` renders — no build, no server boot. Override auto-classification
with `--profile`, `--agents`, `--force-backend`, or `--no-backend`. The chosen
profile and skipped agents are shown at the Architect checkpoint and in the
final summary.

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
calling tools or a limit halts it. Tools execute inside a sandbox
(`src/core/sandbox.ts`) — a Docker container when Docker is available, otherwise
a local sandbox confined to the run's `workspace/` directory.

**Circuit breaker.** An agent can't spin forever. Each one has a hard token
budget (default 500K, `MAX_AGENT_TOKENS` / `--max-agent-tokens`) and tool-call
budget (default 50, `MAX_AGENT_ITERATIONS` / `--max-agent-iterations`); at 80% it
gets a "wrap up" nudge, at 100% it halts. Spin detection watches `run_shell`: the
same failing command three times, or five consecutive failures, injects a nudge
to stop fighting a likely environment problem and report the blocker. When a
budget is hit the stage is **not** silently continued — its partial work is saved
and you get a checkpoint: **[c]** continue with partial work · **[r]** retry with
a doubled limit · **[q]** quit. The usage box shows the live meter
(`412K / 500K tokens · 34 / 50 calls`), turning yellow at 80% and red at 100%,
and the final summary lists token/tool-call usage per agent.

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
  --profile <id>           force profile: static-site | frontend-app | api-only | fullstack
  --agents <list>          force an explicit agent set (architect always included)
  --force-backend          pull the backend agent back in (implies sandbox + db)
  --no-backend             drop the backend agent
  --max-attempts <n>       gate retries per stage (default: 2)
  --max-agent-tokens <n>   per-agent token budget (circuit breaker; default 500K)
  --max-agent-iterations <n>  per-agent tool-call budget (circuit breaker; default 50)
  --model <agent=spec>     per-agent model override (repeatable)
```

Examples:

```bash
# Adaptive: an informational site auto-classifies as static-site — the backend
# agent is skipped and Docker never starts.
elevateurskills --request "an informational website for a coffee shop"

# Force a profile when you already know what you want
elevateurskills --request "a landing page" --profile static-site

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

# Optional: circuit-breaker budgets per agent (CLI flags override these)
# MAX_AGENT_TOKENS=500000
# MAX_AGENT_ITERATIONS=50
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

Each command runs in a throwaway container built from `sandbox/Dockerfile`. The
image is **pre-configured for the opinionated stack** (full `node:20-bookworm`,
not alpine — Prisma's prebuilt query engines need glibc + OpenSSL, which is what
makes `prisma generate`/`migrate` load the engine on the first try instead of the
agent fighting `libquery_engine*.so.node` failures). It also carries the Postgres
client, the Chromium libs the frontend smoke test needs, and a globally-installed
Prisma/TypeScript/tsx toolchain so `npx prisma …` doesn't re-download on every
run. It is hardened by default:

- only the run's `workspace/` is mounted; the working dir is that mount
- all Linux capabilities dropped, `no-new-privileges`, memory/CPU/pids capped
- the host environment is **never** passed in — only the generated project's own
  vars (e.g. `DATABASE_URL`) are injected, and every provider key
  (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) is filtered out so
  project code can never see it
- default bridge network (outbound for `npm`/`prisma`), never the host network
- per-command timeout that kills the container

**Database.** A working `DATABASE_URL` is always injected into the sandbox, so
the agent never has to invent or configure one. For a Docker run that will build
the backend, a throwaway `postgres:16-alpine` sidecar is started on a per-run
Docker network and `DATABASE_URL` points the sandbox at it by container name;
it's torn down when the run ends (or on ctrl-q). If the sidecar can't start the
run continues against a placeholder URL — the backend's repository pattern keeps
tests runnable in-memory (`NODE_ENV=test`) without a live database. The local
backend always uses the placeholder URL.

Prisma downloads its query/schema engines from `binaries.prisma.io`; the image
build warms them in when it can reach that host, otherwise they download lazily on
first `prisma generate`. Either way, that host must be reachable from the build or
the container. (On IPv6-only egress it may not resolve — that CDN is IPv4-only.)

The image is **built locally** from `sandbox/Dockerfile`, never pulled. On
startup (before the planner runs) a preflight checks the daemon and builds the
image if missing, so a broken sandbox fails fast instead of after burning tokens.
The image is tagged with a hash of the Dockerfile
(`elevateurskills-sandbox:<hash>`), so repeat runs reuse the cached image and a
change to the Dockerfile automatically triggers a rebuild. A daemon/image/mount
failure mid-run is reported as an **environment error** (not a code failure) and
the stage is left resumable — fix the environment and re-run with `--resume`.

Use Docker for anything untrusted or unattended.

> **WSL tip:** if you're on Windows using WSL, run the project from your Linux
> home (`~/...`), not from a Windows path (`/mnt/c/...`). Bind-mounting a Windows
> path into the container is significantly slower and can hit permission quirks;
> the Linux filesystem avoids both.

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
- **Run the harness before a PR: `npm test`.** It runs the typecheck plus the
  full smoke suite offline (no API key needed): `smoke:ui` (reducer, viewport,
  mouse-wheel parser, stats formatter), `smoke:tui` (renders the dashboard from
  synthetic events), `smoke:loop` (a two-tool agent writes and runs a file),
  `smoke:limits` (circuit breaker), and `smoke:sandbox` (path confinement,
  command screening, Docker-arg hardening). `npm run smoke:llm` is separate — it
  makes one real completion, so it needs a provider key.
- UI work lives entirely in `src/ui/`. Add or change rendering there; if you
  need new data on screen, add a field to an event in `src/core/events.ts` and
  emit it from the orchestrator — the renderers stay pure consumers.

## License

Apache-2.0. See [LICENSE](LICENSE).
