import { runAgent } from "../src/core/loop.js";
import type { CompletionResult } from "../src/core/llm.js";
import type { Tool, ToolContext } from "../src/core/tools/index.js";

/**
 * Circuit-breaker verification with a stubbed completion (no live provider).
 * A "spinning" agent that keeps calling the same failing command lets us prove
 * the token budget, tool-call budget, and spin-detection nudges all fire.
 */

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) ok = false;
};

// A tool that always fails the same way — the classic stuck-in-a-loop shape.
const failingShell: Tool = {
  name: "run_shell",
  schema: { type: "function", function: { name: "run_shell", description: "", parameters: { type: "object", properties: {} } } },
  async execute() {
    return { ok: false, content: "exit_code: 1\nstderr:\nError: PrismaClientInitializationError: engine failed to load" };
  },
};

const ctx: ToolContext = { sandbox: {} as never, log: () => {} };

/** A completion stub that always asks for one run_shell call with a fixed command. */
function spinningComplete(injectedSeen: { nudges: string[] }) {
  let n = 0;
  return async (params: { messages: { role: string; content: string | null }[] }): Promise<CompletionResult> => {
    // Record any [system] circuit-breaker nudge that reached the model.
    const last = params.messages[params.messages.length - 1];
    if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[system]")) {
      injectedSeen.nudges.push(last.content);
    }
    n++;
    return {
      message: {
        role: "assistant",
        content: `attempt ${n}`,
        tool_calls: [{ id: `c${n}`, type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "npx prisma generate" }) } }],
      },
      finishReason: "tool_calls",
      usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
      model: "test/stub",
    };
  };
}

async function main() {
  // 1. Tool-call budget halts the loop.
  {
    const seen = { nudges: [] as string[] };
    const res = await runAgent({
      system: "s",
      task: "t",
      tools: [failingShell],
      ctx,
      maxIterations: 1000,
      maxToolCalls: 10,
      maxTokens: 10_000_000,
      complete: spinningComplete(seen),
    });
    check("halts on tool-call budget", res.stopReason === "iteration-limit");
    check("tool calls capped at limit", res.toolCalls === 10);
    check("80% tool-call warning injected", seen.nudges.some((s) => s.includes("80% of your tool-call budget")));
    check("spin repeat nudge injected", seen.nudges.some((s) => s.includes("tried this command 3 times")));
    check("consecutive-failure nudge injected", seen.nudges.some((s) => s.includes("Multiple consecutive failures")));
  }

  // 2. Token budget halts the loop (50 tok/call, cap 300 -> ~6 calls).
  {
    const seen = { nudges: [] as string[] };
    const res = await runAgent({
      system: "s",
      task: "t",
      tools: [failingShell],
      ctx,
      maxIterations: 1000,
      maxToolCalls: 10_000,
      maxTokens: 300,
      complete: spinningComplete(seen),
    });
    check("halts on token budget", res.stopReason === "budget-exceeded");
    check("token usage at/over cap", res.usage.totalTokens >= 300);
    check("80% token warning injected", seen.nudges.some((s) => s.includes("80% of your token budget")));
  }

  // 3. A well-behaved agent that finishes normally is NOT halted.
  {
    let done = false;
    const res = await runAgent({
      system: "s",
      task: "t",
      tools: [failingShell],
      ctx,
      maxToolCalls: 50,
      maxTokens: 500_000,
      complete: async (): Promise<CompletionResult> => {
        const first = !done;
        done = true;
        return {
          message: { role: "assistant", content: first ? "all done" : "done", tool_calls: undefined },
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: "test/stub",
        };
      },
    });
    check("normal completion is not halted", res.stopReason === "completed");
    check("normal completion returns final text", res.finalText === "all done");
  }

  console.log(ok ? "\n[smoke-limits] OK" : "\n[smoke-limits] FAILED");
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error("[smoke-limits] FAILED:", e);
  process.exit(1);
});
