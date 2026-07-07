#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadEnv, REPO_ROOT } from "./core/env.js";
import { orchestrate } from "./core/orchestrator.js";
import { PIPELINE } from "./core/agents.js";
import { resolveModelId } from "./core/llm.js";
import { EventBus } from "./core/events.js";
import { attachRenderer } from "./ui/index.js";
import type { StageName } from "./core/state.js";

/**
 * elevateurskills CLI. Strix-style single entrypoint:
 *
 *   elevateurskills --request "build a todo REST API" --stack node-prisma-react
 *
 * Runs stage-by-stage with a checkpoint between stages so you can inspect the
 * frozen contract before Backend/Frontend build. Pass --auto to skip checkpoints.
 *
 * The CLI owns no rendering logic: it creates an EventBus, attaches a renderer
 * (TUI on a TTY, plain otherwise or with --plain), and hands the bus to the
 * orchestrator. The pipeline only emits events.
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
    .option("--plain", "force the plain line renderer (no TUI)", false)
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
  const { provider, model } = resolveModelId();

  const bus = new EventBus();
  const control = { stopRequested: false };
  const renderer = attachRenderer(bus, { plain: !!opts.plain, model: `${provider}/${model}`, control });

  try {
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
      bus,
      control,
      drainSteers: () => renderer.drainSteers?.() ?? [],
      confirm: opts.auto ? undefined : (question) => renderer.confirm(question),
      checkpoint: opts.auto ? undefined : (info) => renderer.awaitCheckpoint(info.stage, info.artifactPaths),
    });

    renderer.stop();
    printFinalSummary(result);
    // Set exit code and let Node drain — a hard process.exit races the TUI's
    // stdin/timer handle cleanup and can trip a libuv assertion on Windows.
    if (result.aborted) process.exitCode = 1;
  } finally {
    renderer.stop();
  }
}

function printFinalSummary(result: import("./core/orchestrator.js").OrchestratorResult): void {
  const recap = PIPELINE.filter((s) => result.completed.includes(s))
    .map((s) => `  ${chalk.green("✓")} ${s}`)
    .join("\n");
  process.stdout.write("\n" + chalk.dim("─".repeat(40)) + "\n");
  process.stdout.write(`${chalk.bold("run")}       ${result.state.manifest.id}\n`);
  if (recap) process.stdout.write(`${chalk.bold("completed")}\n${recap}\n`);
  process.stdout.write(`${chalk.bold("workspace")} ${result.state.workspaceDir}\n`);
  const status = result.aborted
    ? chalk.red(`STOPPED${result.stoppedAt ? ` at ${result.stoppedAt}` : ""}`)
    : chalk.green(result.stoppedAt ? `stopped after ${result.stoppedAt}` : "complete");
  process.stdout.write(`${chalk.bold("status")}    ${status}\n`);
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("\nfatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
