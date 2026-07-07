import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, relative, sep, dirname } from "node:path";

/**
 * Execution sandbox. All tool file/shell operations go through a Sandbox so
 * they are confined to one workspace directory and never touch the host at
 * large. Two backends:
 *
 *   - DockerSandbox: each command runs in a throwaway container with the
 *     workspace bind-mounted at /workspace. Preferred when Docker is present.
 *   - LocalSandbox: commands run on the host with cwd pinned to the workspace
 *     and path access constrained to it. Fallback for machines without Docker.
 *
 * Path confinement is enforced in resolve(): a relative path that escapes the
 * workspace root throws before any I/O happens.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process was killed by the timeout. */
  timedOut: boolean;
}

export interface ExecOptions {
  /** Relative subdirectory (within the workspace) to run in. */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface Sandbox {
  readonly kind: "docker" | "local";
  /** Absolute host path to the workspace root. */
  readonly root: string;
  /** Resolve a workspace-relative path to an absolute host path, safely. */
  resolve(relPath: string): string;
  /** Run a shell command inside the sandbox. Never rejects on non-zero exit. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 200_000;

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True if `p` is `root` or a descendant of it (both should be real paths). */
function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Guards a relative path so it cannot escape the workspace root — including via
 * symlinks. Three layers:
 *   1. reject absolute inputs,
 *   2. reject lexical `..` escapes,
 *   3. resolve symlinks (realpath) on the nearest existing ancestor and, if the
 *      target already exists, on the target itself, and require both to stay
 *      inside the real workspace root.
 * Layer 3 is what stops a symlink inside the workspace pointing at /etc from
 * being written or read through.
 */
function confinePath(root: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed inside the sandbox: ${relPath}`);
  }
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel !== "" && (rel.startsWith("..") || rel.split(sep)[0] === "..")) {
    throw new Error(`Path escapes the sandbox workspace: ${relPath}`);
  }

  const realRoot = realpathOrSelf(root);

  // Walk up to the nearest path that actually exists and realpath it. This
  // catches a symlinked parent directory even when the target file is new.
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!isWithin(realRoot, realpathOrSelf(probe))) {
    throw new Error(`Path escapes the sandbox workspace via a symlink: ${relPath}`);
  }

  // If the target itself exists and is a symlink out, reject it too.
  if (existsSync(abs) && !isWithin(realRoot, realpathOrSelf(abs))) {
    throw new Error(`Path resolves outside the sandbox workspace via a symlink: ${relPath}`);
  }

  return abs;
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…[truncated]" : s;
}

// Environment variable names that are safe to pass through to sandboxed
// commands. Everything else is dropped — the process env is NOT inherited.
const ENV_ALLOWLIST = new Set([
  // POSIX
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "TMPDIR",
  "USER",
  "LOGNAME",
  // Windows essentials for node/npm to function
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "SystemDrive",
  "USERNAME",
  "PUBLIC",
  "HOMEDRIVE",
]);

// Names that must never reach a sandboxed command, even via opts.env.
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY)($|_)/i;
const EXPLICIT_STRIP = new Set(["LLM_API_KEY", "LLM_API_BASE", "ELEVATE_LLM"]);

function isSecretName(name: string): boolean {
  return EXPLICIT_STRIP.has(name) || SECRET_NAME.test(name);
}

/**
 * Builds a minimal environment for a locally-spawned command. The host process
 * env is never inherited wholesale: only allowlisted names pass through, HOME
 * is redirected to a scratch dir (so tools can't write into the real home), and
 * the LLM provider key / model config can never be seen by project code.
 * Project-specific vars (e.g. DATABASE_URL) arrive via `extra` and are still
 * filtered for secret-looking names as defense in depth.
 */
export function buildLocalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const scratchHome = resolve(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "elevateurskills-home");
  try {
    mkdirSync(scratchHome, { recursive: true });
  } catch {
    /* best effort */
  }

  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const val = process.env[name];
    if (val !== undefined && !isSecretName(name)) env[name] = val;
  }

  // Redirect HOME to the scratch dir; keep npm's cache there so it persists
  // across runs without touching the real home directory.
  env.HOME = scratchHome;
  env.USERPROFILE = scratchHome;
  env.HOMEPATH = scratchHome;
  env.npm_config_cache = resolve(scratchHome, ".npm");

  for (const [name, val] of Object.entries(extra)) {
    if (isSecretName(name)) continue;
    env[name] = val;
  }
  return env;
}

export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  resolve(relPath: string): string {
    return confinePath(this.root, relPath);
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? this.resolve(opts.cwd) : this.root;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolvePromise) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        // Minimal, secret-free env — the host env is never inherited.
        env: buildLocalEnv(opts.env),
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({
          stdout: clip(stdout),
          stderr: clip(stderr),
          exitCode: code ?? (timedOut ? 124 : 1),
          timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({ stdout: clip(stdout), stderr: clip(stderr + "\n" + err.message), exitCode: 1, timedOut });
      });
    });
  }
}

export interface DockerLimits {
  memory: string; // e.g. "2g"
  cpus: string; // e.g. "2"
  pids: string; // e.g. "512"
}

const DEFAULT_DOCKER_LIMITS: DockerLimits = { memory: "2g", cpus: "2", pids: "512" };

export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly root: string;
  private readonly image: string;
  private readonly limits: DockerLimits;

  constructor(root: string, image: string, limits: DockerLimits = DEFAULT_DOCKER_LIMITS) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.image = image;
    this.limits = limits;
  }

  resolve(relPath: string): string {
    return confinePath(this.root, relPath);
  }

  /**
   * Builds the `docker run` argv. Hardened by default: the workspace is the
   * only mount, all Linux capabilities are dropped, privilege escalation is
   * blocked, memory/CPU/pids are capped, and the host env is never passed —
   * only project vars (with secret-looking names filtered) are injected, so the
   * LLM provider key can never reach project code. Networking uses the default
   * bridge (outbound for npm/prisma) — never the host network namespace.
   */
  buildRunArgs(command: string, opts: ExecOptions, containerName: string): string[] {
    const workdir = opts.cwd ? `/workspace/${opts.cwd.replace(/^\/+/, "")}` : "/workspace";
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (isSecretName(k)) continue;
      envArgs.push("-e", `${k}=${v}`);
    }
    return [
      "run",
      "--rm",
      "--name",
      containerName,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      this.limits.memory,
      "--cpus",
      this.limits.cpus,
      "--pids-limit",
      this.limits.pids,
      "-v",
      `${this.root}:/workspace`,
      "-w",
      workdir,
      ...envArgs,
      this.image,
      "sh",
      "-lc",
      command,
    ];
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const containerName = `eus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = this.buildRunArgs(command, opts, containerName);

    return new Promise((resolvePromise) => {
      const child = spawn("docker", args, { shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the container itself, not just the docker client process.
        try {
          spawnSync("docker", ["kill", containerName], { timeout: 10_000 });
        } catch {
          /* ignore */
        }
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({
          stdout: clip(stdout),
          stderr: clip(stderr),
          exitCode: code ?? (timedOut ? 124 : 1),
          timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({
          stdout: clip(stdout),
          stderr: clip(stderr + "\n" + err.message),
          exitCode: 1,
          timedOut,
        });
      });
    });
  }
}

/** True if a working `docker` CLI is on PATH. */
export function dockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface SandboxOptions {
  /** Force a backend. Defaults to docker when available, else local. */
  backend?: "docker" | "local" | "auto";
  image?: string;
}

const DEFAULT_IMAGE = "elevateurskills-sandbox";

/** The honest local-mode warning shown at startup. */
export const LOCAL_MODE_WARNING = [
  "[sandbox] LOCAL mode — model-generated commands run on THIS machine.",
  "Path writes are confined to the run workspace and a denylist blocks obvious",
  "dangerous commands, but this is NOT real isolation. Use Docker (--backend docker)",
  "for untrusted or unattended runs.",
].join("\n");

/**
 * Resolves the concrete backend without creating the sandbox, so callers can
 * print the active-backend banner (and run the consent gate) before any UI
 * mounts. `auto` picks Docker when the daemon is reachable, else local.
 * Requesting `docker` explicitly with no daemon is an error.
 */
export function resolveBackend(options: SandboxOptions = {}): "docker" | "local" {
  const backend = options.backend ?? "auto";
  if (backend === "docker") {
    if (!dockerAvailable()) {
      throw new Error("Docker backend requested (--backend docker) but the docker daemon is not reachable.");
    }
    return "docker";
  }
  if (backend === "local") return "local";
  return dockerAvailable() ? "docker" : "local";
}

/**
 * Creates the sandbox for the resolved backend. Pass an explicit
 * `backend: "docker" | "local"` (from resolveBackend) so this never re-decides.
 */
export function createSandbox(root: string, options: SandboxOptions = {}): Sandbox {
  const backend = resolveBackend(options);
  return backend === "docker"
    ? new DockerSandbox(root, options.image ?? DEFAULT_IMAGE)
    : new LocalSandbox(root);
}
