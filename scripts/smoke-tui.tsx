import { initModel, applyEvent, transcriptLines, orchestratorStatus, type TuiModel } from "../src/ui/model.js";
import type { PipelineEvent } from "../src/core/events.js";
import { theme } from "../src/ui/theme.js";

/**
 * Drives the TUI reducer with synthetic events and prints the flattened
 * transcript + tree, so the redesigned layout's data model can be verified
 * without a real TTY. Also mounts the real Dashboard to confirm it renders.
 */

const events: PipelineEvent[] = [
  { type: "run:start", runId: "20260707-smoke", request: "a todo REST API", stack: "node-prisma-react", model: "deepseek/deepseek-chat" },
  { type: "stage:start", stage: "planner", agent: "planner" },
  { type: "agent:thinking", stage: "planner", text: "let me lay out the schema and endpoints for a small todo service" },
  { type: "agent:todo", stage: "planner", items: [
    { text: "define Prisma schema", done: true },
    { text: "generate REST routes", done: false },
    { text: "wire validation middleware", done: false },
  ] },
  { type: "usage", model: "deepseek/deepseek-chat", promptTokens: 1800, completionTokens: 300, totalTokens: 2100 },
  { type: "stage:gate", stage: "planner", passed: true, detail: "Plan has 12 task(s)." },
  { type: "stage:done", stage: "planner", durationMs: 12300, artifacts: ["plan.json"], tokens: 2100 },
  { type: "stage:start", stage: "architect", agent: "architect" },
  { type: "stage:progress", stage: "architect", tool: "write_file", summary: "prisma/schema.prisma" },
  { type: "stage:progress", stage: "architect", tool: "run_shell", summary: "npx prisma migrate dev" },
  { type: "usage", model: "deepseek/deepseek-chat", promptTokens: 2200, completionTokens: 400, totalTokens: 2600 },
];

let m: TuiModel = initModel("0.1.0", Date.now());
for (const e of events) m = applyEvent(m, { ...e, ts: Date.now() });

console.log("──── transcript ────");
for (const ln of transcriptLines(m.blocks, 60, theme.accent)) console.log(ln.text);
console.log("──── tree ────");
console.log(`${orchestratorStatus(m.tree)} orchestrator`);
for (const n of m.tree) console.log(` ${n.name.padEnd(10)} ${n.status}`);
console.log(`──── usage ──── tokens=${m.totalTokens} model=${m.model}`);

const checks: Array<[string, boolean]> = [
  ["thinking header present", m.blocks.some((b) => b.kind === "thinking")],
  ["plan block present", m.blocks.some((b) => b.kind === "todo")],
  ["plan item marked done", (m.blocks.find((b) => b.kind === "todo")?.items ?? []).some((i) => i.done)],
  ["tool block for write_file", m.blocks.some((b) => b.kind === "tool" && b.tool === "write_file")],
  ["gate passed block", m.blocks.some((b) => b.kind === "gate" && b.passed)],
  ["handoff dividers", m.blocks.filter((b) => b.kind === "handoff").length === 2],
  ["planner done in tree", m.tree.find((n) => n.name === "planner")?.status === "done"],
  ["architect running in tree", m.tree.find((n) => n.name === "architect")?.status === "running"],
  ["usage summed", m.totalTokens === 4700],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}

// Mount the real Dashboard to confirm the layout renders without crashing.
import React from "react";
import { render } from "ink-testing-library";
import { Dashboard } from "../src/ui/tui.js";
const store = { model: enterMainForce(m), checkpointResolver: null, steers: [], onQuit: null };
function enterMainForce(model: TuiModel): TuiModel {
  return { ...model, phase: "main" as const };
}
try {
  const r = render(<Dashboard store={store as never} />);
  const frame = r.lastFrame() ?? "";
  r.unmount();
  console.log("\n──── real Dashboard frame ────\n" + frame + "\n──────────────────────────────");
  for (const [label, pass] of [
    ["shows orchestrator", frame.includes("orchestrator")] as [string, boolean],
    ["shows usage box tokens", /tokens/.test(frame)] as [string, boolean],
    ["shows status bar", /esc stop|inspect:/.test(frame)] as [string, boolean],
    ["shows input prompt", frame.includes(">")] as [string, boolean],
  ]) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
} catch (err) {
  console.log("FAIL  real Dashboard mounts:", err instanceof Error ? err.message : err);
  ok = false;
}

console.log(ok ? "\n[smoke-tui] OK" : "\n[smoke-tui] FAILED");
process.exitCode = ok ? 0 : 1;
