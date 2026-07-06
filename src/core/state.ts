import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StateAccess } from "./tools/index.js";

/**
 * Per-run state, persisted to disk so a crashed or checkpointed run resumes
 * from the last completed stage. Layout:
 *
 *   runs/<run-id>/
 *     manifest.json      stage statuses + shared KV
 *     plan.json          planner output
 *     architecture.json  frozen contract
 *     workspace/         the generated project
 *     log/<agent>.log    per-agent transcript
 */

export type StageName =
  | "planner"
  | "architect"
  | "scaffold"
  | "backend"
  | "frontend"
  | "qa"
  | "reviewer"
  | "devops";

export type StageStatus = "pending" | "in_progress" | "done" | "failed";

export interface StageRecord {
  status: StageStatus;
  attempts: number;
  updatedAt: string;
  note?: string;
}

export interface RunManifest {
  id: string;
  request: string;
  stack: string;
  createdAt: string;
  updatedAt: string;
  stages: Partial<Record<StageName, StageRecord>>;
  shared: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Generates a readable, sortable run id. */
export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export class RunState {
  readonly dir: string;
  readonly workspaceDir: string;
  readonly logDir: string;
  private readonly manifestPath: string;
  manifest: RunManifest;

  private constructor(dir: string, manifest: RunManifest) {
    this.dir = dir;
    this.workspaceDir = join(dir, "workspace");
    this.logDir = join(dir, "log");
    this.manifestPath = join(dir, "manifest.json");
    this.manifest = manifest;
    mkdirSync(this.workspaceDir, { recursive: true });
    mkdirSync(this.logDir, { recursive: true });
  }

  static create(runsRoot: string, opts: { request: string; stack: string; id?: string }): RunState {
    const id = opts.id ?? newRunId();
    const dir = resolve(runsRoot, id);
    mkdirSync(dir, { recursive: true });
    const manifest: RunManifest = {
      id,
      request: opts.request,
      stack: opts.stack,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stages: {},
      shared: {},
    };
    const state = new RunState(dir, manifest);
    state.save();
    return state;
  }

  static load(dir: string): RunState {
    const abs = resolve(dir);
    const manifestPath = join(abs, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`No manifest.json in ${abs} — not a resumable run directory.`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
    return new RunState(abs, manifest);
  }

  /** Load if the directory exists and is a run, else create fresh. */
  static openOrCreate(runsRoot: string, opts: { request: string; stack: string; id?: string }): RunState {
    if (opts.id) {
      const dir = resolve(runsRoot, opts.id);
      if (existsSync(join(dir, "manifest.json"))) return RunState.load(dir);
    }
    return RunState.create(runsRoot, opts);
  }

  save(): void {
    this.manifest.updatedAt = nowIso();
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), "utf8");
  }

  getStage(name: StageName): StageRecord {
    return this.manifest.stages[name] ?? { status: "pending", attempts: 0, updatedAt: nowIso() };
  }

  setStage(name: StageName, status: StageStatus, note?: string): void {
    const prev = this.manifest.stages[name];
    this.manifest.stages[name] = {
      status,
      attempts: prev?.attempts ?? 0,
      updatedAt: nowIso(),
      note,
    };
    this.save();
  }

  incrementAttempt(name: StageName): number {
    const prev = this.getStage(name);
    const attempts = prev.attempts + 1;
    this.manifest.stages[name] = { ...prev, attempts, status: "in_progress", updatedAt: nowIso() };
    this.save();
    return attempts;
  }

  isDone(name: StageName): boolean {
    return this.getStage(name).status === "done";
  }

  /** StateAccess handed to read_state/write_state tools. */
  stateAccess(): StateAccess {
    return {
      read: (key?: string) => (key ? this.manifest.shared[key] : this.manifest.shared),
      write: (key: string, value: unknown) => {
        this.manifest.shared[key] = value;
        this.save();
      },
    };
  }

  /** Path to a top-level run artifact like plan.json / architecture.json. */
  artifactPath(name: string): string {
    return join(this.dir, name);
  }

  hasArtifact(name: string): boolean {
    return existsSync(this.artifactPath(name));
  }

  readArtifact<T = unknown>(name: string): T {
    return JSON.parse(readFileSync(this.artifactPath(name), "utf8")) as T;
  }

  readArtifactText(name: string): string {
    return readFileSync(this.artifactPath(name), "utf8");
  }

  writeArtifact(name: string, value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    writeFileSync(this.artifactPath(name), text, "utf8");
  }

  logPath(agent: string): string {
    return join(this.logDir, `${agent}.log`);
  }

  appendLog(agent: string, line: string): void {
    appendFileSync(this.logPath(agent), line.endsWith("\n") ? line : line + "\n", "utf8");
  }
}
