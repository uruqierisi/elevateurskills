#!/usr/bin/env node
import { resolve, join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import chalk from "chalk";
import { loadEnv, REPO_ROOT } from "./core/env.js";
import { orchestrate } from "./core/orchestrator.js";
import { PIPELINE } from "./core/agents.js";
import { resolveModelId, checkKeysForModels } from "./core/llm.js";
import { AGENT_MODEL_DEFAULTS } from "./core/models.js";
import { EventBus } from "./core/events.js";
import { LOCAL_MODE_WARNING } from "./core/sandbox.js";
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
    .option("--debug-layout", "TUI: show a one-row header with height-budget numbers", false)
    .option("--i-understand-local", "consent to run model-generated commands on your host (local sandbox)", false)
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

  // Preflight: every provider that could run (active model + per-agent overrides
  // + built-in per-agent defaults) must have its key set. Fail fast, naming the
  // exact env var, before any UI mounts or run directory is created.
  const modelsInUse = [`${provider}/${model}`, ...Object.values(models), ...Object.values(AGENT_MODEL_DEFAULTS)];
  const keyError = checkKeysForModels(modelsInUse);
  if (keyError) fatal(keyError);

  // The sandbox is now activated LAZILY inside the orchestrator — only if the
  // classified profile needs command execution, and only before the first
  // builder that runs. So we do NOT resolve Docker or build the image here: a
  // static-site run must complete even with no Docker daemon. We only pass the
  // backend intent and whether local execution is consented to.
  const backendIntent = (opts.backend as "auto" | "docker" | "local") ?? "auto";
  let localConsent = !!opts.iUnderstandLocal || existsSync(CONSENT_MARKER);
  // For an explicitly-forced local backend, get consent up front (before any UI
  // mounts) since we know host execution is intended. For auto/docker we stay
  // non-interactive; if the run later needs local exec without consent, the
  // orchestrator halts with a clear, resumable environment error.
  if (backendIntent === "local" && !localConsent) {
    console.log(chalk.yellow(LOCAL_MODE_WARNING));
    await ensureLocalConsent(!!opts.auto, !!opts.iUnderstandLocal);
    localConsent = true;
  }

  const bus = new EventBus();
  const control = { stopRequested: false };
  const renderer = attachRenderer(bus, { plain: !!opts.plain, model: `${provider}/${model}`, control, debugLayout: !!opts.debugLayout });

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
      sandbox: { backend: backendIntent },
      localConsent,
      models,
      bus,
      control,
      drainSteers: () => renderer.drainSteers?.() ?? [],
      confirm: opts.auto ? undefined : (question) => renderer.confirm(question),
      checkpoint: opts.auto ? undefined : (info) => renderer.awaitCheckpoint(info.stage, info.artifactPaths),
    });

    renderer.stop();
    printFinalSummary(result);
    if (result.infra) {
      // Environment failure, not a code failure — make that unmistakable and
      // point at the fix. The stage was left resumable.
      process.stderr.write(
        "\n" +
          chalk.red.bold("⚠ environment error — the sandbox could not run, this is NOT your code.") +
          "\n" +
          chalk.red(`  ${result.infra.message}`) +
          "\n" +
          chalk.dim(`  ${result.infra.hint}`) +
          "\n" +
          chalk.dim(`  Fix the environment and resume: elevateurskills --resume ${result.state.manifest.id}`) +
          "\n",
      );
    }
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
  const skips = PIPELINE.filter((s) => result.skipped.includes(s))
    .map((s) => `  ${chalk.dim("–")} ${chalk.dim(`${s} (skipped: ${result.profile ?? "profile"})`)}`)
    .join("\n");
  process.stdout.write("\n" + chalk.dim("─".repeat(40)) + "\n");
  process.stdout.write(`${chalk.bold("run")}       ${result.state.manifest.id}\n`);
  if (result.profile) process.stdout.write(`${chalk.bold("profile")}   ${result.profile}\n`);
  if (recap) process.stdout.write(`${chalk.bold("completed")}\n${recap}\n`);
  if (skips) process.stdout.write(`${chalk.bold("skipped")}\n${skips}\n`);
  process.stdout.write(`${chalk.bold("workspace")} ${result.state.workspaceDir}\n`);
  const status = result.aborted
    ? chalk.red(`STOPPED${result.stoppedAt ? ` at ${result.stoppedAt}` : ""}`)
    : chalk.green(result.stoppedAt ? `stopped after ${result.stoppedAt}` : "complete");
  process.stdout.write(`${chalk.bold("status")}    ${status}\n`);
}

const CONSENT_MARKER = join(homedir(), ".elevateurskills-consent");

/**
 * Gate for the local sandbox: model-generated commands run on the host, so we
 * require explicit acknowledgement — the first interactive run, and EVERY time
 * --auto is combined with local. `--i-understand-local` grants it up front;
 * --auto without that flag (or non-interactive without consent) is refused.
 */
async function ensureLocalConsent(auto: boolean, iUnderstand: boolean): Promise<void> {
  if (iUnderstand) {
    touchConsent();
    return;
  }
  if (auto) {
    fatal(
      "refusing to run --auto with the LOCAL sandbox without consent.\n" +
        "Local mode runs model-generated commands on your host. Re-run with --backend docker\n" +
        "(isolated), or add --i-understand-local if you accept the risk.",
    );
  }
  if (existsSync(CONSENT_MARKER)) return;
  if (!process.stdin.isTTY) {
    fatal(
      "local sandbox needs consent but stdin is not interactive.\n" +
        "Add --i-understand-local or use --backend docker.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(chalk.yellow("Type 'yes' to run model-generated commands on your host: "))).trim().toLowerCase();
  rl.close();
  if (ans !== "yes") fatal("aborted — no consent given for local mode.");
  touchConsent();
}

function touchConsent(): void {
  try {
    writeFileSync(CONSENT_MARKER, new Date().toISOString() + "\n", "utf8");
  } catch {
    /* best effort — consent still granted for this run */
  }
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("\nfatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
