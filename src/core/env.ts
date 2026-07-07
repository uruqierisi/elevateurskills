import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved relative to this file (src/core/env.ts -> ../../). */
export const REPO_ROOT = resolve(__dirname, "..", "..");

const ENV_PATH = resolve(REPO_ROOT, ".env");
const ENV_EXAMPLE_PATH = resolve(REPO_ROOT, ".env.example");

let loaded = false;

/**
 * Loads the single `.env` at the repo root. On first run, if `.env` is missing
 * it is created from `.env.example` so the user only ever edits one file.
 * Exits with a clear, actionable message when the API key line is still empty.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  if (!existsSync(ENV_PATH)) {
    if (existsSync(ENV_EXAMPLE_PATH)) {
      copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      console.log(`[env] Created .env from .env.example at ${ENV_PATH}`);
    } else {
      console.error(`[env] Missing both .env and .env.example at ${REPO_ROOT}`);
      process.exit(1);
    }
  }

  dotenv.config({ path: ENV_PATH });
}

/** Reads the package version from the repo/package root; safe fallback. */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Per-provider API keys are resolved in llm.ts (requireKey) based on the
// selected provider — there is no single global key any more.
