import { defineSchema, requireString, type Tool } from "./types.js";
import { screenCommand } from "../command-screen.js";

function formatExec(r: { stdout: string; stderr: string; exitCode: number; timedOut: boolean }): string {
  const parts = [`exit_code: ${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""}`];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
  return parts.join("\n\n");
}

/** Arbitrary shell command inside the sandbox. */
export const runShellTool: Tool = {
  name: "run_shell",
  schema: defineSchema("run_shell", "Run a shell command inside the sandbox workspace. Returns exit code, stdout, stderr.", {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command, e.g. 'npm install'" },
      cwd: { type: "string", description: "Workspace-relative working directory (optional)" },
      timeout_ms: { type: "number", description: "Timeout in ms (optional)" },
    },
    required: ["command"],
  }),
  async execute(args, ctx) {
    const command = requireString(args, "command");
    const cwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

    // The Docker container is the boundary; only screen the local backend.
    if (ctx.sandbox.kind === "local") {
      const verdict = screenCommand(command);
      if (verdict.action === "deny") {
        ctx.log(`run_shell REFUSED (${verdict.reason}): ${command}`);
        return { ok: false, content: `Refused: ${verdict.reason}. Command not run:\n${command}` };
      }
      if (verdict.action === "unknown") {
        if (ctx.auto || !ctx.confirm) {
          ctx.log(`run_shell REFUSED (not allowlisted, ${ctx.auto ? "autonomous mode" : "no confirm available"}): ${command}`);
          return {
            ok: false,
            content:
              `Refused: this command is not on the toolchain allowlist and ` +
              `${ctx.auto ? "autonomous mode does not run arbitrary binaries" : "no interactive confirm is available"}. ` +
              `Command not run:\n${command}`,
          };
        }
        const approved = await ctx.confirm(`Run non-allowlisted command on the host?\n  ${command}`);
        if (!approved) {
          ctx.log(`run_shell DECLINED by operator: ${command}`);
          return { ok: false, content: `Declined by operator. Command not run:\n${command}` };
        }
      }
    }

    ctx.log(`run_shell ${command}${cwd ? ` (cwd=${cwd})` : ""}`);
    const r = await ctx.sandbox.exec(command, { cwd, timeoutMs });
    return { ok: r.exitCode === 0, content: formatExec(r) };
  },
};

/**
 * Runs a project's test command. Defaults to `npm test` but the model can pass
 * an explicit command. A non-zero exit is reported as ok:false so the agent
 * treats a failing suite as work to fix, not a finished task.
 */
export const runTestsTool: Tool = {
  name: "run_tests",
  schema: defineSchema("run_tests", "Run the test suite (default 'npm test --silent'). Returns pass/fail and output.", {
    type: "object",
    properties: {
      command: { type: "string", description: "Test command override (optional)" },
      cwd: { type: "string", description: "Workspace-relative directory (optional)" },
    },
    required: [],
  }),
  async execute(args, ctx) {
    const command = typeof args.command === "string" && args.command.length > 0 ? args.command : "npm test --silent";
    const cwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
    ctx.log(`run_tests ${command}${cwd ? ` (cwd=${cwd})` : ""}`);
    const r = await ctx.sandbox.exec(command, { cwd, timeoutMs: 300_000 });
    const header = r.exitCode === 0 ? "TESTS PASSED" : "TESTS FAILED";
    return { ok: r.exitCode === 0, content: `${header}\n${formatExec(r)}` };
  },
};
