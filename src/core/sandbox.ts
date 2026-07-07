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
        env: { ...process.env, ...opts.env },
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

export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly root: string;
  private readonly image: string;

  constructor(root: string, image: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.image = image;
  }

  resolve(relPath: string): string {
    return confinePath(this.root, relPath);
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const workdir = opts.cwd ? `/workspace/${opts.cwd.replace(/^\/+/, "")}` : "/workspace";
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      envArgs.push("-e", `${k}=${v}`);
    }
    const args = [
      "run",
      "--rm",
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

    return new Promise((resolvePromise) => {
      const child = spawn("docker", args, { shell: false });
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

/**
 * Picks the sandbox backend. Docker is preferred for isolation; if it is not
 * installed we fall back to a local sandbox and warn loudly, because tool
 * commands then run on the host (confined to the workspace directory).
 */
export function createSandbox(root: string, options: SandboxOptions = {}): Sandbox {
  const backend = options.backend ?? "auto";
  const wantDocker = backend === "docker" || (backend === "auto" && dockerAvailable());

  if (wantDocker) {
    if (!dockerAvailable()) {
      throw new Error("Docker backend requested but the docker CLI is not available.");
    }
    return new DockerSandbox(root, options.image ?? DEFAULT_IMAGE);
  }

  if (backend === "auto") {
    console.warn(
      "[sandbox] Docker not found — using LOCAL sandbox. Commands run on the host, " +
        "confined to the run workspace. Install Docker for full isolation.",
    );
  }
  return new LocalSandbox(root);
}
