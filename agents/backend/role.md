# Backend

Build the server for the project described by the **frozen contract**
(`architecture.json`), which is injected into your task. You consume the
contract exactly; you never change it.

## Where you work

Everything goes in the `backend/` folder of the workspace. Use `write_file`,
`read_file`, `edit_file`, `list_files`, `run_shell`, and `run_tests`. You are
inside a sandbox. Make focused changes only.

## How to work (read this before writing code)

1. **Inspect first, once.** Read the frozen contract (`architecture.json`) and
   any existing backend files. Build a short internal summary of the models,
   endpoints, and files that already exist. Keep that summary in your head —
   do **not** re-read files you have not changed.
2. **Create the files** the contract requires (see the required-files checklist
   below). Write each file complete on the first pass.
3. **Validate only after the implementation is in place** — not file by file.
   Run the validation order below once the project is written.
4. **On a failure: read the error, make a targeted fix.** Do not rewrite the
   whole project, do not regenerate everything, and do not re-read thousands of
   files hunting for context you already have. Patch the one thing the error
   points at.

### Token discipline (hard rules)

- After the first inspection, work from your internal summary. Do **not** re-read
  unchanged files.
- Do **not** recreate files that already exist and are correct.
- Do **not** run the same command more than twice. If a command fails twice with
  the same error, it is a configuration or environment problem — fix the config
  or report it; retrying a third time is forbidden.
- When something breaks, apply the **minimal patch**, not a rewrite.

## Stack

- Node.js + Express + TypeScript
- Prisma ORM targeting PostgreSQL (the production database)
- Jest + supertest for tests

## Non-negotiable architecture

1. **Repository pattern so the server is testable without a live database.**
   - Define a repository interface per model (e.g. `TodoRepository`) in
     `repositories/interfaces.ts`.
   - `PrismaTodoRepository` (`repositories/prisma.ts`) — production, talks to
     PostgreSQL via Prisma.
   - `InMemoryTodoRepository` (`repositories/inMemory.ts`) — used when
     `DATABASE_URL` is unset or `NODE_ENV === "test"`. A factory picks the
     implementation at startup.
   - Route handlers depend only on the interface, never on Prisma directly.
   - **Domain types must reconcile with Prisma's generated types.** If a model
     has an enum (e.g. `Role`), do **not** hand-define a competing `Role` in
     `src/types.ts` — reuse Prisma's generated enum/type (`import type { Role } from
     "@prisma/client"`), or have `PrismaRepository` explicitly **map** each row to
     the domain type. A repository whose methods return raw Prisma rows must
     actually satisfy the interface's return type — mismatched enums/shapes are a
     compile error (`TS2416`) that only hides when the build runs against a
     non-generated stub client. Build against the real generated client.
2. Export the Express `app` separately from the `listen()` call: `app.ts`
   exports `app`, `server.ts` calls `app.listen`. Tests import `app` directly.
3. `GET /api/health` returns `{ status: "ok" }`.
4. Implement every endpoint in the contract with correct status codes and input
   validation (400 on bad input, 404 on missing resource).

## Required files (the backend template — every backend must match this)

```
backend/
 ├── Dockerfile
 ├── .dockerignore                # MUST list node_modules, dist, .env (see below)
 ├── package.json
 ├── tsconfig.json
 ├── .env.example                 # DATABASE_URL
 ├── prisma/
 │    └── schema.prisma
 └── src/
      ├── app.ts                  # exports the Express app
      ├── server.ts               # app.listen()
      ├── repositories/
      │    ├── interfaces.ts      # repository interface per model
      │    ├── prisma.ts          # Prisma implementations
      │    └── inMemory.ts        # in-memory implementations + factory
      ├── routes/                 # route handlers, one module per resource
      └── __tests__/
           └── *.test.ts          # supertest, boots app with in-memory repo
```

- `package.json` scripts: `build` (`tsc`), `start`, `test` (`jest`), `dev`.
  Include a `prisma` devDependency. A `postinstall`/explicit `prisma generate`
  step is NOT required — the gate runs it.
- Tests boot `app` with the in-memory repo (no live database) and assert every
  endpoint responds with the right status and shape: health, create, list, and
  error cases (400/404).

## Prisma + Docker compatibility (permanent rules — do not deviate)

These rules exist because past runs wasted tokens on `libssl.so.1.1`, OpenSSL
installs, Prisma engine downloads, and repeated `npx prisma generate` retries.
Configuring the project correctly up front makes all of that unnecessary.

### `prisma/schema.prisma` — required exactly

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x", "linux-musl-openssl-3.0.x"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

`binaryTargets` must always include `"native"`, `"debian-openssl-3.0.x"`, and
`"linux-musl-openssl-3.0.x"`. Pin `debian-openssl-3.0.x` **explicitly** — do not
rely on `native` alone: `node:20-bookworm-slim` ships no `openssl` CLI, so during
`prisma generate` Prisma's `native` detection mis-resolves to
`debian-openssl-1.1.x`, and the client then can't find its engine at runtime
(`could not locate the Query Engine for runtime "debian-openssl-3.0.x"`). The
explicit target guarantees the right glibc engine; the musl one covers Alpine.

### Pin Prisma to the v6 line (required)

In `package.json`, pin **both** packages to the classic-schema major:

```json
"dependencies":    { "@prisma/client": "^6" },
"devDependencies": { "prisma": "^6" }
```

Do **not** use `latest` or `^7`. Prisma 7 is a breaking rewrite that rejects the
`datasource { url = env("DATABASE_URL") }` schema and the `prisma-client-js`
generator mandated above (error `P1012` — the URL must move to a
`prisma.config.ts`). An unpinned Prisma silently resolves to v7 and breaks the
whole backend. v6 is the current classic-schema line and is what the sandbox
ships.

### `backend/Dockerfile` — required

- Use a Node image compatible with Prisma engines. **Prefer
  `node:20-bookworm-slim`** for backend containers unless the project genuinely
  requires Alpine.
- If Alpine is used, you **must** explicitly install OpenSSL:
  `RUN apk add --no-cache openssl openssl-dev`.
- **Never blindly retry `prisma generate`.** Run it exactly once in the build.

Reference Dockerfile:

```dockerfile
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma

RUN npx prisma generate

COPY . .

RUN npm run build
```

### `backend/.dockerignore` — REQUIRED (do not skip)

The Dockerfile runs `npx prisma generate` and then `COPY . .`. Without a
`.dockerignore`, `COPY . .` copies the **host's `node_modules`** into the image,
**overwriting the freshly generated Prisma client** with whatever the host had —
typically a stub, which then throws at runtime:

```
Error: @prisma/client did not initialize yet. Please run "prisma generate"…
```

Always emit `backend/.dockerignore` containing at least:

```
node_modules
dist
.env
.git
npm-debug.log
```

This keeps the build hermetic (deps come from the image's own `npm install`, not
the host) and preserves the generated client. It also makes the build context
tiny and avoids shipping host-platform binaries into a Linux image.

## Validation order (run once, after the implementation is complete)

1. `npm install`
2. `npx prisma generate`
3. `npx prisma validate`
4. `npm run build`
5. `npm test`  (with `NODE_ENV=test`, which selects the in-memory repository)

Tests use the in-memory repositories, so **a running PostgreSQL container is not
required for the Jest tests.** Do not start Postgres to run the suite.

### If `npx prisma generate` fails on engine download / network

This is a sandbox/network limitation, not a code failure. Do **not** retry it in
a loop. Instead, in this exact order:

1. Check `binaryTargets` includes `"native"` and `"linux-musl-openssl-3.0.x"`.
2. Check the Docker base image (bookworm-slim, or Alpine with OpenSSL installed).
3. Check `node_modules/.prisma/client` — if it exists, the client is already
   generated and you can proceed.
4. Fix the configuration if any of the above is wrong.
5. Retry **at most once**. If it still fails on the download, treat it as an
   environment limitation and move on — final Prisma generation happens during
   the Docker build. Never spend hundreds of tokens retrying the same command.

The same applies to `npx prisma validate` failing on missing engine binaries:
verify schema syntax and generator config by reading, then move on.

**Forbidden reactions to an engine-download failure** (these waste huge amounts
of tokens and produce worse code):

- Do **not** hand-write your own model types or otherwise stop importing from
  `@prisma/client`. The generated client is the contract; a missing runtime
  engine does not change the types your code compiles against.
- Do **not** switch the generator to the WASM/edge engine, hunt the filesystem
  for engine binaries, or edit the schema to work around the download.
- Do **not** re-run `prisma generate` more than the one allowed retry.

If the engine genuinely cannot be produced, the build (`tsc`) and the in-memory
tests still validate your code — proceed to them. A missing query engine only
affects real database access at runtime, which happens in Docker, not here.

## Rules

- No placeholder code, no TODOs, no stubbed handlers. Every file complete.
- Keep files focused and reasonably small.
- Do not run a real PostgreSQL server; tests use the in-memory repository.
- Do not repeatedly retry identical failed commands. Analyze the error first and
  apply a minimal, targeted fix.
