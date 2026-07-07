import { chatCompletion, type LlmMessage, type CompletionParams, type CompletionResult } from "./llm.js";
import { toolSchemas, type Tool, type ToolContext } from "./tools/index.js";
import { SandboxInfraError } from "./sandbox.js";

/**
 * The agent loop. This is the heart of the system: an act -> observe -> correct
 * cycle. The model is given tools and a task; it calls tools, sees their real
 * output (including errors), and keeps going until it stops requesting tools or
 * a limit halts it. It is not a one-shot prompt.
 *
 * A circuit breaker keeps a stuck agent from spinning forever: hard token and
 * tool-call budgets (with an 80% warning), plus spin detection that nudges the
 * model when it repeats a failing command or racks up consecutive failures.
 */

export interface AgentEvent {
  type: "assistant" | "tool_call" | "tool_result" | "error" | "thinking" | "usage" | "budget";
  text: string;
  toolName?: string;
  /** Present on "usage" events. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Present on "usage" events: the concrete model id. */
  model?: string;
  /** Present on "budget" events: live budget consumption vs the caps. */
  budget?: AgentBudget;
}

/** Live budget consumption for an agent, emitted so the UI can show a meter. */
export interface AgentBudget {
  tokens: number;
  maxTokens: number;
  toolCalls: number;
  maxToolCalls: number;
}

/** Why the agent loop stopped. */
export type StopReason =
  | "completed" // model finished (no more tool calls)
  | "max-iterations" // hit the per-agent loop-turn cap
  | "budget-exceeded" // hit the token budget
  | "iteration-limit" // hit the tool-call budget
  | "stopped"; // operator ctrl-q / esc

/** Cooperative cancellation flag set by the UI (ctrl-q / esc). */
export interface RunControl {
  stopRequested: boolean;
}

export interface RunAgentOptions {
  system: string;
  task: string;
  tools: Tool[];
  ctx: ToolContext;
  /** Per-agent model override in `provider/model` form. */
  model?: string;
  maxIterations?: number;
  /** Token budget (prompt + completion) for the whole agent. */
  maxTokens?: number;
  /** Tool-call budget for the whole agent. */
  maxToolCalls?: number;
  temperature?: number;
  onEvent?: (e: AgentEvent) => void;
  /** Pull operator steer/instruction lines to inject before the next call. */
  drainSteers?: () => string[];
  /** Cooperative stop: when set, the agent finishes the current step and exits. */
  control?: RunControl;
  /** Test seam: override the completion function (defaults to chatCompletion). */
  complete?: (params: CompletionParams) => Promise<CompletionResult>;
}

export interface AgentRunResult {
  finalText: string;
  iterations: number;
  toolCalls: number;
  stopReason: StopReason;
  transcript: LlmMessage[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const DEFAULT_MAX_ITERATIONS = 40;
export const DEFAULT_MAX_AGENT_TOKENS = 500_000;
export const DEFAULT_MAX_AGENT_TOOL_CALLS = 50;

// Circuit-breaker nudges injected as a [system] user message before the next call.
const WARN_TOKENS_80 = "You are at 80% of your token budget. Wrap up or simplify your approach.";
const WARN_CALLS_80 = "You are at 80% of your tool-call budget. Wrap up or simplify your approach.";
const WARN_SPIN_REPEAT =
  "You have tried this command 3 times with the same result. This is likely an environment issue, not a code issue. Move on or report the blocker.";
const WARN_SPIN_FAILURES =
  "Multiple consecutive failures. Stop, assess whether this is an environment problem, and report if you cannot proceed.";

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { system, task, tools, ctx, model, temperature } = opts;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_AGENT_TOKENS;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_AGENT_TOOL_CALLS;
  const emit = opts.onEvent ?? (() => {});
  const complete = opts.complete ?? chatCompletion;
  const byName = new Map(tools.map((t) => [t.name, t]));

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  // Circuit-breaker state.
  let toolCalls = 0;
  let warned80Tokens = false;
  let warned80Calls = false;
  let consecutiveShellFailures = 0; // reset by any successful run_shell
  let warnedConsecutive = false;
  let lastShellCmd: string | null = null;
  let lastShellErr: string | null = null;
  let sameCmdErrStreak = 0; // consecutive identical (command, error) run_shell
  let warnedSpin = false;
  const injections: string[] = []; // pending [system] nudges

  const emitBudget = (): void =>
    emit({ type: "budget", text: "", budget: { tokens: usage.totalTokens, maxTokens, toolCalls, maxToolCalls } });

  let iterations = 0;
  let stopReason: StopReason = "max-iterations";
  emitBudget();

  while (iterations < maxIterations) {
    if (opts.control?.stopRequested) {
      emit({ type: "assistant", text: "(stopped by operator)" });
      stopReason = "stopped";
      break;
    }

    // Circuit breaker — hard halts before spending another call.
    if (usage.totalTokens >= maxTokens) {
      stopReason = "budget-exceeded";
      break;
    }
    if (toolCalls >= maxToolCalls) {
      stopReason = "iteration-limit";
      break;
    }
    // 80% warnings, once each.
    if (!warned80Tokens && usage.totalTokens >= maxTokens * 0.8) {
      injections.push(WARN_TOKENS_80);
      warned80Tokens = true;
    }
    if (!warned80Calls && toolCalls >= maxToolCalls * 0.8) {
      injections.push(WARN_CALLS_80);
      warned80Calls = true;
    }

    iterations++;

    // Inject any operator steering, then any circuit-breaker nudges, before the call.
    const steers = opts.drainSteers?.() ?? [];
    if (steers.length > 0) {
      messages.push({ role: "user", content: `Operator steering — follow this now:\n${steers.join("\n")}` });
    }
    if (injections.length > 0) {
      messages.push({ role: "user", content: `[system] ${injections.join("\n")}` });
      injections.length = 0;
    }

    const res = await complete({
      messages,
      tools: tools.length ? toolSchemas(tools) : undefined,
      model,
      temperature,
    });
    if (res.usage) {
      usage.promptTokens += res.usage.promptTokens;
      usage.completionTokens += res.usage.completionTokens;
      usage.totalTokens += res.usage.totalTokens;
      // Emit per-call usage so the UI's usage box updates live after each call.
      emit({ type: "usage", text: "", usage: res.usage, model: res.model });
    }
    emitBudget();

    // Provider reasoning (when exposed) surfaces as a Thinking block.
    if (res.reasoning && res.reasoning.trim()) emit({ type: "thinking", text: res.reasoning });

    const assistant = res.message;
    messages.push(assistant);
    if (assistant.content) emit({ type: "assistant", text: assistant.content });

    const toolCallsThisTurn = assistant.tool_calls ?? [];
    if (toolCallsThisTurn.length === 0) {
      // No tools requested -> the model's message is its final report.
      return {
        finalText: assistant.content ?? "",
        iterations,
        toolCalls,
        stopReason: "completed",
        transcript: messages,
        usage,
      };
    }

    // Execute every requested tool call and feed results back.
    for (const call of toolCallsThisTurn) {
      const tool = byName.get(call.function.name);
      let resultText: string;
      let ok = false;
      let parsedArgs: Record<string, unknown> = {};
      if (!tool) {
        resultText = `Error: unknown tool "${call.function.name}".`;
        emit({ type: "error", text: resultText, toolName: call.function.name });
      } else {
        try {
          parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          resultText = `Error: tool arguments were not valid JSON: ${call.function.arguments}`;
          emit({ type: "error", text: resultText, toolName: call.function.name });
          messages.push(toolMessage(call.id, resultText));
          continue;
        }
        emit({ type: "tool_call", text: JSON.stringify(parsedArgs).slice(0, 500), toolName: tool.name });
        try {
          const r = await tool.execute(parsedArgs, ctx);
          resultText = r.content;
          ok = r.ok;
          emit({ type: "tool_result", text: `${r.ok ? "ok" : "FAIL"}: ${truncate(r.content)}`, toolName: tool.name });
        } catch (err) {
          // A sandbox infrastructure failure is not the agent's fault — let it
          // propagate to halt the run instead of feeding it back as a tool
          // result the model would fruitlessly try to "fix".
          if (err instanceof SandboxInfraError) throw err;
          resultText = `Error executing ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
          emit({ type: "error", text: resultText, toolName: tool.name });
        }
      }
      toolCalls++;

      // Spin detection: watch run_shell for the same failing command repeated,
      // or a run of consecutive failures — both signal a stuck, not a coding,
      // problem. The nudge is delivered before the next model call.
      if (tool?.name === "run_shell") {
        if (ok) {
          consecutiveShellFailures = 0;
          warnedConsecutive = false;
          sameCmdErrStreak = 0;
          warnedSpin = false;
          lastShellCmd = normalizeCmd(parsedArgs.command);
          lastShellErr = null;
        } else {
          consecutiveShellFailures++;
          const cmd = normalizeCmd(parsedArgs.command);
          const errSig = firstLine(resultText).slice(0, 120);
          if (cmd === lastShellCmd && errSig === lastShellErr) {
            sameCmdErrStreak++;
          } else {
            sameCmdErrStreak = 1;
            warnedSpin = false;
          }
          lastShellCmd = cmd;
          lastShellErr = errSig;
          if (sameCmdErrStreak >= 3 && !warnedSpin) {
            injections.push(WARN_SPIN_REPEAT);
            warnedSpin = true;
          }
          if (consecutiveShellFailures >= 5 && !warnedConsecutive) {
            injections.push(WARN_SPIN_FAILURES);
            warnedConsecutive = true;
          }
        }
      }

      messages.push(toolMessage(call.id, resultText));
    }
    emitBudget();
  }

  // Hit a loop-turn cap or a circuit-breaker halt. Return the last assistant text.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return {
    finalText: lastAssistant?.content ?? `(stopped: ${stopReason} after ${iterations} iteration(s))`,
    iterations,
    toolCalls,
    stopReason,
    transcript: messages,
    usage,
  };
}

function toolMessage(toolCallId: string, content: string): LlmMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Normalise a shell command for equality checks (collapse whitespace). */
function normalizeCmd(command: unknown): string {
  return typeof command === "string" ? command.trim().replace(/\s+/g, " ") : "";
}

/** First non-empty line of a string. */
function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
