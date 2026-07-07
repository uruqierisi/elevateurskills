import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, type Instance } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import type { EventBus, CheckpointDecision } from "../core/events.js";
import { packageVersion } from "../core/env.js";
import {
  initModel,
  applyEvent,
  clearCheckpoint,
  enterMain,
  orchestratorStatus,
  transcriptLines,
  type TuiModel,
  type TreeNode,
  type NodeStatus,
  type StyledLine,
} from "./model.js";
import { theme, TAGLINE } from "./theme.js";
import type { Renderer } from "./plain.js";
import { estimateCostUsd, formatCostUsd } from "./format.js";

/**
 * Strix-style TUI: a splash, then a two-column layout — a scrollable transcript
 * on the left, an agent tree + model/usage box on the right — with a status bar
 * and steer input across the bottom. It is a pure projection of the reducer in
 * model.ts; all rendering data comes from there.
 *
 * Ink has no viewport/scroll primitive, so the transcript is scrolled manually:
 * the reducer flattens blocks to styled lines and this component slices the
 * window that fits `process.stdout.rows`, re-slicing on resize.
 */

const SIDEBAR_WIDTH = 28;
const INPUT_HEIGHT = 3; // bordered single line
const STATUS_HEIGHT = 1;

interface Store {
  model: TuiModel;
  checkpointResolver: ((d: CheckpointDecision) => void) | null;
  steers: string[];
  onQuit: (() => void) | null;
}

// --- small helpers --------------------------------------------------------

function termSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function tokensBig(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function shortPath(p: string): string {
  const idx = p.replace(/\\/g, "/").indexOf("/runs/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function nodeGlyph(status: NodeStatus): React.ReactElement {
  switch (status) {
    case "running":
      return (
        <Text color={theme.accent}>
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

// --- regions --------------------------------------------------------------

const LOGO = ["█████  █   █  █████", "█      █   █  █    ", "████   █   █  █████", "█      █   █      █", "█████  █████  █████"];

function Splash({ m }: { m: TuiModel }): React.ReactElement {
  return (
    <Box height={termSize().rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor={theme.accent} paddingX={4} paddingY={1}>
        {LOGO.map((l, i) => (
          <Text key={i} color={theme.accent} bold>
            {l}
          </Text>
        ))}
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text bold>Welcome to elevateurskills!</Text>
          <Text dimColor>v{m.version}</Text>
          <Text dimColor>{TAGLINE}</Text>
          <Box marginTop={1}>
            <Text color={theme.accent}>
              <Spinner type="dots" /> Starting pipeline…
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function Transcript({ lines, height, width, scrollOffset }: { lines: StyledLine[]; height: number; width: number; scrollOffset: number }): React.ReactElement {
  const viewport = Math.max(1, height);
  const total = lines.length;
  const maxStart = Math.max(0, total - viewport);
  const start = Math.max(0, maxStart - scrollOffset);
  const visible = lines.slice(start, start + viewport);
  while (visible.length < viewport) visible.push({ text: "" });

  // Scrollbar thumb position along the viewport.
  const thumbRow = maxStart === 0 ? -1 : Math.round((start / maxStart) * (viewport - 1));

  return (
    <Box flexDirection="row" height={viewport}>
      <Box flexDirection="column" width={width - 1}>
        {visible.map((ln, i) => (
          <Text key={i} color={ln.color} dimColor={ln.dim} italic={ln.italic} bold={ln.bold} wrap="truncate-end">
            {ln.text || " "}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" width={1}>
        {Array.from({ length: viewport }).map((_, i) => (
          <Text key={i} color={theme.accent} dimColor={i !== thumbRow}>
            {i === thumbRow ? "█" : "│"}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function AgentTree({ tree, height }: { tree: TreeNode[]; height: number }): React.ReactElement {
  return (
    <Box flexDirection="column" height={height} paddingX={1}>
      <Text>
        {nodeGlyph(orchestratorStatus(tree))} <Text bold>orchestrator</Text>
      </Text>
      {tree.map((n, i) => {
        const connector = i === tree.length - 1 ? "└" : "├";
        const running = n.status === "running";
        return (
          <Text key={n.name}>
            <Text dimColor> {connector} </Text>
            {nodeGlyph(n.status)} <Text dimColor={n.status === "pending"} bold={running}>
              {n.name}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

function UsageBox({ m }: { m: TuiModel }): React.ReactElement {
  const cost = formatCostUsd(estimateCostUsd(m.totalTokens, m.model));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{m.model || "—"}</Text>
      <Text>{tokensBig(m.totalTokens)} tokens</Text>
      <Text dimColor>
        ~{cost} · v{m.version}
      </Text>
    </Box>
  );
}

function StatusBar({ m }: { m: TuiModel }): React.ReactElement {
  if (m.checkpoint) {
    return (
      <Box>
        <Text>
          <Text color={theme.accent} bold>
            [c]
          </Text>{" "}
          continue{"  "}
          <Text bold>[r]</Text> retry{"  "}
          <Text bold>[q]</Text> quit
        </Text>
        <Text dimColor>
          {"  ·  inspect: "}
          {m.checkpoint.artifactPaths.map(shortPath).join(", ")}
        </Text>
      </Box>
    );
  }
  return (
    <Box justifyContent="space-between">
      <Text dimColor>···· esc stop</Text>
      <Text dimColor>ctrl-q quit</Text>
    </Box>
  );
}

function InputArea({
  value,
  onChange,
  onSubmit,
  active,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  active: boolean;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green">{"> "}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus={active} placeholder="" />
    </Box>
  );
}

// --- dashboard ------------------------------------------------------------

export function Dashboard({ store }: { store: Store }): React.ReactElement {
  const [, setTick] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [input, setInput] = useState("");

  useEffect(() => {
    const id = setInterval(() => {
      // Leave the splash after ~1s or once real content has arrived.
      if (store.model.phase === "splash") {
        const elapsed = Date.now() - store.model.startTs;
        if (elapsed > 1000 || store.model.blocks.length > 0) store.model = enterMain(store.model);
      }
      setTick((t) => (t + 1) % 1_000_000);
    }, 100);
    return () => clearInterval(id);
  }, [store]);

  const m = store.model;
  const { cols, rows } = termSize();
  const topHeight = Math.max(6, rows - INPUT_HEIGHT - STATUS_HEIGHT - 1);
  const leftWidth = Math.max(20, cols - SIDEBAR_WIDTH - 1);
  const contentWidth = Math.max(10, leftWidth - 2);
  const lines = transcriptLines(m.blocks, contentWidth, theme.accent);

  useInput((inputChar, key) => {
    // Checkpoint: single-key decisions, input box disabled.
    if (m.checkpoint && store.checkpointResolver) {
      let decision: CheckpointDecision | null = null;
      if (inputChar === "r") decision = "retry";
      else if (inputChar === "q") decision = "quit";
      else if (inputChar === "c") decision = "continue";
      if (decision) {
        const resolve = store.checkpointResolver;
        store.checkpointResolver = null;
        store.model = clearCheckpoint(store.model);
        resolve(decision);
      }
      return;
    }
    if (key.ctrl && inputChar === "q") {
      store.onQuit?.();
      return;
    }
    if (key.pageUp) setScrollOffset((o) => o + Math.max(1, topHeight - 1));
    else if (key.pageDown) setScrollOffset((o) => Math.max(0, o - Math.max(1, topHeight - 1)));
    else if (key.escape) setScrollOffset(0);
  });

  if (m.phase === "splash") return <Splash m={m} />;

  const inputActive = !m.checkpoint;
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="row" height={topHeight}>
        <Box flexDirection="column" width={leftWidth} paddingX={1}>
          <Transcript lines={lines} height={topHeight} width={leftWidth} scrollOffset={scrollOffset} />
        </Box>
        <Box flexDirection="column" width={SIDEBAR_WIDTH} height={topHeight}>
          <Box flexGrow={1}>
            <AgentTree tree={m.tree} height={topHeight - 6} />
          </Box>
          <UsageBox m={m} />
        </Box>
      </Box>
      <StatusBar m={m} />
      <InputArea
        value={input}
        onChange={setInput}
        active={inputActive}
        onSubmit={(v) => {
          const text = v.trim();
          if (text) {
            store.steers.push(text);
            store.model = applyEvent(store.model, { type: "agent:token", stage: m.tree.find((n) => n.status === "running")?.name ?? "orchestrator", text: `» you: ${text}`, ts: Date.now() });
          }
          setInput("");
        }}
      />
    </Box>
  );
}

export function attachTuiRenderer(bus: EventBus, _opts: { model?: string } = {}): Renderer {
  const store: Store = {
    model: initModel(packageVersion(), Date.now()),
    checkpointResolver: null,
    steers: [],
    onQuit: null,
  };

  const unsubscribe = bus.on((e) => {
    store.model = applyEvent(store.model, e);
    if (store.model.phase === "splash" && (e.type === "stage:start" || e.type === "stage:progress")) {
      store.model = enterMain(store.model);
    }
  });

  let instance: Instance | null = render(<Dashboard store={store} />, { exitOnCtrlC: false });
  store.onQuit = () => {
    if (instance) instance.unmount();
  };

  return {
    awaitCheckpoint(stage: string, artifactPaths: string[]): Promise<CheckpointDecision> {
      return new Promise((resolve) => {
        store.model = { ...store.model, checkpoint: { stage, artifactPaths } };
        store.checkpointResolver = resolve;
      });
    },
    drainSteers(): string[] {
      const out = store.steers.slice();
      store.steers.length = 0;
      return out;
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
