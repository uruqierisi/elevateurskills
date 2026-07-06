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
- **DeepSeek by default, any OpenAI-compatible provider in one line.** OpenAI,
  local Ollama/LM Studio, gateways — all first-class.

---

## Quickstart

**1. Paste your DeepSeek API key into `.env`.**

On first run the tool copies `.env.example` to `.env` for you. Open `.env` and
put your key on the one line that matters:

```
LLM_API_KEY=sk-your-deepseek-key
```

That's the only thing you have to set. Everything else has a working default.

**2. Install and run.**

```bash
npm install
npm run build
node dist/cli.js --request "a todo REST API"
```

Or without building, straight from TypeScript:

```bash
npm run dev -- --request "a todo REST API"
```

On an interactive terminal you get a live dashboard (header, the pipeline with
spinner/tick states and durations, the active agent's latest tool call and a
tail of its output, and a footer with elapsed time, tokens and a rough cost
estimate). Piped or CI output falls back to clean timestamped log lines; force
that anywhere with `--plain`.

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

- **TUI** (`src/ui/tui.tsx`, built with Ink) — a single in-place frame. Its
  "what to show" logic is a pure reducer (`src/ui/model.ts`), so it's testable
  without a terminal.
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
  --max-attempts <n>       gate retries per stage (default: 2)
  --model <agent=spec>     per-agent model override (repeatable)
```

Examples:

```bash
# Inspect the frozen contract, then stop
elevateurskills --request "a URL shortener" --stop-after architect

# Autonomous, with a stronger model for the architect only
elevateurskills --request "a booking API" --auto \
  --model architect=openai/gpt-4o --model backend=deepseek/deepseek-chat

# Resume a run that stopped
elevateurskills --resume 20260706-230126-tpx6
```

---

## Configuration

Everything lives in one `.env` at the repo root:

```
# The only thing you must set:
LLM_API_KEY=sk-your-deepseek-key

# Defaults — leave as-is for DeepSeek:
ELEVATE_LLM=deepseek/deepseek-chat
LLM_API_BASE=https://api.deepseek.com
```

`ELEVATE_LLM` is `provider/model`. The provider segment is a human label; the
actual endpoint is `LLM_API_BASE` and the key is `LLM_API_KEY`.

### Adding a provider

There is no provider plugin system to learn — every provider is reached through
the same OpenAI-compatible Chat Completions shape in `src/core/llm.ts`. To
switch, edit three lines in `.env`:

```bash
# OpenAI
LLM_API_KEY=sk-...
ELEVATE_LLM=openai/gpt-4o
LLM_API_BASE=https://api.openai.com/v1

# Local Ollama
LLM_API_KEY=ollama                     # any non-empty string
ELEVATE_LLM=ollama/llama3.1
LLM_API_BASE=http://localhost:11434/v1
```

If a provider needs a genuinely different request shape, `src/core/llm.ts` is
the single, isolated place to add it.

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

By default the tool uses Docker when it's installed, building the image in
`sandbox/Dockerfile` (Node 20 + Postgres client + Chromium libs). Without
Docker it falls back to a **local sandbox**: commands still run, confined to the
run's `workspace/` directory, but on the host — you'll see a warning. Install
Docker, or pass `--backend docker`, for full isolation.

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
