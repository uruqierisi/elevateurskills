import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, type Instance } from "ink";
import Spinner from "ink-spinner";
import type { EventBus } from "../core/events.js";
import type { CheckpointDecision } from "../core/events.js";
import { PIPELINE } from "../core/agents.js";
import { initModel, applyEvent, clearCheckpoint, type TuiModel, type StageView } from "./model.js";
import type { Renderer } from "./plain.js";
import { termWidth, truncate, humanDuration, humanTokens, estimateCostUsd, formatCostUsd } from "./format.js";

/**
 * Ink (React-for-the-terminal) TUI renderer: a single non-scrolling frame
 * redrawn in place. It is a dumb projection of the reducer model in model.ts —
 * all "what to show" logic lives there, so the component stays declarative.
 *
 * Re-renders are throttled to ~10fps via a tick, which coalesces bursts of
 * rapid tool events so the pipeline is never slowed by rendering.
 */

/** Shared mutable store: bus handler writes; component reads on each tick. */
export interface Store {
  model: TuiModel;
  checkpointResolver: ((d: CheckpointDecision) => void) | null;
}

const STAGES_TO_SHOW = PIPELINE as string[];
// The contract-decoupled pair that can run in parallel after the freeze.
const PARALLEL_PAIR = new Set(["backend", "frontend"]);

function glyphFor(stage: StageView): React.ReactElement {
  switch (stage.status) {
    case "running":
      return (
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
      );
    case "done":
      return <Text color="green">✓</Text>;
    case "failed":
      return <Text color="red">✗</Text>;
    default:
      return <Text dimColor>○</Text>;
  }
}

function StageRow({ stage }: { stage: StageView }): React.ReactElement {
  const gutter = PARALLEL_PAIR.has(stage.name) ? "∥" : " ";
  const meta: string[] = [];
  if (stage.durationMs !== undefined) meta.push(humanDuration(stage.durationMs));
  if (stage.tokens) meta.push(`${humanTokens(stage.tokens)} tok`);
  const dim = stage.status === "pending";
  return (
    <Box>
      <Text dimColor>{gutter} </Text>
      <Box width={2}>{glyphFor(stage)}</Box>
      <Text dimColor={dim} bold={stage.status === "running"}>
        {stage.name.padEnd(10)}
      </Text>
      {meta.length > 0 && <Text dimColor> {meta.join(" · ")}</Text>}
    </Box>
  );
}

function Header({ m }: { m: TuiModel }): React.ReactElement {
  const width = termWidth();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="magentaBright" bold>
          elevateurskills
        </Text>
        <Text dimColor> · {truncate(m.request || "(resuming)", Math.max(20, width - 40))}</Text>
      </Box>
      <Text dimColor>
        {m.model || "—"} · {m.stack || "—"} · run {m.runId || "…"}
      </Text>
    </Box>
  );
}

function Active({ m }: { m: TuiModel }): React.ReactElement | null {
  if (!m.activeStage) return null;
  const width = termWidth();
  const tail = m.tail.slice(-6);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="cyan" bold>
          ▶ {m.activeStage}
        </Text>
        {m.lastTool ? <Text dimColor>  {truncate(m.lastTool, Math.max(10, width - m.activeStage.length - 6))}</Text> : null}
      </Text>
      {tail.map((line, i) => (
        <Text key={i} dimColor>
          {"  "}
          {truncate(line, Math.max(10, width - 3))}
        </Text>
      ))}
    </Box>
  );
}

function Footer({ m }: { m: TuiModel }): React.ReactElement {
  const width = termWidth();
  const elapsed = humanDuration(Date.now() - m.startTs);
  const doneCount = m.stages.filter((s) => s.status === "done").length;
  const cost = formatCostUsd(estimateCostUsd(m.totalTokens, m.model));
  const parts = [
    `⏱ ${elapsed}`,
    `stage ${doneCount}/${m.stages.length}`,
    `${humanTokens(m.totalTokens)} tok ~${cost}`,
  ];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{"─".repeat(Math.min(width, 60))}</Text>
      <Text dimColor>{parts.join("   ")}</Text>
      {m.workspacePath ? <Text dimColor>{truncate(m.workspacePath, width)}</Text> : null}
    </Box>
  );
}

function Checkpoint({ m }: { m: TuiModel }): React.ReactElement | null {
  if (!m.checkpoint) return null;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⏸ checkpoint after {m.checkpoint.stage}
      </Text>
      <Text dimColor>inspect: {m.checkpoint.artifactPaths.join(", ")}</Text>
      <Text>
        <Text bold>[c]</Text> continue{"   "}
        <Text bold>[r]</Text> retry stage{"   "}
        <Text bold>[q]</Text> quit
      </Text>
    </Box>
  );
}

function ErrorNote({ m }: { m: TuiModel }): React.ReactElement | null {
  if (!m.errorStage) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="red" bold>
        ✗ {m.errorStage} failed
      </Text>
      <Text dimColor>{truncate(m.errorText ?? "", termWidth())}</Text>
      <Text dimColor>re-spawning the agent with the failure context…</Text>
    </Box>
  );
}

export function Dashboard({ store }: { store: Store }): React.ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 100);
    return () => clearInterval(id);
  }, []);

  const m = store.model;

  useInput((input, key) => {
    if (!m.checkpoint || !store.checkpointResolver) return;
    let decision: CheckpointDecision | null = null;
    if (input === "r") decision = "retry";
    else if (input === "q" || (key.ctrl && input === "c")) decision = "quit";
    else if (input === "c" || key.return) decision = "continue";
    if (!decision) return;
    const resolve = store.checkpointResolver;
    store.checkpointResolver = null;
    store.model = clearCheckpoint(store.model);
    resolve(decision);
  });

  return (
    <Box flexDirection="column">
      <Header m={m} />
      <Box flexDirection="column">
        {m.stages.map((s) => (
          <StageRow key={s.name} stage={s} />
        ))}
      </Box>
      <Active m={m} />
      <ErrorNote m={m} />
      <Checkpoint m={m} />
      <Footer m={m} />
    </Box>
  );
}

/**
 * Mounts the Ink dashboard and wires it to the bus. Returns the Renderer
 * contract (awaitCheckpoint + stop) shared with the plain renderer.
 */
export function attachTuiRenderer(bus: EventBus, _opts: { model?: string } = {}): Renderer {
  const store: Store = {
    model: initModel(STAGES_TO_SHOW, Date.now()),
    checkpointResolver: null,
  };

  const unsubscribe = bus.on((e) => {
    store.model = applyEvent(store.model, e);
  });

  let instance: Instance | null = null;
  // A failure to mount Ink must fall back to plain, not crash the run.
  instance = render(<Dashboard store={store} />, { exitOnCtrlC: false });

  return {
    awaitCheckpoint(stage: string, artifactPaths: string[]): Promise<CheckpointDecision> {
      return new Promise((resolve) => {
        store.model = { ...store.model, checkpoint: { stage, artifactPaths } };
        store.checkpointResolver = resolve;
      });
    },
    stop() {
      unsubscribe();
      if (instance) {
        instance.unmount();
        instance = null;
      }
    },
  };
}
