/**
 * Manual mouse-wheel support for the TUI. Ink has no mouse handling, so we:
 *   - turn on xterm mouse reporting + SGR extended mode on mount,
 *   - turn it back OFF on every exit path (a terminal left in mouse-capture mode
 *     is unusable — clicks stop working in the user's shell),
 *   - parse the wheel events out of the raw stdin byte stream ourselves.
 *
 * We only care about the wheel; clicks and drags are ignored.
 */

const ESC = "\x1b";

/** Enable: 1000 = button/wheel reporting, 1006 = SGR extended coordinates. */
export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
/** Disable both, restoring the terminal. Must be written on ANY exit path. */
export const MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;

export type WheelEvent = "wheelUp" | "wheelDown";

// ESC [ < b ; x ; y (M press | m release). Wheels only ever report as press.
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Parse SGR mouse sequences out of a stdin chunk and return the wheel events in
 * order. `b` is the button code: 64 = wheel up, 65 = wheel down (horizontal
 * wheels 66/67 and any button press/drag/release are ignored). Modifier bits
 * (shift +4, meta +8, ctrl +16) may be OR'd into `b`, so we mask them off before
 * classifying.
 *
 * Pure and stateless: unmatched/malformed bytes are skipped, so a chunk that is
 * ordinary keystrokes (or a truncated sequence) simply yields no wheel events.
 */
export function parseMouseEvents(chunk: string): WheelEvent[] {
  const out: WheelEvent[] = [];
  SGR_MOUSE_RE.lastIndex = 0; // reset the stateful global regex before each use
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE_RE.exec(chunk)) !== null) {
    const raw = Number(match[1]);
    if (!Number.isFinite(raw)) continue;
    // Bit 6 (64) marks a wheel event; the low 2 bits pick the direction.
    if ((raw & 64) === 0) continue;
    const dir = raw & 0b11;
    if (dir === 0) out.push("wheelUp");
    else if (dir === 1) out.push("wheelDown");
    // dir 2/3 = horizontal wheel — ignored.
  }
  return out;
}

/** How many lines one wheel notch scrolls (a normal terminal scrolls a few). */
export const WHEEL_LINES = 3;
