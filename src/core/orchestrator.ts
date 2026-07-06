import { runAgent, type AgentEvent } from "./loop.js";
import { createSandbox, type Sandbox, type SandboxOptions } from "./sandbox.js";
import { RunState, type StageName } from "./state.js";
import { AGENTS, PIPELINE, agentSystemPrompt, type AgentDef, type GateResult } from "./agents.js";
import { scaffoldWorkspace } from "./scaffold.js";
import type { ToolContext } from "./tools/index.js";
import { selectTools } from "./tools/index.js";

/**
 * The orchestrator. Owns run state, drives the pipeline stage by stage, gates
 * each stage on its validation, re-spawns a failed agent with its failure
 * output, and (unless --auto) pauses at a checkpoint between stages so a human
 * can inspect artifacts — most importantly the frozen contract.
 */

export interface OrchestratorOptions {
  request: string;
  stack: string;
  runsRoot: string;
  auto: boolean;
  resumeId?: string;
  /** Stop after this stage (inclusive). Useful for incremental runs. */
  stopAfter?: StageName;
  /** Run only these stages (still respecting dependencies already satisfied). */
  only?: StageName[];
  maxAttempts: number;
  sandbox?: SandboxOptions;
  /** Per-agent model overrides, keyed by agent name. */
  models?: Record<string, string>;
  /**
   * Called after each stage passes its gate. Return "abort" to stop the run.
   * Omitted / auto mode => always continue.
   */
  checkpoint?: (info: { stage: string; gate: GateResult; state: RunState }) => Promise<"continue" | "abort">;
  onEvent?: (stage: string, e: AgentEvent) => void;
  log?: (msg: string) => void;
}

export interface OrchestratorResult {
  state: RunState;
  completed: string[];
  stoppedAt?: string;
  aborted: boolean;
}

export async function orchestrate(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const state = RunState.openOrCreate(opts.runsRoot, {
    request: opts.request,
    stack: opts.stack,
    id: opts.resumeId,
  });
  const sandbox = createSandbox(state.workspaceDir, opts.sandbox);

  log(`\n▶ run ${state.manifest.id}`);
  log(`  request: ${state.manifest.request}`);
  log(`  stack:   ${state.manifest.stack}`);
  log(`  sandbox: ${sandbox.kind} (${sandbox.root})`);

  const scope = opts.only ?? (PIPELINE as StageName[]);
  const completed: string[] = [];

  for (const stageName of PIPELINE as StageName[]) {
    if (!scope.includes(stageName)) continue;

    // Deterministic scaffold happens once, right after the contract is frozen.
    if (stageName === "backend" && !state.isDone("scaffold")) {
      log(`\n■ scaffold`);
      scaffoldWorkspace(state, sandbox);
      state.setStage("scaffold", "done");
      log(`  scaffold: workspace folders created from contract`);
    }

    if (state.isDone(stageName)) {
      log(`\n■ ${stageName}: already done (resumed) — skipping`);
      completed.push(stageName);
      continue;
    }

    const def = AGENTS[stageName];
    const gate = await runStageWithRetries(def, state, sandbox, opts, log);
    if (!gate.pass) {
      log(`\n✖ ${stageName} did not pass its gate after ${opts.maxAttempts} attempt(s).`);
      log(gate.detail);
      state.setStage(stageName, "failed", gate.detail.slice(0, 500));
      return { state, completed, stoppedAt: stageName, aborted: true };
    }

    state.setStage(stageName, "done", gate.detail.slice(0, 500));
    completed.push(stageName);
    log(`\n✔ ${stageName} passed: ${gate.detail.split("\n")[0]}`);

    if (opts.stopAfter && stageName === opts.stopAfter) {
      log(`\n⏹ stopping after ${stageName} (--stop-after)`);
      return { state, completed, stoppedAt: stageName, aborted: false };
    }

    if (!opts.auto && opts.checkpoint) {
      const decision = await opts.checkpoint({ stage: stageName, gate, state });
      if (decision === "abort") {
        log(`\n⏹ aborted at checkpoint after ${stageName}`);
        return { state, completed, stoppedAt: stageName, aborted: true };
      }
    }
  }

  log(`\n✅ pipeline complete. Project at: ${state.workspaceDir}`);
  return { state, completed, aborted: false };
}

/** Runs one stage, re-spawning on gate failure with the failure appended. */
async function runStageWithRetries(
  def: AgentDef,
  state: RunState,
  sandbox: Sandbox,
  opts: OrchestratorOptions,
  log: (m: string) => void,
): Promise<GateResult> {
  const model = opts.models?.[def.name];
  let lastGate: GateResult = { pass: false, detail: "not run" };
  let extraContext = "";

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const n = state.incrementAttempt(def.name as StageName);
    log(`\n■ ${def.name} (attempt ${attempt}/${opts.maxAttempts}, total ${n})${model ? ` [model=${model}]` : ""}`);

    const ctx: ToolContext = {
      sandbox,
      state: state.stateAccess(),
      log: (m) => {
        state.appendLog(def.name, `[tool] ${m}`);
      },
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
        state.appendLog(def.name, `[${e.type}]${e.toolName ? ` ${e.toolName}` : ""} ${e.text}`);
        opts.onEvent?.(def.name, e);
      },
    });
    state.appendLog(def.name, `\n=== FINAL (attempt ${attempt}) ===\n${result.finalText}\n`);

    // Contract agents emit JSON as their final message; persist it as an artifact.
    if (def.mode === "contract" && def.artifact) {
      const parsed = extractJson(result.finalText);
      if (parsed === undefined) {
        lastGate = { pass: false, detail: "Agent did not return a parseable JSON object." };
      } else {
        state.writeArtifact(def.artifact, parsed);
      }
    }

    lastGate = await def.gate({ state, sandbox, log: (m) => log(`  ${m}`) });
    if (lastGate.pass) return lastGate;

    log(`  gate failed: ${lastGate.detail.split("\n")[0]}`);
    extraContext =
      `\n\n--- PREVIOUS ATTEMPT FAILED ITS VALIDATION GATE ---\n` +
      `Fix these problems and try again:\n${lastGate.detail.slice(0, 6000)}\n`;
  }
  return lastGate;
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
  // Walk braces to find the matching close, ignoring braces inside strings.
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
