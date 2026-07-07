/**
 * Provider + model configuration. DeepSeek, OpenAI, and Anthropic are equal
 * first-class providers — none is privileged. The active model is chosen by
 * ELEVATE_LLM in `provider/model` form; each provider resolves its own key.
 *
 * ⚠️ VERIFY THE MODEL IDS BELOW. Model names change over time — confirm each
 * against the provider's current lineup and update as needed. They live here,
 * in one place, on purpose.
 */

export type ProviderId = "deepseek" | "openai" | "anthropic";

export const PROVIDERS: ProviderId[] = ["deepseek", "openai", "anthropic"];

/** Default "chat" model id per provider. VERIFY these. */
export const MODELS: Record<ProviderId, { chat: string }> = {
  deepseek: { chat: "deepseek-chat" }, // VERIFY
  openai: { chat: "gpt-5.1" }, // VERIFY — set to your current OpenAI flagship id
  anthropic: { chat: "claude-sonnet-5" }, // VERIFY
};

/** Env var that holds each provider's API key. */
export const KEY_ENV: Record<ProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** Fallback active model when ELEVATE_LLM is unset. */
export const DEFAULT_ELEVATE_LLM = "deepseek/deepseek-chat";

/**
 * Optional per-agent default model overrides (can cross providers). Empty by
 * default so a single provider key is enough to run the whole pipeline. To give
 * the Architect a stronger, Opus-class model, uncomment the line below — it
 * then requires ANTHROPIC_API_KEY.
 *
 *   architect: "anthropic/claude-opus-4-8",  // VERIFY
 */
export const AGENT_MODEL_DEFAULTS: Record<string, string> = {
  // architect: "anthropic/claude-opus-4-8", // VERIFY — uncomment to upgrade the Architect
};

export interface ResolvedModel {
  provider: ProviderId;
  model: string;
}

/**
 * Parse a `provider/model` string. Falls back to ELEVATE_LLM, then the default.
 * An unknown provider is an error — providers are a closed set.
 */
export function resolveModel(modelString?: string): ResolvedModel {
  const raw = (modelString ?? process.env.ELEVATE_LLM ?? DEFAULT_ELEVATE_LLM).trim();
  const slash = raw.indexOf("/");
  if (slash === -1) {
    throw new Error(`ELEVATE_LLM must be "provider/model" (got "${raw}"). Providers: ${PROVIDERS.join(", ")}.`);
  }
  const provider = raw.slice(0, slash) as ProviderId;
  const model = raw.slice(slash + 1);
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Supported: ${PROVIDERS.join(", ")}.`);
  }
  if (!model) throw new Error(`Missing model id in "${raw}".`);
  return { provider, model };
}
