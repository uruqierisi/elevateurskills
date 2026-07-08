import React from "react";
import { render } from "ink-testing-library";
import {
  initModel,
  applyEvent,
  transcriptLines,
  createLineCache,
  flattenBlocksCached,
  computeViewport,
  scrollReduce,
  initialScroll,
  type ScrollState,
  type ScrollGeom,
  type TranscriptBlock,
  type StyledLine,
} from "../src/ui/model.js";
import { parseMouseEvents } from "../src/ui/mouse.js";
import { theme } from "../src/ui/theme.js";
import { Dashboard } from "../src/ui/tui.js";

/**
 * Unit checks for the scroll/follow reducer, the incremental flatten cache, the
 * viewport slicer, and the SGR mouse parser — plus a mount check that the
 * steering input renders full-width. Pure logic, no TTY required. Prints
 * PASS/FAIL per the smoke-script convention and sets the exit code.
 */

let ok = true;
function check(label: string, pass: boolean): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
function eqLines(a: StyledLine[], b: StyledLine[]): boolean {
  return a.length === b.length && a.every((l, i) => l.text === b[i].text);
}

// --- SGR mouse parser -----------------------------------------------------
console.log("── mouse parser ──");
check("wheel up (b=64)", JSON.stringify(parseMouseEvents("\x1b[<64;10;5M")) === JSON.stringify(["wheelUp"]));
check("wheel down (b=65)", JSON.stringify(parseMouseEvents("\x1b[<65;10;5M")) === JSON.stringify(["wheelDown"]));
check("wheel up with ctrl modifier (64|16=80)", JSON.stringify(parseMouseEvents("\x1b[<80;1;1M")) === JSON.stringify(["wheelUp"]));
check("wheel down with shift modifier (65|4=69)", JSON.stringify(parseMouseEvents("\x1b[<69;1;1M")) === JSON.stringify(["wheelDown"]));
check("release terminator 'm' still parses", JSON.stringify(parseMouseEvents("\x1b[<64;1;1m")) === JSON.stringify(["wheelUp"]));
check("left click (b=0) ignored", parseMouseEvents("\x1b[<0;5;5M").length === 0);
check("drag (b=32) ignored", parseMouseEvents("\x1b[<32;5;5M").length === 0);
check("horizontal wheel (b=66) ignored", parseMouseEvents("\x1b[<66;5;5M").length === 0);
check("truncated sequence ignored", parseMouseEvents("\x1b[<64;10").length === 0);
check("plain keystrokes ignored", parseMouseEvents("hello world").length === 0);
check("empty chunk", parseMouseEvents("").length === 0);
check(
  "multiple events in one chunk, in order",
  JSON.stringify(parseMouseEvents("\x1b[<64;1;1M\x1b[<65;2;2M\x1b[<64;3;3M")) === JSON.stringify(["wheelUp", "wheelDown", "wheelUp"]),
);
check("stateless across calls (no leftover regex index)", JSON.stringify(parseMouseEvents("\x1b[<64;1;1M")) === JSON.stringify(["wheelUp"]));

// --- scroll / follow reducer ---------------------------------------------
console.log("── scroll reducer ──");
const G: ScrollGeom = { total: 100, height: 10 }; // maxOffset = 90, page = 9
const inv = (s: ScrollState) => s.follow === (s.offset === 0); // follow ⟺ offset 0

check("initial is follow at bottom", initialScroll.offset === 0 && initialScroll.follow === true);
const upped = scrollReduce(initialScroll, { type: "up", amount: 3 }, G);
check("wheel up disengages follow", upped.offset === 3 && upped.follow === false && inv(upped));
check("up clamps at top (maxOffset)", scrollReduce({ offset: 88, follow: false }, { type: "up", amount: 10 }, G).offset === 90);
const back = scrollReduce({ offset: 3, follow: false }, { type: "down", amount: 3 }, G);
check("down to bottom re-enables follow", back.offset === 0 && back.follow === true);
check("partial down stays unfollowed", scrollReduce({ offset: 5, follow: false }, { type: "down", amount: 3 }, G).offset === 2);
check("pageUp moves by height-1", scrollReduce(initialScroll, { type: "pageUp" }, G).offset === 9);
check("pageDown to bottom re-follows", scrollReduce({ offset: 9, follow: false }, { type: "pageDown" }, G).follow === true);
check("top (Home) goes to maxOffset, unfollowed", (() => { const s = scrollReduce(initialScroll, { type: "top" }, G); return s.offset === 90 && s.follow === false; })());
check("bottom (End) re-follows", (() => { const s = scrollReduce({ offset: 90, follow: false }, { type: "bottom" }, G); return s.offset === 0 && s.follow === true; })());

// grew: following stays pinned; scrolled-up holds position; never yanks down.
check("grew while following stays pinned", scrollReduce({ offset: 0, follow: true }, { type: "grew", amount: 5 }, { total: 105, height: 10 }).offset === 0);
const held = scrollReduce({ offset: 10, follow: false }, { type: "grew", amount: 5 }, { total: 115, height: 10 });
check("grew while scrolled up holds viewed lines (offset += grew)", held.offset === 15 && held.follow === false);
// maxOffset = 115 - 10 = 105; 98 + 10 = 108 clamps to 105 (stays at the top).
check("grew clamps at the top boundary", scrollReduce({ offset: 98, follow: false }, { type: "grew", amount: 10 }, { total: 115, height: 10 }).offset === 105);

// clamp: resize/rewrap re-clamps the offset.
check("clamp shrinks offset when viewport grows", scrollReduce({ offset: 90, follow: false }, { type: "clamp" }, { total: 50, height: 10 }).offset === 40);
check("clamp keeps follow pinned", scrollReduce({ offset: 0, follow: true }, { type: "clamp" }, { total: 50, height: 10 }).offset === 0);
const collapsed = scrollReduce({ offset: 5, follow: false }, { type: "clamp" }, { total: 8, height: 10 });
check("clamp to fit re-enables follow (nothing to scroll)", collapsed.offset === 0 && collapsed.follow === true);

// --- viewport slicer ------------------------------------------------------
console.log("── viewport ──");
const buf = (n: number): StyledLine[] => Array.from({ length: n }, (_, i) => ({ text: `L${i}` }));
{
  const vp = computeViewport(buf(100), 10, 0);
  check("offset 0 pins bottom (start=90, below=0)", vp.start === 90 && vp.above === 90 && vp.below === 0 && vp.visible.length === 10);
}
{
  const vp = computeViewport(buf(100), 10, 90);
  check("max offset shows top (start=0, above=0, below=90)", vp.start === 0 && vp.above === 0 && vp.below === 90);
}
{
  const vp = computeViewport(buf(100), 10, 45);
  check("mid offset splits above/below", vp.start === 45 && vp.above === 45 && vp.below === 45);
}
{
  const vp = computeViewport(buf(100), 10, 1000);
  check("over-max offset clamps to top", vp.start === 0 && vp.above === 0);
}
{
  const vp = computeViewport(buf(5), 10, 0);
  check("fewer lines than height: padded, no hidden", vp.above === 0 && vp.below === 0 && vp.visible.length === 10);
}
{
  const vp = computeViewport(buf(10), 10, 0);
  check("exactly height lines: no scroll region", vp.start === 0 && vp.above === 0 && vp.below === 0);
}

// --- incremental flatten cache -------------------------------------------
console.log("── flatten cache ──");
let m = initModel("0.1.0", Date.now());
const events = [
  { type: "stage:start", stage: "planner", agent: "planner" },
  { type: "agent:thinking", stage: "planner", text: "thinking about the schema and endpoints for the service" },
  { type: "agent:token", stage: "planner", text: "some streamed assistant text that is fairly long and wraps" },
  { type: "agent:todo", stage: "planner", items: [{ text: "a", done: false }, { text: "b", done: false }] },
  { type: "stage:progress", stage: "planner", tool: "write_file", summary: "plan.json" },
] as const;
for (const e of events) m = applyEvent(m, { ...e, ts: Date.now() } as never);

const cache = createLineCache();
const W = 40;
const cached1 = flattenBlocksCached(cache, m.blocks, W, theme.accent);
check("cache output equals transcriptLines", eqLines(cached1, transcriptLines(m.blocks, W, theme.accent)));

const cached2 = flattenBlocksCached(cache, m.blocks, W, theme.accent);
check("unchanged re-flatten reuses cached line objects (===)", cached1.length === cached2.length && cached1.every((l, i) => l === cached2[i]));

const rewrapped = flattenBlocksCached(cache, m.blocks, 24, theme.accent);
check("width change re-wraps (different line objects)", rewrapped.length > 0 && rewrapped[0] !== cached1[0] || rewrapped.length !== cached1.length);
check("width change matches transcriptLines at new width", eqLines(flattenBlocksCached(cache, m.blocks, 24, theme.accent), transcriptLines(m.blocks, 24, theme.accent)));

// Todo mutates in place (same block id) — cache must invalidate that block.
const before = flattenBlocksCached(cache, m.blocks, W, theme.accent);
const m2 = applyEvent(m, { type: "agent:todo", stage: "planner", items: [{ text: "a", done: true }, { text: "b", done: false }], ts: Date.now() } as never);
const after = flattenBlocksCached(cache, m2.blocks, W, theme.accent);
check("todo in-place update invalidates its cached lines", !eqLines(before, after) && eqLines(after, transcriptLines(m2.blocks, W, theme.accent)));

// Eviction: a block dropping out of the buffer is removed from the cache.
const sliced = { ...m2, blocks: m2.blocks.slice(1) };
flattenBlocksCached(cache, sliced.blocks, W, theme.accent);
const liveIds = new Set(sliced.blocks.map((b: TranscriptBlock) => b.id));
check("cache evicts blocks no longer in buffer", [...cache.map.keys()].every((id) => liveIds.has(id)) && cache.map.size === sliced.blocks.length);

// --- Task 3: full-width input row (mount) ---------------------------------
console.log("── input width (mount) ──");
{
  const cols = 100;
  process.stdout.columns = cols;
  (process.stdout as unknown as { rows: number }).rows = 24;
  const mm = { ...initModel("0.1.0", Date.now()), phase: "main" as const };
  const store = { model: mm, checkpointResolver: null, confirmReq: null, steers: [], control: null, onQuit: null, debugLayout: false };
  const r = render(React.createElement(Dashboard, { store: store as never }));
  const frame = r.lastFrame() ?? "";
  r.unmount();
  const rows = frame.split("\n");
  // The input's top border is the last "╭───╮" row; it must span ~full width,
  // not the old ~7-char collapsed box.
  const borderRows = rows.filter((l) => /^╭─+╮$/.test(l.trim()));
  const inputBorder = borderRows[borderRows.length - 1] ?? "";
  const promptRow = rows.find((l) => l.includes("│ >")) ?? "";
  check("input border spans most of the terminal width", inputBorder.trim().length >= cols - 4);
  check("prompt marker row is full width", promptRow.length >= cols - 4);
  check("dashboard mounts and shows help", /wheel\/PgUp/.test(frame) || frame.includes("orchestrator"));
}

console.log(ok ? "\n[smoke-ui] OK" : "\n[smoke-ui] FAILED");
process.exitCode = ok ? 0 : 1;
