import { chatCompletion, type LlmMessage } from "./llm.js";
import { toolSchemas, type Tool, type ToolContext } from "./tools/index.js";

/**
 * The agent loop. This is the heart of the system: an act -> observe -> correct
 * cycle. The model is given tools and a task; it calls tools, sees their real
 * output (including errors), and keeps going until it stops requesting tools or
 * hits the iteration cap. It is not a one-shot prompt.
 */

export interface AgentEvent {
  type: "assistant" | "tool_call" | "tool_result" | "error" | "thinking" | "usage";
  text: string;
  toolName?: string;
  /** Present on "usage" events. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Present on "usage" events: the concrete model id. */
  model?: string;
}

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
  temperature?: number;
  onEvent?: (e: AgentEvent) => void;
  /** Pull operator steer/instruction lines to inject before the next call. */
  drainSteers?: () => string[];
  /** Cooperative stop: when set, the agent finishes the current step and exits. */
  control?: RunControl;
}

export interface AgentRunResult {
  finalText: string;
  iterations: number;
  transcript: LlmMessage[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const DEFAULT_MAX_ITERATIONS = 40;

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { system, task, tools, ctx, model, temperature } = opts;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const emit = opts.onEvent ?? (() => {});
  const byName = new Map(tools.map((t) => [t.name, t]));

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  let iterations = 0;
  while (iterations < maxIterations) {
    if (opts.control?.stopRequested) {
      emit({ type: "assistant", text: "(stopped by operator)" });
      break;
    }
    iterations++;

    // Inject any operator steering as a user message before the next call.
    const steers = opts.drainSteers?.() ?? [];
    if (steers.length > 0) {
      messages.push({ role: "user", content: `Operator steering — follow this now:\n${steers.join("\n")}` });
    }

    const res = await chatCompletion({
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

    // Provider reasoning (when exposed) surfaces as a Thinking block.
    if (res.reasoning && res.reasoning.trim()) emit({ type: "thinking", text: res.reasoning });

    const assistant = res.message;
    messages.push(assistant);
    if (assistant.content) emit({ type: "assistant", text: assistant.content });

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tools requested -> the model's message is its final report.
      return { finalText: assistant.content ?? "", iterations, transcript: messages, usage };
    }

    // Execute every requested tool call and feed results back.
    for (const call of toolCalls) {
      const tool = byName.get(call.function.name);
      let resultText: string;
      if (!tool) {
        resultText = `Error: unknown tool "${call.function.name}".`;
        emit({ type: "error", text: resultText, toolName: call.function.name });
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          resultText = `Error: tool arguments were not valid JSON: ${call.function.arguments}`;
          emit({ type: "error", text: resultText, toolName: call.function.name });
          messages.push(toolMessage(call.id, resultText));
          continue;
        }
        emit({ type: "tool_call", text: JSON.stringify(args).slice(0, 500), toolName: tool.name });
        try {
          const r = await tool.execute(args, ctx);
          resultText = r.content;
          emit({ type: "tool_result", text: `${r.ok ? "ok" : "FAIL"}: ${truncate(r.content)}`, toolName: tool.name });
        } catch (err) {
          resultText = `Error executing ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
          emit({ type: "error", text: resultText, toolName: tool.name });
        }
      }
      messages.push(toolMessage(call.id, resultText));
    }
  }

  // Hit the iteration cap. Return whatever the last assistant text was.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return {
    finalText: lastAssistant?.content ?? `(stopped after ${maxIterations} iterations)`,
    iterations,
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
