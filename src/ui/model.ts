import type { StampedEvent, TodoItem } from "../core/events.js";
import { PIPELINE } from "../core/agents.js";
import { truncate } from "./format.js";

/**
 * The TUI view model and a pure reducer over pipeline events. Keeping the
 * "what to show" logic here (not in the Ink component) means the whole layout
 * is testable without a terminal: feed events, assert on the model, and flatten
 * the transcript to styled lines for the scroll viewport.
 */

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TreeNode {
  name: string;
  status: NodeStatus;
}

export type BlockKind = "text" | "thinking" | "todo" | "tool" | "gate" | "handoff";

export interface TranscriptBlock {
  id: number;
  kind: BlockKind;
  stage?: string;
  text?: string;
  tool?: string;
  args?: string;
  passed?: boolean;
  detail?: string;
  items?: TodoItem[];
}

export interface CheckpointView {
  stage: string;
  artifactPaths: string[];
}

export interface TuiModel {
  phase: "splash" | "main";
  runId: string;
  request: string;
  stack: string;
  model: string;
  version: string;
  startTs: number;
  blocks: TranscriptBlock[];
  tree: TreeNode[];
  totalTokens: number;
  checkpoint: CheckpointView | null;
  finished: boolean;
  aborted: boolean;
  errorStage?: string;
  workspacePath?: string;
  nextId: number;
}

const BLOCKS_MAX = 1000;
const AGENTS = PIPELINE as string[];

export function initModel(version: string, startTs: number): TuiModel {
  return {
    phase: "splash",
    runId: "",
    request: "",
    stack: "",
    model: "",
    version,
    startTs,
    blocks: [],
    tree: AGENTS.map((name) => ({ name, status: "pending" })),
    totalTokens: 0,
    checkpoint: null,
    finished: false,
    aborted: false,
    nextId: 1,
  };
}

function setNode(tree: TreeNode[], name: string, status: NodeStatus): TreeNode[] {
  return tree.map((n) => (n.name === name ? { ...n, status } : n));
}

function push(m: TuiModel, block: Omit<TranscriptBlock, "id">): TuiModel {
  const withId: TranscriptBlock = { ...block, id: m.nextId };
  const blocks = [...m.blocks, withId];
  return { ...m, blocks: blocks.length > BLOCKS_MAX ? blocks.slice(-BLOCKS_MAX) : blocks, nextId: m.nextId + 1 };
}

/** Pure reducer: returns a new model for the event (never mutates the input). */
export function applyEvent(m: TuiModel, e: StampedEvent): TuiModel {
  switch (e.type) {
    case "run:start":
      return {
        ...m,
        phase: "splash",
        runId: e.runId,
        request: e.request,
        stack: e.stack,
        model: e.model,
      };

    case "run:plan": {
      // Mark every skipped agent so the tree shows the plan at a glance, and add
      // a visible summary block so the Architect checkpoint can show it.
      const marked = { ...m, tree: e.skipped.reduce((tree, name) => setNode(tree, name, "skipped"), m.tree) };
      const skips = e.skipped.length ? e.skipped.join(", ") : "none";
      const text =
        `◆ profile: ${e.profile}\n` +
        `  runs:  ${e.requiredAgents.join(", ")}\n` +
        `  skips: ${skips}\n` +
        `  sandbox/Docker: ${e.needsSandbox ? "yes" : "no"}`;
      return push(marked, { kind: "text", stage: "architect", text });
    }

    case "stage:start": {
      const started = {
        ...m,
        tree: setNode(m.tree, e.stage, "running"),
        errorStage: m.errorStage === e.stage ? undefined : m.errorStage,
      };
      // Only add a handoff divider when actually switching agents.
      const last = m.blocks[m.blocks.length - 1];
      if (last?.kind === "handoff" && last.stage === e.stage) return started;
      return push(started, { kind: "handoff", stage: e.stage });
    }

    case "stage:skipped":
      return push(
        { ...m, tree: setNode(m.tree, e.stage, "skipped") },
        { kind: "text", stage: e.stage, text: `– ${e.stage} skipped (${e.reason})` },
      );

    case "agent:thinking":
      return push(m, { kind: "thinking", stage: e.stage, text: e.text });

    case "agent:token":
      return push(m, { kind: "text", stage: e.stage, text: e.text });

    case "agent:todo": {
      // Replace the existing plan block in place if present.
      const idx = m.blocks.findIndex((b) => b.kind === "todo");
      if (idx >= 0) {
        const blocks = m.blocks.map((b, i) => (i === idx ? { ...b, items: e.items } : b));
        return { ...m, blocks };
      }
      return push(m, { kind: "todo", stage: e.stage, items: e.items });
    }

    case "stage:progress":
      return push(m, { kind: "tool", stage: e.stage, tool: e.tool, args: e.summary });

    case "stage:gate":
      return push(m, { kind: "gate", stage: e.stage, passed: e.passed, detail: e.detail });

    case "stage:done":
      return { ...m, tree: setNode(m.tree, e.stage, "done") };

    case "usage":
      return { ...m, totalTokens: m.totalTokens + e.totalTokens };

    case "checkpoint:await":
      return { ...m, checkpoint: { stage: e.stage, artifactPaths: e.artifactPaths } };

    case "run:error": {
      const marked = { ...m, tree: setNode(m.tree, e.stage, "failed"), errorStage: e.stage };
      return push(marked, { kind: "gate", stage: e.stage, passed: false, detail: e.error });
    }

    case "env:error": {
      // Environment failure — deliberately do NOT mark the node "failed": the
      // code didn't fail, the sandbox did. Surface it as a distinct message.
      const detail = `environment error (not your code): ${e.message}\n${e.hint}\nstage is resumable — fix the environment and re-run with --resume`;
      return push({ ...m, errorStage: e.stage }, { kind: "gate", stage: e.stage, passed: false, detail });
    }

    case "run:done":
      return { ...m, finished: true, workspacePath: e.workspacePath };

    default:
      return m;
  }
}

/** Clears a resolved checkpoint prompt. */
export function clearCheckpoint(m: TuiModel): TuiModel {
  return { ...m, checkpoint: null };
}

/** Leave the splash and enter the main view. */
export function enterMain(m: TuiModel): TuiModel {
  return m.phase === "main" ? m : { ...m, phase: "main" };
}

/** Root orchestrator status derived from its children. */
export function orchestratorStatus(tree: TreeNode[]): NodeStatus {
  if (tree.some((n) => n.status === "failed")) return "failed";
  if (tree.every((n) => n.status === "done")) return "done";
  if (tree.some((n) => n.status === "running")) return "running";
  return "pending";
}

// --- transcript flattening ------------------------------------------------

export interface StyledLine {
  text: string;
  color?: string;
  dim?: boolean;
  italic?: boolean;
  bold?: boolean;
}

/** Word-wrap a string to a width, returning at least one line. */
function wrap(text: string, width: number): string[] {
  const clean = text.replace(/\r/g, "");
  const out: string[] = [];
  for (const rawLine of clean.split("\n")) {
    if (rawLine.length <= width) {
      out.push(rawLine);
      continue;
    }
    let rest = rawLine;
    while (rest.length > width) {
      // Prefer to break on the last space within width.
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest.length) out.push(rest);
  }
  return out.length ? out : [""];
}

/**
 * Flatten one transcript block into styled lines for the given content width.
 * Pure and width-aware so the viewport can slice by rows.
 */
export function blockToLines(block: TranscriptBlock, width: number, accent: string): StyledLine[] {
  const w = Math.max(10, width);
  switch (block.kind) {
    case "handoff": {
      const label = ` ${block.stage ?? ""} `;
      const dashes = Math.max(0, w - label.length - 2);
      const left = "── ";
      const right = "─".repeat(Math.max(0, dashes - left.length));
      return [{ text: `${left}${block.stage ?? ""} ${right}`, color: accent, bold: true }];
    }
    case "thinking": {
      const lines: StyledLine[] = [{ text: "🧠 Thinking", color: "magenta", bold: true }];
      for (const l of wrap(block.text ?? "", w - 2)) lines.push({ text: `  ${l}`, dim: true, italic: true });
      return lines;
    }
    case "todo": {
      const lines: StyledLine[] = [{ text: "📋 Plan", color: accent, bold: true }];
      for (const item of block.items ?? []) {
        const box = item.done ? "[x]" : "[ ]";
        lines.push({ text: `  ${box} ${truncate(item.text, w - 6)}`, dim: item.done });
      }
      return lines;
    }
    case "tool": {
      const label = block.tool ?? "tool";
      const args = block.args ? truncate(block.args, w - label.length - 4) : "";
      return [{ text: `⚙ ${label}  ${args}`, color: accent }];
    }
    case "gate":
      return block.passed
        ? [{ text: `✓ ${block.stage} gate passed`, color: "green" }]
        : [{ text: truncate(`✗ ${block.stage} gate failed: ${block.detail ?? ""}`, w), color: "red" }];
    case "text":
    default:
      return wrap(block.text ?? "", w).map((l) => ({ text: l }));
  }
}

/** Flatten all blocks to a single styled-line list. */
export function transcriptLines(blocks: TranscriptBlock[], width: number, accent: string): StyledLine[] {
  const out: StyledLine[] = [];
  for (const b of blocks) {
    for (const line of blockToLines(b, width, accent)) out.push(line);
    if (b.kind === "thinking" || b.kind === "todo" || b.kind === "handoff") out.push({ text: "" });
  }
  return out;
}
