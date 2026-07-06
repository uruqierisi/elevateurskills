# Backend

Build the server for the project described by the **frozen contract**
(`architecture.json`), which is injected into your task. You consume the
contract exactly; you never change it.

## Where you work

Everything goes in the `backend/` folder of the workspace. Use `write_file`,
`read_file`, `edit_file`, `list_files`, `run_shell`, and `run_tests`. You are
inside a sandbox — act, observe the output, and fix your own errors.

## Stack

- Node.js + Express + TypeScript
- Prisma ORM targeting PostgreSQL (the production database)
- Jest + supertest for tests

## Non-negotiable architecture

1. **Repository pattern so the server is testable without a live database.**
   - Define a repository interface per model (e.g. `TodoRepository`).
   - `PrismaTodoRepository` — production, talks to PostgreSQL via Prisma.
   - `InMemoryTodoRepository` — used when `DATABASE_URL` is unset or
     `NODE_ENV === "test"`. A factory picks the implementation at startup.
   - Route handlers depend only on the interface.
2. Export the Express `app` separately from the `listen()` call (e.g. `app.ts`
   exports `app`, `server.ts` calls `app.listen`). Tests import `app` directly.
3. `GET /api/health` returns `{ status: "ok" }`.
4. Implement every endpoint in the contract with correct status codes and
   input validation (return 400 on bad input, 404 on missing resource).

## Required files (at minimum)

- `backend/package.json` with scripts: `build` (`tsc`), `start`, `test`
  (`jest`), `dev`. Include a `prisma` devDependency and a `postinstall` or
  explicit `prisma generate` step is NOT required — the gate runs it.
- `backend/tsconfig.json`
- `backend/prisma/schema.prisma` — datasource `postgresql`, generator client,
  models exactly matching the contract.
- `backend/src/app.ts`, `backend/src/server.ts`
- Repository interfaces + Prisma + InMemory implementations
- Route handlers
- `backend/src/__tests__/*.test.ts` — supertest tests that boot `app` (in-memory
  repo) and assert every endpoint responds with the right status and shape,
  including health, create, list, and error cases.
- `backend/.env.example` with `DATABASE_URL`.

## Your validation gate (you are not done until it passes)

The orchestrator runs, in `backend/`:
1. `npm install`
2. `npx prisma generate` and `npx prisma validate`
3. `npm run build`
4. `npm test`

Run these yourself with `run_shell` / `run_tests` and fix everything until they
are all green. Jest must exit 0 with real passing tests. When green, reply with
a short summary of what you built and confirm the gate passed.

## Rules

- No placeholder code, no TODOs, no stubbed handlers. Every file complete.
- Keep files focused and reasonably small.
- Do not run a real PostgreSQL server; tests use the in-memory repository.
