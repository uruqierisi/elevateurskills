import React, { useEffect, useMemo, useRef, useState } from "react";
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
  computeViewport,
  createLineCache,
  flattenBlocksCached,
  scrollReduce,
  initialScroll,
  type TuiModel,
  type TreeNode,
  type NodeStatus,
  type Viewport,
  type ScrollState,
  type ScrollAction,
  type ScrollGeom,
} from "./model.js";
import { theme, TAGLINE } from "./theme.js";
import { MOUSE_ON, MOUSE_OFF, WHEEL_LINES, parseMouseEvents } from "./mouse.js";
import type { Renderer, CheckpointBudget } from "./plain.js";
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
  /** When true, render a one-row layout-debug header (rows/chrome/transcript). */
  debugLayout: boolean;
}

// --- small helpers --------------------------------------------------------

/**
 * Strip terminal noise that can leak into the steering input while mouse
 * reporting is on. Ink can hand the raw mouse-report bytes to the focused
 * text input, where they show up as garbage like `[<64;24;5M`. We consume the
 * wheel via our own stdin listener, so anything that reaches the box is noise:
 * remove SGR mouse reports (with or without the leading ESC), other ESC-led CSI
 * sequences, and stray control bytes — leaving only what the user actually typed.
 */
export function stripMouseNoise(v: string): string {
  return v
    .replace(/\x1b?\[<\d+;\d+;\d+[Mm]/g, "") // SGR mouse reports
    .replace(/\x1b\[[\d;?]*[A-Za-z~]/g, "") // other CSI sequences (ESC-led only)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // stray C0 control bytes
}

function termSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function tokensBig(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Basename of a path (the file/dir a checkpoint points at). */
function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Hard-clip a string to a single row of `width` columns (ellipsis if cut). Every
 * single-line chrome element passes through this so it can NEVER wrap to a second
 * row — an uncounted wrapped row is what pushes the layout past the terminal
 * height and makes the border jitter.
 */
function clip1(s: string, width: number): string {
  const w = Math.max(1, width);
  const flat = s.replace(/\s+/g, " ");
  return flat.length <= w ? flat : flat.slice(0, Math.max(0, w - 1)) + "…";
}

function nodeGlyph(status: NodeStatus, frame: string): React.ReactElement {
  switch (status) {
    case "running":
      return <Text color={theme.accent}>{frame}</Text>;
    case "done":
      return <Text color="green">✓</Text>;
    case "failed":
      return <Text color="red">✗</Text>;
    case "skipped":
      return <Text dimColor>–</Text>;
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

function Transcript({ vp, width, following }: { vp: Viewport; width: number; following: boolean }): React.ReactElement {
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
            // Not following (frozen viewport): advertise the backlog + how to
            // re-engage follow. `following` is false here whenever below > 0.
            return (
              <Text key={i} color={theme.accent} wrap="truncate-end">
                ▼ {below} new lines (End{following ? "" : " to follow"})
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
            {nodeGlyph(n.status, frame)} <Text dimColor={n.status === "pending" || n.status === "skipped"} bold={running}>
              {n.name}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** Colour for a budget fraction: green under 80%, yellow at 80%, red at 100%. */
function budgetColor(used: number, max: number): string | undefined {
  if (max <= 0) return undefined;
  const frac = used / max;
  if (frac >= 1) return "red";
  if (frac >= 0.8) return "yellow";
  return undefined;
}

function UsageBox({ m }: { m: TuiModel }): React.ReactElement {
  const cost = formatCostUsd(estimateCostUsd(m.totalTokens, m.model));
  const b = m.budget;
  const tokColor = b ? budgetColor(b.tokens, b.maxTokens) : undefined;
  const callColor = b ? budgetColor(b.toolCalls, b.maxToolCalls) : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{m.model || "—"}</Text>
      <Text>{tokensBig(m.totalTokens)} tokens</Text>
      {b ? (
        <>
          <Text color={tokColor}>
            {tokensBig(b.tokens)} / {tokensBig(b.maxTokens)} tok
          </Text>
          <Text color={callColor}>
            {b.toolCalls} / {b.maxToolCalls} calls
          </Text>
        </>
      ) : null}
      <Text dimColor>
        ~{cost} · v{m.version}
      </Text>
    </Box>
  );
}

/**
 * Exactly one row, always. Renders a single truncated Text so it can never wrap
 * — the checkpoint bar in particular used to wrap to two rows and tip the whole
 * column past `rows`, which is what made the border jitter worse at a checkpoint.
 */
function StatusBar({ m, cols }: { m: TuiModel; cols: number }): React.ReactElement {
  if (m.checkpoint) {
    const budget = m.checkpoint.budget;
    const targets = m.checkpoint.artifactPaths.map(baseName).join(", ");
    // Kept to a single truncated row (like the normal checkpoint bar) so it can
    // never wrap and tip the column past `rows`.
    const text = budget
      ? `⚠ ${m.checkpoint.stage} hit its ${budget.reason === "budget-exceeded" ? "token budget" : "tool-call limit"} · [c]ontinue partial [r]etry higher [q]uit`
      : `[c]ontinue [r]etry [q]uit · ${targets}`;
    return (
      <Text color={budget ? "yellow" : theme.accent} wrap="truncate-end">
        {clip1(text, cols)}
      </Text>
    );
  }
  const text = "wheel/PgUp/PgDn scroll · Home/End top/bottom · esc stop · ctrl-q quit";
  return (
    <Text dimColor wrap="truncate-end">
      {clip1(text, cols)}
    </Text>
  );
}

function InputArea({
  value,
  onChange,
  onSubmit,
  active,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  active: boolean;
  width: number;
}): React.ReactElement {
  // Full-width bordered row pinned to the bottom. Without an explicit width the
  // bordered Box shrank to its content ("> "), collapsing into a ~2-char box in
  // the corner. The prompt marker is fixed-width; the TextInput flexes to fill
  // the rest and scrolls horizontally for long input.
  return (
    <Box borderStyle="round" borderColor="green" paddingX={1} width={Math.max(4, width)}>
      <Text color="green">{"> "}</Text>
      <Box flexGrow={1}>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus={active} placeholder="" />
      </Box>
    </Box>
  );
}

// --- dashboard ------------------------------------------------------------

export function Dashboard({ store }: { store: Store }): React.ReactElement {
  const [tick, setTick] = useState(0);
  // Viewport scroll/follow state — all scroll inputs flow through the reducer.
  const [scroll, setScroll] = useState<ScrollState>(initialScroll);
  const [input, setInput] = useState("");
  // Previous line-buffer length, to detect growth (hold position when scrolled
  // up; stay pinned when following).
  const prevLenRef = useRef(0);
  // Incremental flatten cache: only new/changed blocks are re-wrapped per event.
  const lineCacheRef = useRef(createLineCache());
  // Latest viewport geometry, read by the async mouse handler (which is bound
  // once and can't close over per-render values).
  const geomRef = useRef<ScrollGeom>({ total: 0, height: 1 });

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

  // Height budget: the transcript region is the ONLY flexible area. Every other
  // element is a KNOWN fixed row count and is truncated so it can never wrap.
  // `chrome` is the sum of those fixed rows (recomputed as the confirm/debug rows
  // toggle); `topHeight = rows - chrome`, so transcript + chrome == rows exactly.
  // Anything that pushed the total past `rows` is what made the border jitter.
  const debugRows = store.debugLayout ? 1 : 0;
  const chrome = debugRows + STATUS_HEIGHT + INPUT_HEIGHT + (store.confirmReq ? CONFIRM_HEIGHT : 0);
  const topHeight = Math.max(1, rows - chrome);
  const leftWidth = Math.max(20, cols - SIDEBAR_WIDTH - 1);
  const contentWidth = Math.max(10, leftWidth - 2);
  // Flatten only when blocks or the wrap width change — not on every spinner
  // tick — and only re-wrap the blocks that actually changed (see the cache).
  const lines = useMemo(
    () => flattenBlocksCached(lineCacheRef.current, m.blocks, contentWidth, theme.accent),
    [m.blocks, contentWidth],
  );
  const maxOffset = Math.max(0, lines.length - topHeight);
  const geom: ScrollGeom = { total: lines.length, height: topHeight };
  geomRef.current = geom;
  const dispatchScroll = (action: ScrollAction) => setScroll((s) => scrollReduce(s, action, geomRef.current));

  // New lines arrived: follow → stay pinned; scrolled up → hold position.
  useEffect(() => {
    const prev = prevLenRef.current;
    const cur = lines.length;
    prevLenRef.current = cur;
    const grew = cur - prev;
    if (grew > 0) dispatchScroll({ type: "grew", amount: grew });
  }, [lines.length, topHeight]);

  // Re-clamp when the viewport grows (resize) or the buffer re-wraps/shrinks.
  useEffect(() => {
    dispatchScroll({ type: "clamp" });
  }, [maxOffset]);

  // Mouse wheel: enable xterm mouse reporting on mount, dispatch wheel ticks to
  // the same reducer, and ALWAYS disable it on unmount (ctrl-q, esc-stop, and
  // stop() all unmount, running this cleanup). A process-level net in
  // attachTuiRenderer covers SIGINT/crash where cleanup may not run.
  useEffect(() => {
    const stdout = process.stdout;
    const stdin = process.stdin;
    if (!stdout.isTTY) return; // no-op under tests / pipes
    stdout.write(MOUSE_ON);
    const onData = (buf: Buffer | string): void => {
      for (const ev of parseMouseEvents(buf.toString())) {
        dispatchScroll(ev === "wheelUp" ? { type: "up", amount: WHEEL_LINES } : { type: "down", amount: WHEEL_LINES });
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      try {
        stdout.write(MOUSE_OFF);
      } catch {
        /* stream may be gone during teardown */
      }
    };
  }, []);

  const vp = computeViewport(lines, topHeight, Math.min(scroll.offset, maxOffset));

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
    if (key.pageUp) dispatchScroll({ type: "pageUp" });
    else if (key.pageDown) dispatchScroll({ type: "pageDown" });
    else if (isHome) dispatchScroll({ type: "top" }); // jump to top
    else if (isEnd) dispatchScroll({ type: "bottom" }); // jump to bottom + re-follow
  });

  if (m.phase === "splash") return <Splash m={m} frame={frame} />;

  const inputActive = !m.checkpoint && !store.confirmReq;
  // The rendered line total: header + transcript rows + confirm + status + input.
  // This MUST equal rows; --debug-layout surfaces the numbers to confirm it.
  const renderedRows = chrome + topHeight;
  return (
    <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
      {store.debugLayout ? (
        <Box height={debugRows} flexShrink={0}>
          <Text color="yellow" wrap="truncate-end">
            {clip1(`layout rows=${rows} chrome=${chrome} transcript=${topHeight} rendered=${renderedRows} lines=${lines.length}`, cols)}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="row" height={topHeight} overflow="hidden">
        <Box flexDirection="column" width={leftWidth} height={topHeight} paddingX={1} overflow="hidden">
          <Transcript vp={vp} width={contentWidth} following={scroll.follow} />
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
          <Text color="yellow" bold wrap="truncate-end">
            {clip1(store.confirmReq.question, Math.max(1, cols - 4))}
          </Text>
          <Text wrap="truncate-end">
            <Text bold>[y]</Text> run   <Text bold>[n]</Text> refuse
          </Text>
        </Box>
      ) : null}
      <Box height={STATUS_HEIGHT} flexShrink={0}>
        <StatusBar m={m} cols={cols} />
      </Box>
      <Box height={INPUT_HEIGHT} flexShrink={0} width={cols}>
        <InputArea
          value={input}
          onChange={(v) => setInput(stripMouseNoise(v))}
          active={inputActive}
          width={cols}
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

export function attachTuiRenderer(bus: EventBus, opts: { model?: string; control?: RunControl; debugLayout?: boolean } = {}): Renderer {
  const store: Store = {
    model: initModel(packageVersion(), Date.now()),
    checkpointResolver: null,
    confirmReq: null,
    steers: [],
    control: opts.control ?? null,
    onQuit: null,
    debugLayout: opts.debugLayout ?? false,
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

  // Safety net: the Dashboard effect disables mouse reporting on unmount, but a
  // SIGINT or hard crash can bypass React cleanup and leave the terminal stuck
  // in mouse-capture mode. Restore it unconditionally on process teardown too.
  const restoreMouse = (): void => {
    try {
      if (process.stdout.isTTY) process.stdout.write(MOUSE_OFF);
    } catch {
      /* stream gone */
    }
  };
  process.once("exit", restoreMouse);
  process.once("SIGINT", restoreMouse);

  return {
    awaitCheckpoint(stage: string, artifactPaths: string[], budget?: CheckpointBudget): Promise<CheckpointDecision> {
      return new Promise((resolve) => {
        store.model = { ...store.model, checkpoint: { stage, artifactPaths, budget } };
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
      restoreMouse();
      process.off("exit", restoreMouse);
      process.off("SIGINT", restoreMouse);
      restoreConsole();
    },
  };
}
