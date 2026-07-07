import { createInterface } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import chalk from "chalk";
import type { EventBus, StampedEvent, CheckpointDecision } from "../core/events.js";
import { termWidth, truncate, clockTime, humanDuration, humanTokens, estimateCostUsd, formatCostUsd } from "./format.js";

/**
 * Plain renderer: timestamped single lines, one per meaningful event. No cursor
 * tricks, no repaint. This is the always-works fallback for non-TTY, CI,
 * --auto, and piped output. It must never depend on terminal capabilities
 * beyond writing lines.
 */

export interface Renderer {
  awaitCheckpoint(stage: string, artifactPaths: string[]): Promise<CheckpointDecision>;
  /** Ask the operator to approve a non-allowlisted command. */
  confirm(question: string): Promise<boolean>;
  /** Pending steer/instruction lines submitted via the UI (TUI only). */
  drainSteers?(): string[];
  stop(): void;
}

function line(ts: number, body: string): void {
  const prefix = chalk.dim(clockTime(ts));
  const width = termWidth();
  // Reserve the timestamp + a space; truncate the body to the rest.
  process.stdout.write(`${prefix} ${truncate(body, Math.max(10, width - 9))}\n`);
}

export function attachPlainRenderer(bus: EventBus, opts: { model?: string } = {}): Renderer {
  let model = opts.model ?? "";
  let totalTokens = 0;

  const unsubscribe = bus.on((e: StampedEvent) => {
    switch (e.type) {
      case "run:start":
        model = e.model;
        line(e.ts, chalk.bold(`▶ run ${e.runId}`) + chalk.dim(` · ${e.request} · ${e.model} · ${e.stack}`));
        break;
      case "run:plan":
        line(
          e.ts,
          chalk.bold(`◆ profile: ${e.profile}`) +
            chalk.dim(` · runs: ${e.requiredAgents.join(", ")}`) +
            (e.skipped.length ? chalk.dim(` · skips: ${e.skipped.join(", ")}`) : "") +
            chalk.dim(` · sandbox: ${e.needsSandbox ? "yes" : "no"}`),
        );
        break;
      case "stage:start":
        line(e.ts, chalk.cyan(`■ ${e.stage}`) + chalk.dim(" started"));
        break;
      case "stage:skipped":
        line(e.ts, chalk.dim(`– ${e.stage} skipped (${e.reason})`));
        break;
      case "stage:progress":
        line(e.ts, chalk.dim(`  ${e.stage} `) + chalk.dim(`${e.tool}: ${e.summary}`));
        break;
      case "agent:token":
        line(e.ts, chalk.dim(`  ${e.stage} 💬 ${e.text}`));
        break;
      case "agent:thinking":
        line(e.ts, chalk.magenta(`  ${e.stage} 🧠 `) + chalk.dim(e.text));
        break;
      case "agent:todo": {
        const done = e.items.filter((i) => i.done).length;
        line(e.ts, chalk.dim(`  ${e.stage} 📋 plan ${done}/${e.items.length}`));
        break;
      }
      case "usage":
        // Per-call usage is noisy for a line log; totals come from stage:done.
        break;
      case "stage:gate":
        line(
          e.ts,
          e.passed
            ? chalk.green(`✓ ${e.stage} gate passed`) + chalk.dim(` — ${e.detail.split("\n")[0]}`)
            : chalk.red(`✗ ${e.stage} gate failed`) + chalk.dim(` — ${e.detail.split("\n")[0]}`),
        );
        break;
      case "stage:done": {
        totalTokens += e.tokens ?? 0;
        const meta = [humanDuration(e.durationMs), e.tokens ? `${humanTokens(e.tokens)} tok` : ""].filter(Boolean).join(", ");
        line(e.ts, chalk.green(`✓ ${e.stage} done`) + chalk.dim(meta ? ` (${meta})` : ""));
        break;
      }
      case "checkpoint:await":
        line(e.ts, chalk.yellow(`⏸ checkpoint after ${e.stage}`) + chalk.dim(` — inspect: ${e.artifactPaths.join(", ")}`));
        break;
      case "run:error":
        line(e.ts, chalk.red(`✗ ${e.stage} error`) + chalk.dim(` — ${e.error.split("\n")[0]}`));
        line(e.ts, chalk.dim("  orchestrator will re-spawn the agent with the failure context"));
        break;
      case "env:error":
        line(e.ts, chalk.red.bold(`⚠ environment error at ${e.stage}`) + chalk.dim(" — not a code failure"));
        line(e.ts, chalk.red(`  ${e.message}`));
        line(e.ts, chalk.dim(`  ${e.hint}`));
        line(e.ts, chalk.dim(`  the stage is resumable — fix the environment and re-run with --resume`));
        break;
      case "run:done": {
        const cost = formatCostUsd(estimateCostUsd(totalTokens, model));
        line(e.ts, chalk.bold.green(`✅ run complete`) + chalk.dim(` · ${humanTokens(totalTokens)} tok ~${cost} · ${e.workspacePath}`));
        if (e.repoUrl) line(e.ts, chalk.dim(`  repo: ${e.repoUrl}`));
        break;
      }
    }
  });

  return {
    async awaitCheckpoint(stage: string, artifactPaths: string[]): Promise<CheckpointDecision> {
      // Prefer a raw single keypress; fall back to line input if unavailable.
      process.stdout.write(
        chalk.yellow(`\n⏸ ${stage} complete. `) +
          chalk.dim(`Inspect: ${artifactPaths.join(", ")}\n`) +
          `  ${chalk.bold("[c]")} continue   ${chalk.bold("[r]")} retry stage   ${chalk.bold("[q]")} quit  `,
      );
      const key = await readOneKey(["c", "r", "q"]);
      process.stdout.write("\n");
      return key === "r" ? "retry" : key === "q" ? "quit" : "continue";
    },
    async confirm(question: string): Promise<boolean> {
      process.stdout.write(chalk.yellow(`\n${question}\n`) + `  ${chalk.bold("[y]")} run   ${chalk.bold("[n]")} refuse  `);
      const key = await readOneKey(["y", "n"]);
      process.stdout.write("\n");
      return key === "y";
    },
    stop() {
      unsubscribe();
    },
  };
}

/**
 * Read one keypress from a set of valid keys without requiring Enter, degrading
 * to a full-line read on non-TTY stdin. Returns the first valid key (lowercased)
 * or the set's first element as the default.
 */
function readOneKey(valid: string[]): Promise<string> {
  const stdin = process.stdin;
  const fallback = valid[0];
  const canRaw = stdin.isTTY && typeof stdin.setRawMode === "function";

  if (!canRaw) {
    const rl = createInterface({ input: stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        const ch = answer.trim().toLowerCase()[0] ?? fallback;
        resolve(valid.includes(ch) ? ch : fallback);
      });
    });
  }

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const name = (key.name ?? key.sequence ?? "").toLowerCase();
      if (key.ctrl && name === "c") return finish("q");
      if (valid.includes(name)) finish(name);
    };
    function finish(k: string) {
      stdin.off("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve(valid.includes(k) ? k : fallback);
    }
    stdin.on("keypress", onKey);
  });
}
