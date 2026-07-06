import { existsSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/core/loop.js";
import { createSandbox } from "../src/core/sandbox.js";
import { selectTools, type ToolContext } from "../src/core/tools/index.js";

/**
 * Trivial two-tool agent: write a file, then run it. Verifies the tool loop
 * (tool-calling, execution, observation) end to end against the real provider.
 */
async function main() {
  const root = join(process.cwd(), "runs", "_smoke-loop", "workspace");
  const sandbox = createSandbox(root, { backend: "local" });
  const tools = selectTools(["write_file", "run_shell"]);
  const ctx: ToolContext = { sandbox, log: (m) => console.log("   ·", m) };

  const result = await runAgent({
    system:
      "You are a coding agent with write_file and run_shell tools. " +
      "Complete the task by using the tools, then reply with a one-line confirmation. " +
      "Do not ask questions; act.",
    task:
      "Create a file named hello.js in the workspace root that prints exactly " +
      "'hello from the loop' to stdout. Then run it with `node hello.js` and confirm the output matches.",
    tools,
    ctx,
    maxIterations: 8,
    onEvent: (e) => {
      if (e.type === "tool_call") console.log(`   → ${e.toolName}(${e.text})`);
      if (e.type === "assistant" && e.text) console.log(`   💬 ${e.text.slice(0, 120)}`);
    },
  });

  console.log("\n[smoke] iterations:", result.iterations, "usage:", result.usage);

  const helloPath = sandbox.resolve("hello.js");
  if (!existsSync(helloPath)) {
    console.error("[smoke] FAILED: hello.js was not created");
    process.exit(1);
  }
  const check = await sandbox.exec("node hello.js");
  if (!check.stdout.includes("hello from the loop")) {
    console.error("[smoke] FAILED: unexpected output:", check.stdout);
    process.exit(1);
  }
  console.log("[smoke] verified output:", check.stdout.trim());
  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
