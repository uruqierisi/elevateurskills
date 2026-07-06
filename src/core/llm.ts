import { loadEnv, requireApiKey } from "./env.js";

/**
 * Provider wrapper. The entire rest of the codebase talks to LLMs only through
 * this file. It speaks the OpenAI-compatible Chat Completions API, which covers
 * DeepSeek (default), OpenAI, most local runtimes (Ollama, LM Studio, vLLM),
 * and any gateway that exposes the same shape.
 *
 * Model is resolved from ELEVATE_LLM in `provider/model` form. The provider
 * segment is informational routing metadata for humans; the actual endpoint is
 * LLM_API_BASE and the key is LLM_API_KEY. This keeps switching providers to a
 * three-line edit in one .env file.
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
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages. */
  tool_call_id?: string;
  /** Optional name (tool messages). */
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionParams {
  messages: LlmMessage[];
  tools?: ToolSchema[];
  /** Per-call model override in `provider/model` form (e.g. "openai/gpt-4o"). */
  model?: string;
  temperature?: number;
  /** Force JSON object output when the provider supports response_format. */
  json?: boolean;
}

export interface CompletionResult {
  message: LlmMessage;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** The concrete model id sent to the provider. */
  model: string;
}

const DEFAULT_MODEL = "deepseek/deepseek-chat";
const DEFAULT_BASE = "https://api.deepseek.com";

/** Splits `provider/model` -> the bare model id the endpoint expects. */
export function resolveModelId(modelString?: string): { provider: string; model: string } {
  const raw = (modelString ?? process.env.ELEVATE_LLM ?? DEFAULT_MODEL).trim();
  const slash = raw.indexOf("/");
  if (slash === -1) {
    // No provider segment; treat the whole string as the model id.
    return { provider: "openai", model: raw };
  }
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

function chatCompletionsUrl(): string {
  loadEnv();
  const base = (process.env.LLM_API_BASE ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

export interface CompletionOptions {
  /** Abort/timeout signal. */
  signal?: AbortSignal;
  /** Retry count for transient network / 429 / 5xx errors. */
  retries?: number;
}

/**
 * One chat completion. Throws on non-retryable HTTP errors after exhausting
 * retries. Returns the assistant message (which may contain tool_calls).
 */
export async function chatCompletion(
  params: CompletionParams,
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const apiKey = requireApiKey();
  const { model } = resolveModelId(params.model);
  const url = chatCompletionsUrl();
  const retries = options.retries ?? 2;

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    temperature: params.temperature ?? 0.2,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = "auto";
  }
  if (params.json) {
    body.response_format = { type: "json_object" };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Retry transient statuses; fail fast on client errors like 400/401.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`LLM request failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
      }

      const data = (await res.json()) as OpenAiResponse;
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`LLM response had no choices: ${JSON.stringify(data).slice(0, 500)}`);

      return {
        message: {
          role: "assistant",
          content: choice.message.content ?? null,
          tool_calls: choice.message.tool_calls,
        },
        finishReason: choice.finish_reason ?? "stop",
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        model,
      };
    } catch (err) {
      lastErr = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort || attempt >= retries) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface OpenAiResponse {
  choices?: Array<{
    message: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
