import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, relative, sep, dirname } from "node:path";
import { createHash } from "node:crypto";
import { REPO_ROOT } from "./env.js";

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

/**
 * A sandbox-level (infrastructure) failure — the Docker daemon is unreachable,
 * the image is missing, a mount/permission failed, etc. This is NOT the agent's
 * code failing its gate: it means the environment could not run the command at
 * all. It propagates out of the agent loop to halt the run cleanly (the stage is
 * left resumable, not marked failed) so we never blame generated code for a
 * broken sandbox.
 */
export class SandboxInfraError extends Error {
  /** A short, actionable hint on how to fix the environment. */
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "SandboxInfraError";
    this.hint = hint;
  }
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

/** First non-empty line of a string (for compact error messages). */
function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
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

    return new Promise((resolvePromise, rejectPromise) => {
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
        const exitCode = code ?? (timedOut ? 124 : 1);
        // A daemon-level failure (missing image, unreachable daemon, bad mount)
        // is NOT the command failing — it means the sandbox could not run it.
        // Reject so it propagates as an infra halt instead of being fed back to
        // the agent as if its code were wrong.
        if (!timedOut && isDockerInfraFailure(exitCode, stderr)) {
          rejectPromise(
            new SandboxInfraError(
              `Docker could not run the sandbox command (exit ${exitCode}): ${firstLine(stderr) || "daemon/image error"}`,
              `Ensure the Docker daemon is running and the sandbox image is built (preflight builds it: ${this.image}).`,
            ),
          );
          return;
        }
        resolvePromise({
          stdout: clip(stdout),
          stderr: clip(stderr),
          exitCode,
          timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        // The docker client itself failed to launch — the environment is broken.
        rejectPromise(
          new SandboxInfraError(
            `Could not launch docker: ${err.message}`,
            "Is the Docker CLI installed and on PATH, with the daemon running?",
          ),
        );
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

/**
 * The sandbox image is OUR image — it is built locally from sandbox/Dockerfile,
 * never pulled from a registry. Its tag embeds a hash of the Dockerfile, so:
 *   - the tag is stable across runs → repeat runs reuse the cached image,
 *   - any change to sandbox/Dockerfile changes the tag → forces a rebuild.
 * That makes `docker image inspect <tag>` both the existence check and the
 * cache-freshness check in one, with no separate state to store.
 */
const IMAGE_REPO = "elevateurskills-sandbox";
const SANDBOX_DIR = resolve(REPO_ROOT, "sandbox");
const DOCKERFILE_PATH = resolve(SANDBOX_DIR, "Dockerfile");

/** The content-addressed image tag for the current Dockerfile. */
export function sandboxImageTag(dockerfilePath: string = DOCKERFILE_PATH): string {
  const src = readFileSync(dockerfilePath, "utf8");
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 12);
  return `${IMAGE_REPO}:${hash}`;
}

/** True if an image with this exact tag already exists locally (no pull). */
function imageExistsLocally(tag: string): boolean {
  try {
    const r = spawnSync("docker", ["image", "inspect", tag], { timeout: 10_000, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface EnsureImageResult {
  tag: string;
  built: boolean;
}

/**
 * Ensures the sandbox image exists locally, building it from sandbox/Dockerfile
 * if missing. Never issues a `docker pull` for our tag — a run must never fall
 * into a registry pull. Build output is streamed to `onLog`. Throws a
 * SandboxInfraError (not a generic Error) on any failure so callers can present
 * an environment-level message.
 */
export function ensureSandboxImage(onLog: (line: string) => void = () => {}): EnsureImageResult {
  const tag = sandboxImageTag();
  if (imageExistsLocally(tag)) return { tag, built: false };

  onLog(`[sandbox] building image ${tag} from ${relative(REPO_ROOT, DOCKERFILE_PATH)} …`);
  // Build from the sandbox/ context; the Dockerfile has no COPY/ADD, so the
  // context is minimal. `--pull` here refreshes only the *base* image
  // (node:20-bookworm-slim) — it never pulls our own tag.
  const r = spawnSync("docker", ["build", "-t", tag, "-f", DOCKERFILE_PATH, SANDBOX_DIR], {
    encoding: "utf8",
    timeout: 20 * 60_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) for (const l of out.split("\n")) onLog(l);

  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `docker build exited ${r.status}`;
    throw new SandboxInfraError(
      `Failed to build the sandbox image ${tag}: ${why}`,
      `Check the Docker daemon and sandbox/Dockerfile, then re-run. You can also build it manually:\n  docker build -t ${tag} -f ${DOCKERFILE_PATH} ${SANDBOX_DIR}`,
    );
  }
  if (!imageExistsLocally(tag)) {
    throw new SandboxInfraError(
      `Sandbox image ${tag} was not present after a successful build.`,
      `Try building it manually: docker build -t ${tag} -f ${DOCKERFILE_PATH} ${SANDBOX_DIR}`,
    );
  }
  return { tag, built: true };
}

/**
 * Recognises Docker/daemon-level failures in a `docker run` result. Exit 125
 * means the daemon rejected the run (missing image, bad mount, daemon error) —
 * distinct from a non-zero exit of the *command inside* the container. The
 * stderr patterns catch the same class when the exit code is ambiguous.
 */
function isDockerInfraFailure(exitCode: number, stderr: string): boolean {
  if (exitCode === 125) return true;
  return /(Cannot connect to the Docker daemon|no such image|manifest unknown|pull access denied|failed to (resolve|mount)|invalid mount|error during connect|repository does not exist)/i.test(
    stderr,
  );
}

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
  // Default to the content-addressed tag the preflight built/verified, so the
  // container runs the exact image we ensured — never an untagged name that
  // `docker run` would try to pull.
  return backend === "docker"
    ? new DockerSandbox(root, options.image ?? sandboxImageTag())
    : new LocalSandbox(root);
}
