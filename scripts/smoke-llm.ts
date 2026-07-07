import { chatCompletion, resolveModelId } from "../src/core/llm.js";
import { MODELS, PROVIDERS, type ProviderId } from "../src/core/models.js";

/**
 * Verifies one round-trip completion, plus a tool call, against a provider.
 *
 *   npm run smoke:llm                 # uses ELEVATE_LLM
 *   npm run smoke:llm -- deepseek     # forces a provider's default chat model
 *   npm run smoke:llm -- anthropic/claude-sonnet-5   # explicit provider/model
 *
 * Tool-calling is exercised because that path differs most across providers;
 * the AI SDK is what makes it identical, so this is the thing worth proving.
 */
function resolveArgModel(arg?: string): string | undefined {
  if (!arg) return undefined;
  if (arg.includes("/")) return arg;
  const provider = arg as ProviderId;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${arg}". One of: ${PROVIDERS.join(", ")}, or a full provider/model string.`);
  }
  return `${provider}/${MODELS[provider].chat}`;
}

async function main() {
  const modelArg = resolveArgModel(process.argv[2]);
  const { provider, model } = resolveModelId(modelArg);
  console.log(`[smoke] provider=${provider} model=${model} base=${process.env.LLM_API_BASE ?? "(default)"}`);

  // 1. Plain completion.
  const res = await chatCompletion({
    model: modelArg,
    messages: [
      { role: "system", content: "You are a terse assistant. Reply in one short sentence." },
      { role: "user", content: "Say 'elevateurskills llm wiring works' and nothing else." },
    ],
  });
  console.log("[smoke] reply:", res.message.content);
  console.log("[smoke] usage:", res.usage);
  if (!res.message.content) {
    console.error("[smoke] FAILED: empty content");
    process.exit(1);
  }

  // 2. Tool call — the cross-provider path that matters most.
  const toolRes = await chatCompletion({
    model: modelArg,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          },
        },
      },
    ],
    messages: [
      { role: "system", content: "Use tools when they help. Do not answer from memory." },
      { role: "user", content: "What's the weather in Paris? Call the tool." },
    ],
  });
  const calls = toolRes.message.tool_calls ?? [];
  console.log("[smoke] tool_calls:", JSON.stringify(calls));
  if (calls.length === 0) {
    console.warn("[smoke] WARN: no tool call returned (model chose not to call the tool)");
  } else {
    console.log("[smoke] tool-calling works ✓");
  }

  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
