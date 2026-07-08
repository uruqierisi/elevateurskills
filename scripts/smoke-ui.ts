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
import { parseMouseEvents, createMouseFilter } from "../src/ui/mouse.js";
import { formatStatsLine } from "../src/ui/format.js";
import { theme } from "../src/ui/theme.js";
import { Dashboard, stripMouseNoise } from "../src/ui/tui.js";

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

// --- stats-box line formatter (token count + model) ----------------------
console.log("── stats line ──");
{
  // short name fits, right-aligned with padding, exactly `inner` wide
  const s = formatStatsLine("1.2K tok", "gpt-4o", 24);
  check("short name fits, padded to width", s === "1.2K tok" + " ".repeat(24 - 8 - 6) + "gpt-4o" && s.length === 24);
  check("short name: ≥1 space between", / {2,}gpt-4o$/.test(s) || / gpt-4o$/.test(s));
}
{
  // long name truncates from the END with ellipsis, leading chars preserved
  const s = formatStatsLine("394.2K tok", "claude-sonnet-4-6", 24);
  check("long name truncates from end (ellipsis)", s.includes("…") && s.length <= 24);
  check("long name keeps leading chars", s.includes("claude-son") && !s.includes("onnet-4-6"));
  check("long name: token count untouched", s.startsWith("394.2K tok"));
}
{
  // exact-fit boundary: value + 1 space + model == inner exactly
  const s = formatStatsLine("1.2K tok", "deepseek-cha", 21); // 8 + 1 + 12 = 21
  check("exact fit: no truncation, one space", s === "1.2K tok deepseek-cha" && s.length === 21);
}
{
  // one char over the exact fit forces a 1-char model trim (still ≥1 space)
  const s = formatStatsLine("1.2K tok", "deepseek-chat", 21); // model 13, only 12 fit
  check("one-over: model trimmed, space kept", s.length === 21 && s.startsWith("1.2K tok ") && s.endsWith("…"));
}
{
  // 40-char custom model string is bounded and never overflows
  const long = "my-org/custom-fine-tune-2026-07-08-v3-final";
  const s = formatStatsLine("500K tok", long, 24);
  check("40-char custom name bounded to width", s.length === 24 && s.startsWith("500K tok ") && s.endsWith("…"));
}
{
  // minimum separator always present even when the model must shrink a lot
  const s = formatStatsLine("999.9K tok", "anthropic/claude-sonnet", 18);
  check("≥1 space even under heavy truncation", / /.test(s.slice("999.9K tok".length, "999.9K tok".length + 1)) && s.length <= 18);
}
{
  // degenerate: value alone already fills the width → model dropped, value intact
  const s = formatStatsLine("123456 tok", "gpt-4o", 8);
  check("value wider than box: value kept (clipped), not garbled", s === "123456 t" && s.length === 8);
}

// --- stdin filter (consume mouse bytes before Ink) -----------------------
console.log("── stdin filter ──");
{
  // single wheel event: no text leaks, one wheel dispatched
  const f = createMouseFilter();
  const r = f.feed("\x1b[<64;10;10M");
  check("single wheel: text empty, one wheelUp", r.text === "" && JSON.stringify(r.wheels) === JSON.stringify(["wheelUp"]));
}
{
  // burst of many events in one chunk
  const f = createMouseFilter();
  const r = f.feed("\x1b[<64;1;1M\x1b[<64;1;2M\x1b[<65;1;3M\x1b[<64;1;4M");
  check("burst: no text, wheels in order", r.text === "" && JSON.stringify(r.wheels) === JSON.stringify(["wheelUp", "wheelUp", "wheelDown", "wheelUp"]));
}
{
  // mouse event mixed with typed characters in the same chunk
  const f = createMouseFilter();
  const r = f.feed("a\x1b[<64;10;10Mb");
  check('mixed "a<wheel>b": text "ab", one wheelUp', r.text === "ab" && JSON.stringify(r.wheels) === JSON.stringify(["wheelUp"]));
}
{
  // sequence split across two chunks: fragment must NOT leak as text
  const f = createMouseFilter();
  const a = f.feed("x\x1b[<64;4"); // ends mid-sequence
  const b = f.feed("4;12M"); // completes it
  check("split across chunks: no fragment leaks", a.text === "x" && a.wheels.length === 0 && b.text === "" && JSON.stringify(b.wheels) === JSON.stringify(["wheelUp"]));
}
{
  // split with trailing typed char after completion
  const f = createMouseFilter();
  const a = f.feed("\x1b[<65;1"); // partial wheel-down
  const b = f.feed(";1M!"); // complete + a typed "!"
  check("split then typed char: yields '!' + wheelDown", a.text === "" && b.text === "!" && JSON.stringify(b.wheels) === JSON.stringify(["wheelDown"]));
}
{
  // split right at the "\x1b[" boundary (before the "<")
  const f = createMouseFilter();
  const a = f.feed("z\x1b["); // ESC[ at chunk end
  const b = f.feed("<64;5;5M"); // rest of the wheel report
  check("split at ESC[ boundary: no leak, wheel works", a.text === "z" && a.wheels.length === 0 && b.text === "" && JSON.stringify(b.wheels) === JSON.stringify(["wheelUp"]));
}
{
  // clicks and drags are fully discarded (no wheels, no text)
  const f = createMouseFilter();
  const r = f.feed("\x1b[<0;5;5M\x1b[<0;5;5m\x1b[<32;6;6M"); // press, release, drag
  check("click/drag/release discarded (no text, no wheels)", r.text === "" && r.wheels.length === 0);
}
{
  // click mixed with typed text: keep the text, drop the click
  const f = createMouseFilter();
  const r = f.feed("he\x1b[<0;5;5Mllo");
  check("click amid text: text kept, click dropped", r.text === "hello" && r.wheels.length === 0);
}
{
  // a lone ESC (user pressing Esc) must pass straight through, not be buffered
  const f = createMouseFilter();
  const r = f.feed("\x1b");
  check("lone ESC passes through (not buffered)", r.text === "\x1b" && r.wheels.length === 0);
}
{
  // an arrow-key CSI must pass through untouched
  const f = createMouseFilter();
  const r = f.feed("\x1b[A");
  check("arrow-key CSI passes through", r.text === "\x1b[A" && r.wheels.length === 0);
}
{
  // plain typed text is untouched
  const f = createMouseFilter();
  const r = f.feed("build a todo app");
  check("plain text untouched", r.text === "build a todo app" && r.wheels.length === 0);
}

// --- input sanitizer (mouse-noise leak) ----------------------------------
console.log("── input sanitizer ──");
check("keeps normal typed text", stripMouseNoise("build a todo app") === "build a todo app");
check("strips SGR mouse report with ESC", stripMouseNoise("hi\x1b[<64;24;5Mthere") === "hithere");
check("strips SGR mouse report without ESC (Ink stripped it)", stripMouseNoise("hi[<64;24;5Mthere") === "hithere");
check("strips a burst of leaked wheel reports", stripMouseNoise("[<64;1;1M[<64;1;2M[<65;1;3Mx") === "x");
check("strips a bare mouse body (lost [ prefix)", stripMouseNoise("hi<64;5;5Mthere") === "hithere");
check("strips stray control bytes", stripMouseNoise("a\x00b\x07c") === "abc");
check("leaves brackets in real input alone", stripMouseNoise("arr[0] = x") === "arr[0] = x");

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
