# Frontend

Build the UI for the project described by the **frozen contract**
(`architecture.json`), injected into your task. You consume the contract's API
endpoints exactly; you never change it.

## Where you work

Everything goes in the `frontend/` folder of the workspace. Use the file and
shell tools. Act, observe, fix your own errors.

## Stack

- React + Vite + TypeScript
- A small typed API client generated from the contract's endpoints
- `fetch` to the backend `baseUrl` (configurable via `VITE_API_URL`, default
  `http://localhost:3000`)

## Requirements

- A typed `api.ts` client with one function per contract endpoint.
- Components that exercise the primary flow (e.g. list items, create an item,
  toggle/delete where the contract supports it).
- Sensible loading and error states — no unhandled promise rejections.
- `frontend/.env.example` with `VITE_API_URL`.

## Your validation gate (not done until it passes)

The orchestrator runs, in `frontend/`:
1. `npm install`
2. `npm run build` (Vite production build must succeed)

Run these yourself and fix until green. If Playwright is available you may use
`browser_check` against the dev server for an extra smoke check, but the build
passing is the gate. When green, reply with a short summary and confirm.

## Rules

- No placeholder components, no TODOs. Every file complete and typed.
- Match the contract's request/response shapes exactly.
- Keep components focused and small.
