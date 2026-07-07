import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LocalSandbox } from "../src/core/sandbox.js";

/**
 * Verifies the LocalSandbox path guards: `..` traversal, absolute paths, and
 * symlink escapes are all rejected; ordinary in-workspace paths are allowed.
 */
function expectReject(label: string, fn: () => void): boolean {
  try {
    fn();
    console.log(`FAIL  ${label} (should have thrown)`);
    return false;
  } catch {
    console.log(`PASS  ${label} (rejected)`);
    return true;
  }
}

function expectAllow(label: string, fn: () => void): boolean {
  try {
    fn();
    console.log(`PASS  ${label} (allowed)`);
    return true;
  } catch (e) {
    console.log(`FAIL  ${label}: ${(e as Error).message}`);
    return false;
  }
}

function main() {
  const base = join(tmpdir(), `eus-sandbox-${Date.now()}`);
  const ws = join(base, "runs", "r1", "workspace");
  const secret = join(base, "secret");
  mkdirSync(ws, { recursive: true });
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(secret, "loot.txt"), "top secret", "utf8");

  const sb = new LocalSandbox(ws);
  let ok = true;

  // Allowed: normal nested path.
  ok = expectAllow("nested workspace path", () => sb.resolve("backend/src/index.ts")) && ok;

  // Rejected: parent traversal and absolute paths.
  ok = expectReject("../ traversal", () => sb.resolve("../../secret/loot.txt")) && ok;
  ok = expectReject("absolute path", () => sb.resolve(resolve(secret, "loot.txt"))) && ok;
  ok = expectReject("deep ../ escape", () => sb.resolve("a/b/../../../secret/loot.txt")) && ok;

  // Rejected: symlink inside the workspace pointing outside.
  let symlinkTested = false;
  try {
    symlinkSync(secret, join(ws, "escape"), "dir");
    symlinkTested = true;
  } catch {
    console.log("SKIP  symlink test (could not create symlink on this platform)");
  }
  if (symlinkTested) {
    ok = expectReject("read through symlinked dir", () => sb.resolve("escape/loot.txt")) && ok;
    ok = expectReject("write through symlinked dir", () => sb.resolve("escape/newfile.txt")) && ok;
  }

  rmSync(base, { recursive: true, force: true });
  console.log(ok ? "\n[smoke-sandbox] OK" : "\n[smoke-sandbox] FAILED");
  process.exitCode = ok ? 0 : 1;
}

main();
