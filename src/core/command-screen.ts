/**
 * Screens a model-generated shell command for the LOCAL sandbox (the container
 * is the boundary in Docker mode, so this is not applied there). It is a
 * best-effort defensive filter, not a security boundary: a denylist refuses
 * obviously host-damaging / exfiltration patterns, an allowlist lets the
 * expected toolchain run without friction, and anything else is "unknown" —
 * requiring an operator confirm interactively, and refused outright under --auto.
 */

export type ScreenAction = "allow" | "deny" | "unknown";

export interface ScreenVerdict {
  action: ScreenAction;
  reason?: string;
}

/** Leading binaries considered part of the expected project toolchain. */
const ALLOW = new Set([
  // JS/TS toolchain
  "node", "npm", "npx", "pnpm", "yarn", "tsc", "tsx", "ts-node", "prisma", "vite",
  "next", "vitest", "jest", "eslint", "prettier", "stylelint", "playwright", "rimraf",
  "cross-env", "git",
  // benign shell builtins / coreutils used inside compound commands
  "cd", "ls", "dir", "echo", "printf", "cat", "type", "pwd", "mkdir", "touch",
  "test", "true", "false", "set", "export", "env", "sleep", "which", "head", "tail",
  "rm", "cp", "mv",
]);

/** Global patterns that are refused regardless of context. */
const DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(sudo|doas)\b/i, reason: "privilege escalation (sudo/doas)" },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, reason: "power/state control" },
  { re: /\bmkfs\b|\bdd\b[^\n]*\bof=/i, reason: "disk/filesystem write" },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby)\b/i, reason: "pipe-download into an interpreter" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?/, reason: "fork bomb" },
  { re: /\bnpm\s+(i|install|add)\b[^\n]*(-g\b|--global\b)/i, reason: "global npm install" },
  { re: /\byarn\s+global\s+add\b/i, reason: "global yarn install" },
  { re: /\bpnpm\s+(add|install|i)\b[^\n]*(-g\b|--global\b)/i, reason: "global pnpm install" },
  { re: /\b(pip|pip3)\s+install\b/i, reason: "pip install (outside the Node toolchain / no venv)" },
];

const DANGEROUS_TARGET = /^(\/|~|\$HOME|\$\{HOME\})/; // absolute, home, or env-home

function isDangerousArg(arg: string): boolean {
  const a = arg.replace(/^["']|["']$/g, "");
  if (a === "/" || a === "~" || a === "$HOME" || a === "*" || a === "/*") return true;
  if (DANGEROUS_TARGET.test(a)) return true;
  if (a.includes("..")) return true; // any parent-traversal target
  return false;
}

/** Split a compound command into segments on shell control operators. */
function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip leading `FOO=bar` env assignments; return the remaining tokens. */
function tokenize(segment: string): string[] {
  const withoutEnv = segment.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)+/, "");
  const tokens = withoutEnv.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens;
}

function baseBinary(token: string): string {
  const clean = token.replace(/^["']|["']$/g, "");
  const parts = clean.split(/[\\/]/);
  return (parts[parts.length - 1] || clean).toLowerCase();
}

/** Check redirects that write outside the working directory. */
function hasUnsafeRedirect(command: string): boolean {
  const re = /(?:^|\s)\d*>>?\s*("?)(\/[^\s"]*|~[^\s"]*|\$HOME[^\s"]*|\.\.[^\s"]*)/g;
  return re.test(command);
}

/** Analyse an `rm`/`chmod`/`chown` segment for dangerous targets. */
function screenDangerousUtil(bin: string, tokens: string[]): ScreenVerdict | null {
  if (bin === "rm") {
    const flags = tokens.filter((t) => t.startsWith("-")).join("");
    const recursiveForce = /r/.test(flags) && /f/.test(flags);
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
    const danger = targets.some(isDangerousArg);
    if (recursiveForce && danger) return { action: "deny", reason: "recursive force-remove outside the workspace" };
    if (danger) return { action: "deny", reason: "remove targeting a path outside the workspace" };
  }
  if (bin === "chmod" || bin === "chown") {
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
    if (targets.some(isDangerousArg)) return { action: "deny", reason: `${bin} on a path outside the workspace` };
  }
  return null;
}

export function screenCommand(command: string): ScreenVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { action: "deny", reason: "empty command" };

  for (const { re, reason } of DENY_PATTERNS) {
    if (re.test(trimmed)) return { action: "deny", reason };
  }
  if (hasUnsafeRedirect(trimmed)) {
    return { action: "deny", reason: "redirect writes outside the working directory" };
  }

  const segments = splitSegments(trimmed);
  let sawUnknown = false;
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const bin = baseBinary(tokens[0]);

    const dangerous = screenDangerousUtil(bin, tokens);
    if (dangerous) return dangerous;

    if (!ALLOW.has(bin)) sawUnknown = true;
  }

  return sawUnknown ? { action: "unknown", reason: "command is not on the toolchain allowlist" } : { action: "allow" };
}
