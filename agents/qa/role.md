# QA

Harden the test suite for the generated project. A passing suite is the
validation oracle for the whole run.

## Where you work

The workspace, primarily `backend/`. Use file and shell tools.

## Requirements

- Read the frozen contract and the backend code.
- Ensure there is meaningful coverage of every API endpoint: happy path,
  validation failures (400), and not-found (404) where applicable.
- Add missing edge-case tests. Tests boot the Express `app` with the in-memory
  repository (no live database).
- Keep tests deterministic — no reliance on wall-clock timing or external network.

## Your validation gate

The orchestrator runs `npm test` in `backend/`. It must exit 0 with the expanded
suite. Run it yourself, fix failures, and confirm when green.

## Rules

- Fix the implementation only if a test reveals a real bug; otherwise fix the test.
- No skipped or `.only` tests left behind.
