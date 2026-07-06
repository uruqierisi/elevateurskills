import { existsSync, copyFileSync } from "node:fs";
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

/** Loads env then asserts a usable API key is present. */
export function requireApiKey(): string {
  loadEnv();
  const key = (process.env.LLM_API_KEY ?? "").trim();
  if (!key) {
    console.error(
      [
        "",
        "[env] LLM_API_KEY is empty.",
        `      Open ${ENV_PATH} and paste your DeepSeek API key on the line:`,
        "",
        "        LLM_API_KEY=sk-...",
        "",
        "      Then run the command again.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  return key;
}
