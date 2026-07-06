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
      case "stage:start":
        line(e.ts, chalk.cyan(`■ ${e.stage}`) + chalk.dim(" started"));
        break;
      case "stage:progress":
        line(e.ts, chalk.dim(`  ${e.stage} `) + chalk.dim(`${e.tool}: ${e.summary}`));
        break;
      case "agent:token":
        line(e.ts, chalk.dim(`  ${e.stage} 💬 ${e.text}`));
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
      const decision = await readSingleKey();
      process.stdout.write("\n");
      return decision;
    },
    stop() {
      unsubscribe();
    },
  };
}

/** Read one keypress (c/r/q) without requiring Enter, degrading to readline. */
function readSingleKey(): Promise<CheckpointDecision> {
  const stdin = process.stdin;
  const canRaw = stdin.isTTY && typeof stdin.setRawMode === "function";

  if (!canRaw) {
    // Non-TTY: read a whole line.
    const rl = createInterface({ input: stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        resolve(mapKey(answer.trim().toLowerCase()[0] ?? "c"));
      });
    });
  }

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const name = key.name ?? key.sequence ?? "";
      if (key.ctrl && name === "c") return finish("q");
      if (name === "c" || name === "r" || name === "q") finish(name);
    };
    function finish(k: string) {
      stdin.off("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve(mapKey(k));
    }
    stdin.on("keypress", onKey);
  });
}

function mapKey(k: string): CheckpointDecision {
  if (k === "r") return "retry";
  if (k === "q") return "quit";
  return "continue";
}
