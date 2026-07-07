import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, type Instance } from "ink";
import TextInput from "ink-text-input";
import type { EventBus, CheckpointDecision } from "../core/events.js";
import type { RunControl } from "../core/loop.js";
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
const CONFIRM_HEIGHT = 4; // bordered two-line modal (border 2 + 2 content)
const TICK_MS = 100; // single render/animation cadence (~10fps)

/** Braille spinner frames, advanced by the single render tick (no extra interval). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}

// Home/End escape sequences (with the leading ESC stripped by Ink), across the
// common terminal encodings. Ink's Key type exposes no home/end, so we match
// the raw sequence delivered as `input`.
const HOME_SEQS = new Set(["[H", "[1~", "[7~", "OH", "[7$"]);
const END_SEQS = new Set(["[F", "[4~", "[8~", "OF", "[8$"]);

interface Store {
  model: TuiModel;
  checkpointResolver: ((d: CheckpointDecision) => void) | null;
  confirmReq: { question: string; resolve: (approved: boolean) => void } | null;
  steers: string[];
  control: RunControl | null;
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

function nodeGlyph(status: NodeStatus, frame: string): React.ReactElement {
  switch (status) {
    case "running":
      return <Text color={theme.accent}>{frame}</Text>;
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

function Splash({ m, frame }: { m: TuiModel; frame: string }): React.ReactElement {
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
            <Text color={theme.accent}>{frame} Starting pipeline…</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

interface Viewport {
  visible: StyledLine[];
  viewport: number;
  start: number; // index of first visible line in the full buffer
  total: number; // total buffered lines
  above: number; // lines hidden above the viewport
  below: number; // lines hidden below the viewport
}

/**
 * Slice the flat line buffer to the window the viewport shows. `scrollOffset` is
 * measured in lines up from the bottom: 0 pins to the newest line; the maximum
 * offset shows the very top. Returns the padded visible slice plus the counts of
 * hidden lines above/below for the scroll indicator.
 */
function computeViewport(lines: StyledLine[], height: number, scrollOffset: number): Viewport {
  const viewport = Math.max(1, height);
  const total = lines.length;
  const maxStart = Math.max(0, total - viewport);
  const start = Math.max(0, Math.min(maxStart, maxStart - scrollOffset));
  const visible = lines.slice(start, start + viewport);
  while (visible.length < viewport) visible.push({ text: "" });
  const above = start;
  const below = Math.max(0, total - (start + viewport));
  return { visible, viewport, start, total, above, below };
}

function Transcript({ vp, width }: { vp: Viewport; width: number }): React.ReactElement {
  const { visible, viewport, start, total, above, below } = vp;
  const maxStart = Math.max(0, total - viewport);
  // Scrollbar thumb position along the viewport track.
  const thumbRow = maxStart === 0 ? -1 : Math.round((start / maxStart) * (viewport - 1));

  return (
    <Box flexDirection="row" height={viewport} width={width}>
      <Box flexDirection="column" width={Math.max(1, width - 1)}>
        {visible.map((ln, i) => {
          // Overlay a compact "more above/below" hint on the first/last row.
          if (i === 0 && above > 0) {
            return (
              <Text key={i} color={theme.accent} wrap="truncate-end">
                ▲ {above} more (PgUp)
              </Text>
            );
          }
          if (i === viewport - 1 && below > 0) {
            return (
              <Text key={i} color={theme.accent} wrap="truncate-end">
                ▼ {below} more (PgDn · End to follow)
              </Text>
            );
          }
          return (
            <Text key={i} color={ln.color} dimColor={ln.dim} italic={ln.italic} bold={ln.bold} wrap="truncate-end">
              {ln.text || " "}
            </Text>
          );
        })}
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

function AgentTree({ tree, height, frame }: { tree: TreeNode[]; height: number; frame: string }): React.ReactElement {
  return (
    <Box flexDirection="column" height={height} paddingX={1} overflow="hidden">
      <Text>
        {nodeGlyph(orchestratorStatus(tree), frame)} <Text bold>orchestrator</Text>
      </Text>
      {tree.map((n, i) => {
        const connector = i === tree.length - 1 ? "└" : "├";
        const running = n.status === "running";
        return (
          <Text key={n.name}>
            <Text dimColor> {connector} </Text>
            {nodeGlyph(n.status, frame)} <Text dimColor={n.status === "pending"} bold={running}>
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
      <Text dimColor>PgUp/PgDn scroll · Home/End top/bottom · esc stop</Text>
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
  const [tick, setTick] = useState(0);
  // scrollOffset: lines scrolled up from the bottom. 0 = pinned to newest.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [input, setInput] = useState("");
  // Previous line-buffer length, to hold position when scrolled up and new
  // lines arrive (increase the offset by the growth so the view stays put).
  const prevLenRef = useRef(0);

  // Single render/animation loop: advances the spinner and the splash timer.
  useEffect(() => {
    const id = setInterval(() => {
      if (store.model.phase === "splash") {
        const elapsed = Date.now() - store.model.startTs;
        if (elapsed > 1000 || store.model.blocks.length > 0) store.model = enterMain(store.model);
      }
      setTick((t) => (t + 1) % 1_000_000);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [store]);

  // Redraw immediately on terminal resize so the viewport height/slice recompute
  // without waiting for the next tick (avoids a torn frame at the old size).
  useEffect(() => {
    const onResize = () => setTick((t) => (t + 1) % 1_000_000);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const m = store.model;
  const { cols, rows } = termSize();
  const frame = spinnerFrame(tick);

  // Height budget: the transcript region is the ONLY flexible area. Everything
  // else has a fixed row cost, and the confirm modal (when shown) is reserved
  // out of the transcript height so the column total never exceeds `rows` — an
  // over-tall column is what makes the terminal scroll and the bottom border
  // jitter on redraw.
  const reserved = STATUS_HEIGHT + INPUT_HEIGHT + (store.confirmReq ? CONFIRM_HEIGHT : 0);
  const topHeight = Math.max(3, rows - reserved);
  const leftWidth = Math.max(20, cols - SIDEBAR_WIDTH - 1);
  const contentWidth = Math.max(10, leftWidth - 2);
  const lines = transcriptLines(m.blocks, contentWidth, theme.accent);
  const maxOffset = Math.max(0, lines.length - topHeight);

  // Stick-to-bottom: when new lines arrive, hold the viewed content in place if
  // the user has scrolled up; stay pinned to the bottom when at offset 0.
  useEffect(() => {
    const prev = prevLenRef.current;
    const cur = lines.length;
    prevLenRef.current = cur;
    const grew = cur - prev;
    if (grew > 0) {
      setScrollOffset((o) => (o === 0 ? 0 : Math.min(Math.max(0, cur - topHeight), o + grew)));
    }
  }, [lines.length, topHeight]);

  // Keep the offset valid when the viewport grows (resize) or the buffer shrinks.
  useEffect(() => {
    setScrollOffset((o) => Math.min(o, maxOffset));
  }, [maxOffset]);

  const vp = computeViewport(lines, topHeight, Math.min(scrollOffset, maxOffset));

  useInput((inputChar, key) => {
    // Command confirm: single-key y/n, input box disabled.
    if (store.confirmReq) {
      if (inputChar === "y" || inputChar === "n") {
        const { resolve } = store.confirmReq;
        store.confirmReq = null;
        resolve(inputChar === "y");
      }
      return;
    }
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
      // Quit now: request stop and drop the live frame immediately.
      if (store.control) store.control.stopRequested = true;
      store.onQuit?.();
      return;
    }
    if (key.escape) {
      // Stop the current agent / run gracefully; the pipeline unwinds.
      if (store.control) store.control.stopRequested = true;
      return;
    }
    // Scroll keys — chosen because ink-text-input ignores them, so they work
    // even while the input box is focused and never eat typed characters. Ink's
    // Key type has no home/end, but it delivers their raw escape sequence (ESC
    // stripped) as `input`, so we match those directly.
    const seq = inputChar.replace(/^\u001B/, "");
    const isHome = HOME_SEQS.has(seq);
    const isEnd = END_SEQS.has(seq);
    const page = Math.max(1, topHeight - 1);
    if (key.pageUp) setScrollOffset((o) => Math.min(maxOffset, o + page));
    else if (key.pageDown) setScrollOffset((o) => Math.max(0, o - page));
    else if (isHome) setScrollOffset(maxOffset); // jump to top
    else if (isEnd) setScrollOffset(0); // jump to bottom + re-pin to follow
  });

  if (m.phase === "splash") return <Splash m={m} frame={frame} />;

  const inputActive = !m.checkpoint && !store.confirmReq;
  return (
    <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
      <Box flexDirection="row" height={topHeight} overflow="hidden">
        <Box flexDirection="column" width={leftWidth} height={topHeight} paddingX={1} overflow="hidden">
          <Transcript vp={vp} width={contentWidth} />
        </Box>
        <Box flexDirection="column" width={SIDEBAR_WIDTH} height={topHeight} overflow="hidden">
          <Box flexGrow={1} overflow="hidden">
            <AgentTree tree={m.tree} height={Math.max(1, topHeight - 6)} frame={frame} />
          </Box>
          <UsageBox m={m} />
        </Box>
      </Box>
      {store.confirmReq ? (
        <Box flexDirection="column" height={CONFIRM_HEIGHT} flexShrink={0} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            {store.confirmReq.question}
          </Text>
          <Text>
            <Text bold>[y]</Text> run   <Text bold>[n]</Text> refuse
          </Text>
        </Box>
      ) : null}
      <Box height={STATUS_HEIGHT} flexShrink={0}>
        <StatusBar m={m} />
      </Box>
      <Box height={INPUT_HEIGHT} flexShrink={0}>
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
    </Box>
  );
}

/**
 * While Ink owns the alternate screen, ANY direct write to stdout/stderr from a
 * dependency (a deprecation notice, an SDK warning) corrupts the frame and makes
 * the layout jump. We can't stop the pipeline's own writes here (there are none
 * — they go through the event bus), but we can neutralise stray console.* calls:
 * buffer them while mounted and replay them to stderr after unmount so nothing
 * is lost. Returns a restore function.
 */
function guardConsole(): () => void {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original: Record<string, (...args: unknown[]) => void> = {};
  const buffered: string[] = [];
  for (const name of methods) {
    original[name] = (console[name] as (...a: unknown[]) => void).bind(console);
    (console[name] as unknown) = (...args: unknown[]) => {
      buffered.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
  }
  return () => {
    for (const name of methods) (console[name] as unknown) = original[name];
    if (buffered.length) process.stderr.write(buffered.join("\n") + "\n");
  };
}

export function attachTuiRenderer(bus: EventBus, opts: { model?: string; control?: RunControl } = {}): Renderer {
  const store: Store = {
    model: initModel(packageVersion(), Date.now()),
    checkpointResolver: null,
    confirmReq: null,
    steers: [],
    control: opts.control ?? null,
    onQuit: null,
  };

  const unsubscribe = bus.on((e) => {
    store.model = applyEvent(store.model, e);
    if (store.model.phase === "splash" && (e.type === "stage:start" || e.type === "stage:progress")) {
      store.model = enterMain(store.model);
    }
  });

  const restoreConsole = guardConsole();
  let instance: Instance | null;
  try {
    instance = render(<Dashboard store={store} />, { exitOnCtrlC: false });
  } catch (err) {
    // Mount failed — restore console so the plain-renderer fallback can print.
    restoreConsole();
    unsubscribe();
    throw err;
  }
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
    confirm(question: string): Promise<boolean> {
      return new Promise((resolve) => {
        store.confirmReq = { question, resolve };
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
      restoreConsole();
    },
  };
}
