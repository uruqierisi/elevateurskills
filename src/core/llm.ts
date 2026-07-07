import { generateText, jsonSchema, tool, type ModelMessage, type LanguageModel } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { loadEnv } from "./env.js";
import { resolveModel, KEY_ENV, type ProviderId, type ResolvedModel } from "./models.js";

/**
 * Provider wrapper. The rest of the codebase talks to LLMs only through this
 * file. It is built on the Vercel AI SDK, which gives identical tool-calling
 * across DeepSeek, OpenAI, and Anthropic — three equal, first-class providers.
 * We keep our own OpenAI-style message/tool types at the boundary and translate
 * to/from the SDK here, so nothing else in the codebase depends on the SDK.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Tool name (on tool-result messages) — needed by the SDK. */
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionParams {
  messages: LlmMessage[];
  tools?: ToolSchema[];
  /** Per-call model override in `provider/model` form. */
  model?: string;
  temperature?: number;
  json?: boolean;
}

export interface CompletionResult {
  message: LlmMessage;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** `provider/model` actually used. */
  model: string;
  /** Provider reasoning text, when exposed. */
  reasoning?: string;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  retries?: number;
}

/** Kept for callers that only need the parsed model identity. */
export function resolveModelId(modelString?: string): ResolvedModel {
  return resolveModel(modelString);
}

/** Reads a provider's API key or throws a message naming the exact env var. */
export function requireKey(provider: ProviderId): string {
  loadEnv();
  const envVar = KEY_ENV[provider];
  const key = (process.env[envVar] ?? "").trim();
  if (!key) {
    throw new Error(`Missing ${envVar}. Set it in your .env to use the "${provider}" provider.`);
  }
  return key;
}

/**
 * Startup preflight: given every model that could run (active + per-agent
 * overrides), assert each referenced provider has its key set. Returns a
 * human-readable error string listing every missing env var, or null if all
 * required keys are present. Callers turn a non-null result into a clean exit.
 */
export function checkKeysForModels(modelStrings: string[]): string | null {
  loadEnv();
  const providers = new Set<ProviderId>();
  for (const m of modelStrings) providers.add(resolveModel(m).provider);
  const missing: string[] = [];
  for (const provider of providers) {
    const envVar = KEY_ENV[provider];
    if (!(process.env[envVar] ?? "").trim()) missing.push(`${envVar} (provider "${provider}")`);
  }
  if (missing.length === 0) return null;
  return `Missing API key(s) for the selected model(s):\n  - ${missing.join("\n  - ")}\nSet the value in your .env, then re-run.`;
}

/** Build an AI SDK model instance for a resolved provider/model. */
function modelInstance({ provider, model }: ResolvedModel): LanguageModel {
  loadEnv();
  const apiKey = requireKey(provider);
  const baseURL = (process.env.LLM_API_BASE ?? "").trim() || undefined;
  switch (provider) {
    case "deepseek":
      return createDeepSeek({ apiKey, baseURL })(model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model);
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(model);
  }
}

/** Translate our OpenAI-style messages into AI SDK ModelMessages. */
function toModelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "system") return { role: "system", content: m.content ?? "" };
    if (m.role === "user") return { role: "user", content: m.content ?? "" };
    if (m.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id ?? "",
            toolName: m.name ?? "tool",
            output: { type: "text", value: m.content ?? "" },
          },
        ],
      };
    }
    // assistant
    if (m.tool_calls && m.tool_calls.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function.name, input });
      }
      return { role: "assistant", content: parts as never };
    }
    return { role: "assistant", content: m.content ?? "" };
  });
}

/** Translate our tool schemas into the SDK's tools record (no execute). */
function toSdkTools(schemas: ToolSchema[]): Record<string, ReturnType<typeof tool>> {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const s of schemas) {
    tools[s.function.name] = tool({
      description: s.function.description,
      inputSchema: jsonSchema(s.function.parameters as Record<string, unknown>),
    });
  }
  return tools;
}

/**
 * One completion. Returns the assistant message (which may contain tool_calls).
 * The AI SDK handles provider-specific tool-call formats, so this is identical
 * for DeepSeek, OpenAI, and Anthropic.
 */
export async function chatCompletion(
  params: CompletionParams,
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const resolved = resolveModel(params.model);
  const model = modelInstance(resolved);
  const hasTools = params.tools && params.tools.length > 0;

  const result = await generateText({
    model,
    messages: toModelMessages(params.messages),
    // Our agents build role:"system" messages inside the messages array; v7
    // rejects those by default, so opt into accepting them.
    allowSystemInMessages: true,
    tools: hasTools ? toSdkTools(params.tools!) : undefined,
    toolChoice: hasTools ? "auto" : undefined,
    temperature: params.temperature ?? 0.2,
    maxRetries: options.retries ?? 2,
    abortSignal: options.signal,
  });

  const toolCalls: ToolCall[] = (result.toolCalls ?? []).map((tc) => ({
    id: tc.toolCallId,
    type: "function",
    function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
  }));

  const usage = result.usage
    ? {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
      }
    : undefined;

  return {
    message: {
      role: "assistant",
      content: result.text || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    finishReason: result.finishReason ?? "stop",
    usage,
    model: `${resolved.provider}/${resolved.model}`,
    reasoning: result.reasoningText || undefined,
  };
}
