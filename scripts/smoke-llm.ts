import { chatCompletion, resolveModelId } from "../src/core/llm.js";

/** Verifies one round-trip completion against the configured provider. */
async function main() {
  const { provider, model } = resolveModelId();
  console.log(`[smoke] provider=${provider} model=${model} base=${process.env.LLM_API_BASE ?? "(default)"}`);

  const res = await chatCompletion({
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
  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
