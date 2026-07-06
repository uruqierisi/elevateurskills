import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./state.js";
import type { Sandbox } from "./sandbox.js";

/**
 * Deterministic scaffold: creates the folder skeleton declared in the frozen
 * contract plus a workspace .gitignore, so the builder agents drop files into a
 * consistent layout. This is intentionally dumb — no code, just structure.
 */
export function scaffoldWorkspace(state: RunState, sandbox: Sandbox): void {
  const arch = state.readArtifact<{ folders?: string[] }>("architecture.json");
  const folders = Array.isArray(arch.folders) && arch.folders.length ? arch.folders : ["backend/src", "frontend/src"];

  for (const folder of folders) {
    mkdirSync(sandbox.resolve(folder), { recursive: true });
  }

  const gitignore = ["node_modules/", "dist/", "build/", ".env", "*.log", ".DS_Store", ""].join("\n");
  writeFileSync(join(sandbox.root, ".gitignore"), gitignore, "utf8");
}
