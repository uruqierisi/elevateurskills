import { join } from "node:path";
import { runAgent } from "./loop.js";
import { createSandbox, type Sandbox, type SandboxOptions } from "./sandbox.js";
import { RunState, type StageName } from "./state.js";
import { AGENTS, PIPELINE, agentSystemPrompt, type AgentDef, type GateResult } from "./agents.js";
import { scaffoldWorkspace } from "./scaffold.js";
import { resolveModelId } from "./llm.js";
import { EventBus, type CheckpointDecision } from "./events.js";
import type { ToolContext } from "./tools/index.js";
import { selectTools } from "./tools/index.js";

/**
 * The orchestrator. Owns run state, drives the pipeline stage by stage, gates
 * each stage on its validation, re-spawns a failed agent with its failure
 * output, and (unless --auto) pauses at a checkpoint between stages.
 *
 * It talks to the outside world ONLY by emitting structured events on the bus
 * (see events.ts) and by writing full transcripts to runs/<id>/log/. It never
 * prints to the console or knows anything about a UI. That decoupling is the
 * whole point: renderers subscribe; logic emits.
 */

export interface OrchestratorOptions {
  request: string;
  stack: string;
  runsRoot: string;
  auto: boolean;
  resumeId?: string;
  stopAfter?: StageName;
  only?: StageName[];
  maxAttempts: number;
  sandbox?: SandboxOptions;
  models?: Record<string, string>;
  /** Structured event sink. Renderers subscribe to this. */
  bus: EventBus;
  /**
   * Resolves a paused checkpoint. Provided by whichever renderer is active
   * (TUI keypress or plain readline). Omitted => behave as "continue".
   */
  checkpoint?: (info: { stage: string; gate: GateResult; state: RunState; artifactPaths: string[] }) => Promise<CheckpointDecision>;
}

export interface OrchestratorResult {
  state: RunState;
  completed: string[];
  stoppedAt?: string;
  aborted: boolean;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export async function orchestrate(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const { bus } = opts;
  const state = RunState.openOrCreate(opts.runsRoot, {
    request: opts.request,
    stack: opts.stack,
    id: opts.resumeId,
  });
  const sandbox = createSandbox(state.workspaceDir, opts.sandbox);
  const { provider, model } = resolveModelId();
  const modelStr = `${provider}/${model}`;

  bus.emit({ type: "run:start", runId: state.manifest.id, request: state.manifest.request, stack: state.manifest.stack, model: modelStr });

  const scope = opts.only ?? (PIPELINE as StageName[]);
  const completed: string[] = [];

  for (const stageName of PIPELINE as StageName[]) {
    if (!scope.includes(stageName)) continue;

    // Deterministic scaffold happens once, right after the contract is frozen.
    if (stageName === "backend" && !state.isDone("scaffold")) {
      scaffoldWorkspace(state, sandbox);
      state.setStage("scaffold", "done");
    }

    if (state.isDone(stageName)) {
      // Resumed: surface it as an instantly-complete stage so the UI shows it.
      bus.emit({ type: "stage:start", stage: stageName, agent: stageName });
      bus.emit({ type: "stage:done", stage: stageName, durationMs: 0, artifacts: artifactPathsFor(state, stageName) });
      completed.push(stageName);
      continue;
    }

    const def = AGENTS[stageName];
    let decision: CheckpointDecision = "continue";

    do {
      const startedAt = Date.now();
      const { gate, usage } = await runStageWithRetries(def, state, sandbox, opts);

      bus.emit({ type: "stage:gate", stage: stageName, passed: gate.pass, detail: gate.detail });

      if (!gate.pass) {
        state.setStage(stageName, "failed", gate.detail.slice(0, 500));
        bus.emit({ type: "run:error", stage: stageName, error: gate.detail });
        return { state, completed, stoppedAt: stageName, aborted: true };
      }

      state.setStage(stageName, "done", gate.detail.slice(0, 500));
      bus.emit({
        type: "stage:done",
        stage: stageName,
        durationMs: Date.now() - startedAt,
        artifacts: artifactPathsFor(state, stageName),
        tokens: usage.totalTokens,
      });

      if (opts.stopAfter && stageName === opts.stopAfter) {
        completed.push(stageName);
        return { state, completed, stoppedAt: stageName, aborted: false };
      }

      decision = "continue";
      if (!opts.auto && opts.checkpoint) {
        const artifactPaths = artifactPathsFor(state, stageName);
        bus.emit({ type: "checkpoint:await", stage: stageName, artifactPaths });
        decision = await opts.checkpoint({ stage: stageName, gate, state, artifactPaths });
        if (decision === "quit") {
          return { state, completed, stoppedAt: stageName, aborted: true };
        }
        // "retry" re-runs this stage's agent (e.g. the contract needs redoing).
      }
    } while (decision === "retry");

    completed.push(stageName);
  }

  bus.emit({
    type: "run:done",
    runId: state.manifest.id,
    workspacePath: state.workspaceDir,
    summary: `${completed.length} stage(s) completed: ${completed.join(", ")}`,
  });
  return { state, completed, aborted: false };
}

/** The inspectable artifacts a stage produced (absolute paths). */
function artifactPathsFor(state: RunState, stage: string): string[] {
  const def = AGENTS[stage];
  if (def?.mode === "contract" && def.artifact && state.hasArtifact(def.artifact)) {
    return [state.artifactPath(def.artifact)];
  }
  return [state.workspaceDir];
}

/** Runs one stage, re-spawning on gate failure with the failure appended. */
async function runStageWithRetries(
  def: AgentDef,
  state: RunState,
  sandbox: Sandbox,
  opts: OrchestratorOptions,
): Promise<{ gate: GateResult; usage: Usage }> {
  const { bus } = opts;
  const model = opts.models?.[def.name];
  let lastGate: GateResult = { pass: false, detail: "not run" };
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let extraContext = "";

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    state.incrementAttempt(def.name as StageName);
    // A fresh stage:start per attempt resets the stage to running and clears
    // any prior error, so a retry visibly re-enters the running state.
    bus.emit({ type: "stage:start", stage: def.name, agent: def.name });
    if (attempt > 1) {
      bus.emit({ type: "stage:progress", stage: def.name, tool: "retry", summary: `attempt ${attempt}/${opts.maxAttempts}` });
    }

    const ctx: ToolContext = {
      sandbox,
      state: state.stateAccess(),
      log: (m) => state.appendLog(def.name, `[tool] ${m}`),
    };

    const task = def.buildTask(state) + extraContext;
    const result = await runAgent({
      system: agentSystemPrompt(def.roleFile),
      task,
      tools: selectTools(def.tools),
      ctx,
      model,
      maxIterations: def.maxIterations,
      onEvent: (e) => {
        // Full, untruncated transcript to disk regardless of renderer.
        state.appendLog(def.name, `[${e.type}]${e.toolName ? ` ${e.toolName}` : ""} ${e.text}`);
        // Structured, truncatable event to the bus for live rendering.
        if (e.type === "assistant" && e.text) {
          bus.emit({ type: "agent:token", stage: def.name, text: e.text });
        } else if (e.type === "tool_call" || e.type === "tool_result") {
          bus.emit({ type: "stage:progress", stage: def.name, tool: e.toolName ?? "tool", summary: e.text });
        } else if (e.type === "error") {
          bus.emit({ type: "stage:progress", stage: def.name, tool: e.toolName ?? "error", summary: e.text });
        }
      },
    });
    accumulate(usage, result.usage);
    state.appendLog(def.name, `\n=== FINAL (attempt ${attempt}) ===\n${result.finalText}\n`);

    // Contract agents emit JSON as their final message; persist it as an artifact.
    if (def.mode === "contract" && def.artifact) {
      const parsed = extractJson(result.finalText);
      if (parsed === undefined) {
        lastGate = { pass: false, detail: "Agent did not return a parseable JSON object." };
        emitRecoverable(bus, def.name, attempt, opts.maxAttempts, lastGate.detail);
        extraContext = failureContext(lastGate.detail);
        continue;
      }
      state.writeArtifact(def.artifact, parsed);
    }

    lastGate = await def.gate({
      state,
      sandbox,
      log: (m) => bus.emit({ type: "stage:progress", stage: def.name, tool: "gate", summary: m }),
    });
    if (lastGate.pass) return { gate: lastGate, usage };

    emitRecoverable(bus, def.name, attempt, opts.maxAttempts, lastGate.detail);
    extraContext = failureContext(lastGate.detail);
  }
  return { gate: lastGate, usage };
}

/**
 * A gate failure with attempts remaining is recoverable: surface it as a
 * run:error (the UI shows it red and notes the re-spawn) but don't stop. When
 * attempts are exhausted, the caller emits the terminal run:error instead.
 */
function emitRecoverable(bus: EventBus, stage: string, attempt: number, maxAttempts: number, detail: string): void {
  if (attempt < maxAttempts) {
    bus.emit({ type: "run:error", stage, error: detail });
  }
}

function failureContext(detail: string): string {
  return (
    `\n\n--- PREVIOUS ATTEMPT FAILED ITS VALIDATION GATE ---\n` +
    `Fix these problems and try again:\n${detail.slice(0, 6000)}\n`
  );
}

function accumulate(target: Usage, add: Usage): void {
  target.promptTokens += add.promptTokens;
  target.completionTokens += add.completionTokens;
  target.totalTokens += add.totalTokens;
}

/**
 * Extracts a JSON object from a model's final message: handles ```json fences,
 * surrounding prose, and returns the first balanced {...} object.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
