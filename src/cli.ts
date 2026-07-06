import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadEnv, REPO_ROOT } from "./core/env.js";
import { orchestrate } from "./core/orchestrator.js";
import { PIPELINE } from "./core/agents.js";
import type { StageName } from "./core/state.js";

/**
 * elevateurskills CLI. Strix-style single entrypoint:
 *
 *   elevateurskills --request "build a todo REST API" --stack node-prisma-react
 *
 * Runs stage-by-stage with a checkpoint between stages so you can inspect the
 * frozen contract before Backend/Frontend build. Pass --auto to skip checkpoints.
 */
async function main() {
  loadEnv();

  const program = new Command();
  program
    .name("elevateurskills")
    .description("Multi-agent AI coding pipeline: request in, runnable project out.")
    .option("-r, --request <text>", "high-level software request")
    .option("-s, --stack <name>", "target stack", "node-prisma-react")
    .option("--auto", "skip inter-stage checkpoints (autonomous)", false)
    .option("--resume <run-id>", "resume an existing run")
    .option("--stop-after <stage>", "stop after this stage")
    .option("--only <stages>", "comma-separated subset of stages to run")
    .option("--backend <mode>", "sandbox backend: auto | docker | local", "auto")
    .option("--max-attempts <n>", "gate retry attempts per stage", "2")
    .option("--runs-dir <path>", "runs directory", "runs")
    .option("--model <spec...>", "per-agent model override, e.g. architect=openai/gpt-4o")
    .parse(process.argv);

  const opts = program.opts();

  if (!opts.request && !opts.resume) {
    program.help({ error: true });
    return;
  }

  const validStages = new Set(PIPELINE);
  const only = opts.only
    ? String(opts.only)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
    : undefined;
  if (only) {
    for (const s of only) if (!validStages.has(s)) fatal(`Unknown stage "${s}". Valid: ${PIPELINE.join(", ")}`);
  }
  if (opts.stopAfter && !validStages.has(opts.stopAfter)) {
    fatal(`Unknown --stop-after stage "${opts.stopAfter}". Valid: ${PIPELINE.join(", ")}`);
  }

  const models: Record<string, string> = {};
  for (const spec of (opts.model ?? []) as string[]) {
    const eq = spec.indexOf("=");
    if (eq === -1) fatal(`--model expects agent=provider/model, got "${spec}"`);
    models[spec.slice(0, eq)] = spec.slice(eq + 1);
  }

  const runsRoot = resolve(REPO_ROOT, opts.runsDir);
  const interactive = !opts.auto && process.stdin.isTTY;

  const result = await orchestrate({
    request: opts.request ?? "(resumed run)",
    stack: opts.stack,
    runsRoot,
    auto: !!opts.auto,
    resumeId: opts.resume,
    stopAfter: opts.stopAfter as StageName | undefined,
    only: only as StageName[] | undefined,
    maxAttempts: Number(opts.maxAttempts) || 2,
    sandbox: { backend: opts.backend },
    models,
    onEvent: (stage, e) => {
      if (e.type === "tool_call") console.log(`   [${stage}] → ${e.toolName} ${truncate(e.text)}`);
      else if (e.type === "assistant" && e.text) console.log(`   [${stage}] 💬 ${truncate(e.text, 160)}`);
      else if (e.type === "error") console.log(`   [${stage}] ⚠ ${truncate(e.text, 200)}`);
    },
    checkpoint: interactive
      ? async ({ stage, state }) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          console.log(`\n── checkpoint after ${stage} ──`);
          console.log(`   run dir: ${state.dir}`);
          const answer = (await rl.question("   press Enter to continue, or 'q' to stop: ")).trim().toLowerCase();
          rl.close();
          return answer === "q" ? "abort" : "continue";
        }
      : undefined,
  });

  console.log("\n─────────────────────────────");
  console.log(`run id:     ${result.state.manifest.id}`);
  console.log(`completed:  ${result.completed.join(" → ") || "(none)"}`);
  console.log(`workspace:  ${result.state.workspaceDir}`);
  if (result.aborted) {
    console.log(`status:     STOPPED${result.stoppedAt ? ` at ${result.stoppedAt}` : ""}`);
    process.exit(1);
  }
  console.log(`status:     ${result.stoppedAt ? `stopped after ${result.stoppedAt}` : "complete"}`);
}

function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("\nfatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
