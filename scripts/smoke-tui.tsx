import React from "react";
import { render } from "ink-testing-library";
import { EventBus, type PipelineEvent } from "../src/core/events.js";
import { initModel, applyEvent, type TuiModel } from "../src/ui/model.js";
import { PIPELINE } from "../src/core/agents.js";

/**
 * Renders the TUI reducer output through Ink (no real TTY) and prints frames so
 * the dashboard can be verified visually and in CI. We drive the model reducer
 * with synthetic events and render a lightweight projection identical to the
 * live component's structure.
 */

// Re-import the component pieces by rendering the real Dashboard is awkward
// (it self-ticks); instead we assert the reducer + a static render of stages.
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

function Frame({ m }: { m: TuiModel }) {
  return (
    <Box flexDirection="column">
      <Text>
        elevateurskills · {m.request} · {m.model}
      </Text>
      {m.stages.map((s) => (
        <Text key={s.name}>
          {s.status === "running" ? "◐" : s.status === "done" ? "✓" : s.status === "failed" ? "✗" : "○"} {s.name}
          {s.durationMs !== undefined ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : ""}
        </Text>
      ))}
      {m.activeStage ? <Text>▶ {m.activeStage}: {m.lastTool ?? ""}</Text> : null}
      <Text>
        stage {m.stages.filter((s) => s.status === "done").length}/{m.stages.length} · {m.totalTokens} tok
      </Text>
    </Box>
  );
}

const events: PipelineEvent[] = [
  { type: "run:start", runId: "20260707-smoke", request: "a todo REST API", stack: "node-prisma-react", model: "deepseek/deepseek-chat" },
  { type: "stage:start", stage: "planner", agent: "planner" },
  { type: "stage:progress", stage: "planner", tool: "read_state", summary: "{}" },
  { type: "stage:done", stage: "planner", durationMs: 12300, artifacts: ["plan.json"], tokens: 2100 },
  { type: "stage:start", stage: "architect", agent: "architect" },
  { type: "agent:token", stage: "architect", text: "designing the frozen contract…" },
  { type: "stage:progress", stage: "architect", tool: "write_state", summary: "contract" },
];

let m = initModel(PIPELINE as string[], Date.now() - 12300);
for (const e of events) m = applyEvent(m, { ...e, ts: Date.now() });

const frameInstance = render(<Frame m={m} />);
const frame = frameInstance.lastFrame() ?? "";
frameInstance.unmount();
console.log("──── rendered frame ────");
console.log(frame);
console.log("────────────────────────");

// Assertions: planner done with duration, architect running, counts correct.
const checks: Array<[string, boolean]> = [
  ["header shows request", frame.includes("a todo REST API")],
  ["planner marked done", /✓ planner/.test(frame)],
  ["planner duration shown", /12\.3s/.test(frame)],
  ["architect running", /◐ architect/.test(frame)],
  ["active panel shows architect", /▶ architect/.test(frame)],
  ["stage counter 1/7", frame.includes("1/7")],
  ["token total", frame.includes("2100 tok")],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}

// Also mount the REAL Dashboard component to confirm it renders without
// crashing (Spinner, useInput, layout, self-tick), and shows the pipeline.
import { Dashboard } from "../src/ui/tui.js";
const realStore = { model: m, checkpointResolver: null };
let realFrame = "";
try {
  const real = render(<Dashboard store={realStore} />);
  realFrame = real.lastFrame() ?? "";
  real.unmount();
} catch (err) {
  console.log("FAIL  real Dashboard mounts:", err instanceof Error ? err.message : err);
  ok = false;
}
const realChecks: Array<[string, boolean]> = [
  ["real Dashboard shows brand", realFrame.includes("elevateurskills")],
  ["real Dashboard lists devops", /devops/.test(realFrame)],
  ["real Dashboard active panel", /architect/.test(realFrame)],
];
for (const [label, pass] of realChecks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log("\n──── real Dashboard frame ────\n" + realFrame + "\n──────────────────────────────");

console.log(ok ? "\n[smoke-tui] OK" : "\n[smoke-tui] FAILED");
// Set exit code and let Node drain; hard process.exit races Ink handle cleanup.
process.exitCode = ok ? 0 : 1;
