import { join } from "node:path";
import { runAgent } from "./loop.js";
import {
  createSandbox,
  resolveBackend,
  ensureSandboxImage,
  DockerPostgres,
  LocalSandbox,
  SandboxInfraError,
  type Sandbox,
  type SandboxOptions,
} from "./sandbox.js";
import { RunState, type StageName } from "./state.js";
import { AGENTS, PIPELINE, agentSystemPrompt, type AgentDef, type GateResult } from "./agents.js";
import { scaffoldWorkspace } from "./scaffold.js";
import { resolveModelId } from "./llm.js";
import { AGENT_MODEL_DEFAULTS } from "./models.js";
import { resolvePlan, type ProjectPlan, type PlanOverrides } from "./profile.js";
import { EventBus, type CheckpointDecision, type BudgetReason } from "./events.js";
import { DEFAULT_MAX_AGENT_TOKENS, DEFAULT_MAX_AGENT_TOOL_CALLS, type RunControl } from "./loop.js";
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
  /** Per-agent token budget (circuit breaker). Falls back to the loop default. */
  maxAgentTokens?: number;
  /** Per-agent tool-call budget (circuit breaker). Falls back to the loop default. */
  maxAgentToolCalls?: number;
  sandbox?: SandboxOptions;
  /** Operator consented to run model commands on the host (local sandbox exec). */
  localConsent?: boolean;
  /** CLI overrides for the adaptive plan (--profile / --agents / backend toggles). */
  planOverrides?: PlanOverrides;
  models?: Record<string, string>;
  /** Structured event sink. Renderers subscribe to this. */
  bus: EventBus;
  /** Pull operator steer lines submitted via the UI input box. */
  drainSteers?: () => string[];
  /** Cooperative stop flag toggled by the UI (ctrl-q / esc). */
  control?: RunControl;
  /** Ask the operator to approve a non-allowlisted command (interactive only). */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Resolves a paused checkpoint. Provided by whichever renderer is active
   * (TUI keypress or plain readline). Omitted => behave as "continue".
   */
  checkpoint?: (info: {
    stage: string;
    gate: GateResult;
    state: RunState;
    artifactPaths: string[];
    /** Present when the pause is a circuit-breaker halt, not a normal checkpoint. */
    budget?: BudgetInfo;
  }) => Promise<CheckpointDecision>;
}

/** Per-stage circuit-breaker consumption, for checkpoints and the final summary. */
export interface BudgetInfo {
  reason: BudgetReason;
  tokens: number;
  maxTokens: number;
  toolCalls: number;
  maxToolCalls: number;
}

export interface StageUsage {
  tokens: number;
  toolCalls: number;
}

export interface OrchestratorResult {
  state: RunState;
  completed: string[];
  /** Agents the chosen profile skipped (never spawned). */
  skipped: string[];
  /** The resolved profile, once the contract was classified. */
  profile?: string;
  stoppedAt?: string;
  aborted: boolean;
  /** Set when the run halted on a sandbox/environment failure, not a gate. */
  infra?: { message: string; hint: string };
  /** Token + tool-call usage per stage, for the final summary. */
  usageByStage: Record<string, StageUsage>;
}

/** The builder-mode stages, in pipeline order (the ones a profile can skip). */
function builderStages(): string[] {
  return (PIPELINE as string[]).filter((s) => AGENTS[s]?.mode === "builder");
}

/**
 * Resolve and build the execution sandbox on demand. For Docker: resolve the
 * daemon, build/verify the image (streamed to the transcript), and return a
 * DockerSandbox. For local: require operator consent (host command execution).
 * Any failure becomes an environment error (resumable), never a gate failure.
 */
function activateSandbox(
  bus: EventBus,
  state: RunState,
  opts: OrchestratorOptions,
  stageName: string,
  needsDatabase: boolean,
): { sandbox: Sandbox; postgres: DockerPostgres | null } | { infra: { message: string; hint: string } } {
  const progress = (summary: string) => bus.emit({ type: "stage:progress", stage: stageName, tool: "sandbox", summary });
  try {
    const backend = resolveBackend({ backend: opts.sandbox?.backend });
    if (backend === "docker") {
      const { tag, built } = ensureSandboxImage(progress);
      progress(`docker ok · image ${tag} ${built ? "built" : "ready"}`);
      // A contract with a database gets a throwaway Postgres sidecar so Prisma
      // can migrate against a live DB; the sandbox reaches it by container name
      // on a per-run network. Best-effort — a failed sidecar falls back to the
      // placeholder DATABASE_URL createSandbox injects.
      let postgres: DockerPostgres | null = null;
      const net: { network?: string; defaultEnv?: Record<string, string> } = {};
      if (needsDatabase) {
        postgres = new DockerPostgres(state.manifest.id);
        const handle = postgres.start((l) => {
          state.appendLog("orchestrator", l);
          progress(l);
        });
        if (handle) {
          net.network = handle.network;
          net.defaultEnv = { DATABASE_URL: handle.databaseUrl };
        } else {
          postgres = null; // start() already cleaned up; use the placeholder URL.
        }
      }
      return { sandbox: createSandbox(state.workspaceDir, { backend: "docker", image: tag, ...net }), postgres };
    }
    // Local execution runs model-generated commands on the host — require consent.
    if (!opts.localConsent) {
      const infra = {
        message: "This run needs to run commands on the host (local sandbox), but consent was not given.",
        hint: "Re-run with --i-understand-local, or install Docker and use --backend docker.",
      };
      bus.emit({ type: "env:error", stage: stageName, ...infra });
      return { infra };
    }
    return { sandbox: createSandbox(state.workspaceDir, { backend: "local" }), postgres: null };
  } catch (err) {
    // resolveBackend throws when --backend docker is forced but the daemon is
    // down; ensureSandboxImage throws SandboxInfraError on a build failure.
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      err instanceof SandboxInfraError
        ? err.hint
        : "Install/start Docker, or use --backend local with --i-understand-local.";
    bus.emit({ type: "env:error", stage: stageName, message, hint });
    return { infra: { message, hint } };
  }
}

/** Read architecture.json defensively (the gate already validated it). */
function readArchSafe(state: RunState): unknown {
  try {
    return state.readArtifact("architecture.json");
  } catch {
    return {};
  }
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

  // The sandbox is LAZY. Planner and Architect produce JSON and never execute
  // commands, so we start with a Docker-free local sandbox (file writes stay
  // confined to the workspace). The real execution sandbox — and, for Docker,
  // the image build/preflight and the Postgres sidecar — is activated only
  // before the first builder that actually runs, and only when the profile
  // needs it. That is what lets a static site build with no Docker at all.
  let sandbox: Sandbox = new LocalSandbox(state.workspaceDir);
  let sandboxActivated = false;
  let postgres: DockerPostgres | null = null;
  let plan: ProjectPlan | null = null;
  // A forced --profile is shared with the Architect so its contract matches the
  // profile the operator chose (not just which agents run).
  if (opts.planOverrides?.profile) state.stateAccess().write("forcedProfile", opts.planOverrides.profile);

  const { provider, model } = resolveModelId();
  const modelStr = `${provider}/${model}`;

  // Resolve + announce the adaptive plan the moment the frozen contract exists.
  // Called both before the Architect's checkpoint (so it can show the plan) and
  // at the top of each later iteration (so skip decisions have it). Idempotent.
  const ensurePlan = (current: ProjectPlan | null): ProjectPlan | null => {
    if (current !== null || !state.hasArtifact("architecture.json")) return current;
    const resolved = resolvePlan(readArchSafe(state), opts.planOverrides ?? {});
    const skipped = builderStages().filter((s) => !resolved.requiredAgents.includes(s));
    bus.emit({ type: "run:plan", profile: resolved.profile, requiredAgents: resolved.requiredAgents, skipped, needsSandbox: resolved.needsSandbox });
    return resolved;
  };

  bus.emit({ type: "run:start", runId: state.manifest.id, request: state.manifest.request, stack: state.manifest.stack, model: modelStr });

  const scope = opts.only ?? (PIPELINE as StageName[]);
  const completed: string[] = [];
  const skippedStages: string[] = [];
  const usageByStage: Record<string, StageUsage> = {};
  const recordUsage = (stage: string, u: Usage, toolCalls: number): void => {
    const prev = usageByStage[stage] ?? { tokens: 0, toolCalls: 0 };
    usageByStage[stage] = { tokens: prev.tokens + u.totalTokens, toolCalls: prev.toolCalls + toolCalls };
  };
  // Build a result, reading `plan`/`completed`/etc. lazily so the profile and
  // skipped set are always current at the moment of return.
  const result = (extra: Partial<OrchestratorResult>): OrchestratorResult => ({
    state,
    completed,
    skipped: skippedStages,
    profile: plan?.profile,
    aborted: false,
    usageByStage,
    ...extra,
  });

  // Base circuit-breaker limits; a budget "retry" doubles them for the re-run.
  const baseTokens = opts.maxAgentTokens ?? DEFAULT_MAX_AGENT_TOKENS;
  const baseToolCalls = opts.maxAgentToolCalls ?? DEFAULT_MAX_AGENT_TOOL_CALLS;

  try {
    for (const stageName of PIPELINE as StageName[]) {
      if (!scope.includes(stageName)) continue;

      const def = AGENTS[stageName];

      // Resolve the adaptive plan the moment the frozen contract is available.
      plan = ensurePlan(plan);

      // Skip a builder agent the profile does not need: never spawned, no gate.
      if (plan && def.mode === "builder" && !plan.requiredAgents.includes(stageName)) {
        if (!skippedStages.includes(stageName)) skippedStages.push(stageName);
        state.setStage(stageName, "skipped", `skipped: ${plan.profile}`);
        bus.emit({ type: "stage:skipped", stage: stageName, reason: plan.profile });
        continue;
      }

      // Deterministic scaffold happens once, before the first builder that runs.
      if (def.mode === "builder" && !state.isDone("scaffold")) {
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

      // Activate the execution sandbox lazily: only before the first builder that
      // actually runs, and only when the profile needs command execution. Docker's
      // image build/preflight + the Postgres sidecar happen here — never for
      // planner/architect, and never for a no-build static site.
      if (plan?.needsSandbox && def.mode === "builder" && !sandboxActivated) {
        const activated = activateSandbox(bus, state, opts, stageName, !!plan.needsDatabase);
        if ("infra" in activated) {
          return result({ stoppedAt: stageName, aborted: true, infra: activated.infra });
        }
        sandbox = activated.sandbox;
        postgres = activated.postgres;
        sandboxActivated = true;
      }

      let decision: CheckpointDecision = "continue";
      let limitScale = 1; // doubled each time the operator retries a budget halt

      do {
        const startedAt = Date.now();
        let gate: GateResult;
        let usage: Usage;
        let toolCalls: number;
        let budget: BudgetInfo | undefined;
        try {
          ({ gate, usage, toolCalls, budget } = await runStageWithRetries(def, state, sandbox, opts, {
            maxTokens: Math.round(baseTokens * limitScale),
            maxToolCalls: Math.round(baseToolCalls * limitScale),
          }));
        } catch (err) {
          if (err instanceof SandboxInfraError) {
            // Environment failure, not a code/gate failure. Leave the stage
            // resumable (do NOT mark it failed) so it retries once the sandbox is
            // fixed, and report it as an environment error.
            bus.emit({ type: "env:error", stage: stageName, message: err.message, hint: err.hint });
            return result({ stoppedAt: stageName, aborted: true, infra: { message: err.message, hint: err.hint } });
          }
          throw err;
        }
        recordUsage(stageName, usage, toolCalls);

        // Operator asked to stop (ctrl-q / esc): unwind cleanly as aborted.
        if (opts.control?.stopRequested) {
          state.setStage(stageName, "failed", "stopped by operator");
          bus.emit({ type: "run:error", stage: stageName, error: "stopped by operator" });
          return result({ stoppedAt: stageName, aborted: true });
        }

        // Circuit breaker fired: the agent hit its token or tool-call budget. Its
        // partial work is already on disk. Do NOT run the gate — offer the
        // operator continue-with-partial / retry-with-higher-limit / quit.
        if (budget) {
          state.setStage(stageName, "failed", `${budget.reason}: ${budget.tokens} tok, ${budget.toolCalls} calls`);
          bus.emit({
            type: "stage:budget",
            stage: stageName,
            reason: budget.reason,
            tokens: budget.tokens,
            maxTokens: budget.maxTokens,
            toolCalls: budget.toolCalls,
            maxToolCalls: budget.maxToolCalls,
          });
          if (opts.auto || !opts.checkpoint) {
            // No operator to decide — halt cleanly and leave the stage resumable.
            return result({ stoppedAt: stageName, aborted: true });
          }
          const artifactPaths = artifactPathsFor(state, stageName);
          bus.emit({ type: "checkpoint:await", stage: stageName, artifactPaths });
          const d = await opts.checkpoint({ stage: stageName, gate, state, artifactPaths, budget });
          if (d === "quit") return result({ stoppedAt: stageName, aborted: true });
          if (d === "retry") {
            limitScale *= 2; // retry the stage with a higher budget
            decision = "retry";
            continue;
          }
          // "continue": accept the partial work and move to the next stage.
          state.setStage(stageName, "done", `${budget.reason} — continued with partial work`);
          bus.emit({
            type: "stage:done",
            stage: stageName,
            durationMs: Date.now() - startedAt,
            artifacts: artifactPathsFor(state, stageName),
            tokens: usage.totalTokens,
          });
          completed.push(stageName);
          break;
        }

        bus.emit({ type: "stage:gate", stage: stageName, passed: gate.pass, detail: gate.detail });

        if (!gate.pass) {
          state.setStage(stageName, "failed", gate.detail.slice(0, 500));
          bus.emit({ type: "run:error", stage: stageName, error: gate.detail });
          return result({ stoppedAt: stageName, aborted: true });
        }

        state.setStage(stageName, "done", gate.detail.slice(0, 500));
        bus.emit({
          type: "stage:done",
          stage: stageName,
          durationMs: Date.now() - startedAt,
          artifacts: artifactPathsFor(state, stageName),
          tokens: usage.totalTokens,
        });
        emitTodo(bus, state, [...completed, stageName]);
        // Classify + announce the plan now (e.g. right after the Architect) so the
        // checkpoint below can show which agents run/skip and whether Docker is used.
        plan = ensurePlan(plan);

        if (opts.stopAfter && stageName === opts.stopAfter) {
          completed.push(stageName);
          return result({ stoppedAt: stageName, aborted: false });
        }

        decision = "continue";
        if (!opts.auto && opts.checkpoint) {
          const artifactPaths = artifactPathsFor(state, stageName);
          bus.emit({ type: "checkpoint:await", stage: stageName, artifactPaths });
          decision = await opts.checkpoint({ stage: stageName, gate, state, artifactPaths });
          if (decision === "quit") {
            return result({ stoppedAt: stageName, aborted: true });
          }
          // "retry" re-runs this stage's agent (e.g. the contract needs redoing).
        }
        if (decision !== "retry") completed.push(stageName);
      } while (decision === "retry");
    }

    bus.emit({
      type: "run:done",
      runId: state.manifest.id,
      workspacePath: state.workspaceDir,
      summary: `${completed.length} stage(s) completed: ${completed.join(", ")}`,
    });
    return result({ aborted: false });
  } finally {
    // Always tear down the Postgres sidecar (and its network) if one was started.
    postgres?.stop();
  }
}

interface PlanTask {
  title?: string;
  area?: string;
}

/** Maps a plan task's `area` to the pipeline stage that owns it. */
function areaToStage(area?: string): string | undefined {
  switch ((area ?? "").toLowerCase()) {
    case "backend":
      return "backend";
    case "frontend":
      return "frontend";
    case "infra":
      return "devops";
    default:
      return undefined; // shared/unknown: not auto-completed
  }
}

/**
 * Emits the plan checklist as an agent:todo event, marking a task done when the
 * pipeline stage that owns its area has completed. Derived purely from
 * plan.json — the UI never reaches into planner internals.
 */
function emitTodo(bus: EventBus, state: RunState, completed: string[]): void {
  if (!state.hasArtifact("plan.json")) return;
  let plan: { tasks?: PlanTask[] };
  try {
    plan = state.readArtifact("plan.json");
  } catch {
    return;
  }
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (tasks.length === 0) return;
  const items = tasks.map((t) => {
    const stage = areaToStage(t.area);
    return { text: t.title ?? "task", done: stage ? completed.includes(stage) : false };
  });
  bus.emit({ type: "agent:todo", stage: "planner", items });
}

/** The inspectable artifacts a stage produced (absolute paths). */
function artifactPathsFor(state: RunState, stage: string): string[] {
  const def = AGENTS[stage];
  if (def?.mode === "contract" && def.artifact && state.hasArtifact(def.artifact)) {
    return [state.artifactPath(def.artifact)];
  }
  return [state.workspaceDir];
}

interface StageLimits {
  maxTokens: number;
  maxToolCalls: number;
}

interface StageRunResult {
  gate: GateResult;
  usage: Usage;
  toolCalls: number;
  /** Present when the circuit breaker halted the agent (not a gate outcome). */
  budget?: BudgetInfo;
}

/** Runs one stage, re-spawning on gate failure with the failure appended. */
async function runStageWithRetries(
  def: AgentDef,
  state: RunState,
  sandbox: Sandbox,
  opts: OrchestratorOptions,
  limits: StageLimits,
): Promise<StageRunResult> {
  const { bus } = opts;
  // Per-agent model override: an explicit --model wins; otherwise a built-in
  // per-agent default (which may point at a different provider) applies; else
  // undefined => the loop falls back to the active ELEVATE_LLM. Each model's
  // key is resolved from its own provider inside llm.ts, so an agent can run
  // on a different provider than the rest of the pipeline.
  const model = opts.models?.[def.name] ?? AGENT_MODEL_DEFAULTS[def.name];
  let lastGate: GateResult = { pass: false, detail: "not run" };
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let toolCallsTotal = 0;
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
      auto: opts.auto,
      confirm: opts.confirm,
    };

    const task = def.buildTask(state) + extraContext;
    const result = await runAgent({
      system: agentSystemPrompt(def.roleFile),
      task,
      tools: selectTools(def.tools),
      ctx,
      model,
      maxIterations: def.maxIterations,
      maxTokens: limits.maxTokens,
      maxToolCalls: limits.maxToolCalls,
      drainSteers: opts.drainSteers,
      control: opts.control,
      onEvent: (e) => {
        // Full, untruncated transcript to disk regardless of renderer.
        state.appendLog(def.name, `[${e.type}]${e.toolName ? ` ${e.toolName}` : ""} ${e.text}`);
        // Structured, truncatable event to the bus for live rendering.
        if (e.type === "assistant" && e.text) {
          bus.emit({ type: "agent:token", stage: def.name, text: e.text });
        } else if (e.type === "thinking" && e.text) {
          bus.emit({ type: "agent:thinking", stage: def.name, text: e.text });
        } else if (e.type === "usage" && e.usage) {
          bus.emit({ type: "usage", model: e.model ?? "", ...e.usage });
        } else if (e.type === "budget" && e.budget) {
          bus.emit({
            type: "agent:budget",
            stage: def.name,
            tokens: e.budget.tokens,
            maxTokens: e.budget.maxTokens,
            toolCalls: e.budget.toolCalls,
            maxToolCalls: e.budget.maxToolCalls,
          });
        } else if (e.type === "tool_call") {
          // Only the call becomes a transcript line (⚙ tool args); the result
          // still goes to the disk log above, keeping the feed uncluttered.
          bus.emit({ type: "stage:progress", stage: def.name, tool: e.toolName ?? "tool", summary: e.text });
        } else if (e.type === "error") {
          bus.emit({ type: "stage:progress", stage: def.name, tool: e.toolName ?? "error", summary: e.text });
        }
      },
    });
    accumulate(usage, result.usage);
    toolCallsTotal += result.toolCalls;
    state.appendLog(def.name, `\n=== FINAL (attempt ${attempt}) ===\n${result.finalText}\n`);

    // Operator stop: don't run the gate or retry — hand control back to unwind.
    if (opts.control?.stopRequested) {
      return { gate: { pass: false, detail: "stopped by operator" }, usage, toolCalls: toolCallsTotal };
    }

    // Circuit breaker halted the agent (token or tool-call budget). This is not
    // a gate outcome and not retryable here — surface it so the orchestrator can
    // present the budget checkpoint.
    if (result.stopReason === "budget-exceeded" || result.stopReason === "iteration-limit") {
      return {
        gate: { pass: false, detail: `agent halted: ${result.stopReason}` },
        usage,
        toolCalls: toolCallsTotal,
        budget: {
          reason: result.stopReason,
          tokens: usage.totalTokens,
          maxTokens: limits.maxTokens,
          toolCalls: toolCallsTotal,
          maxToolCalls: limits.maxToolCalls,
        },
      };
    }

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
    if (lastGate.pass) return { gate: lastGate, usage, toolCalls: toolCallsTotal };

    emitRecoverable(bus, def.name, attempt, opts.maxAttempts, lastGate.detail);
    extraContext = failureContext(lastGate.detail);
  }
  return { gate: lastGate, usage, toolCalls: toolCallsTotal };
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
