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

/**
 * An incomplete SGR mouse report at the very end of a chunk — the report was
 * split across two stdin reads (e.g. a chunk ending in `\x1b[<64;4`, or right at
 * the `\x1b[` boundary). Requires at least `\x1b[` so we NEVER hold back a lone
 * ESC keypress (Esc = stop). It may hold a partial non-mouse CSI (`\x1b[12` of an
 * F-key) for one chunk, which is harmless — it completes on the next read. An
 * arrow-key CSI (`\x1b[A`) is NOT held: `A` breaks the char class, so the whole
 * sequence passes through intact. Bounded length stops a malformed run from
 * buffering forever.
 */
const SGR_MOUSE_PARTIAL_TAIL_RE = /\x1b\[[<\d;]{0,20}$/;

export interface MouseFilterResult {
  /** Bytes to forward to the input layer (all mouse reports removed). */
  text: string;
  /** Wheel events dispatched from this chunk, in order. */
  wheels: WheelEvent[];
}

/**
 * Stateful stdin filter: the single consumer of the raw terminal input stream.
 * For each chunk it strips **every complete** SGR mouse report, turns wheel
 * reports (button 64/65) into wheel events, silently drops all other mouse
 * reports (clicks, drags, motion, lowercase-`m` releases), and returns only the
 * remaining non-mouse bytes for the input layer — so Ink never sees mouse bytes.
 *
 * A mouse report split across two chunks is held (`pending`) and prepended to the
 * next chunk instead of leaking through as text.
 */
export function createMouseFilter(): { feed(chunk: string): MouseFilterResult } {
  let pending = "";
  return {
    feed(chunk: string): MouseFilterResult {
      const data = pending + chunk;
      pending = "";
      const wheels: WheelEvent[] = [];
      let text = "";
      let last = 0;
      SGR_MOUSE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SGR_MOUSE_RE.exec(data)) !== null) {
        text += data.slice(last, m.index);
        last = m.index + m[0].length;
        const raw = Number(m[1]);
        if (Number.isFinite(raw) && (raw & 64) !== 0) {
          const dir = raw & 0b11;
          if (dir === 0) wheels.push("wheelUp");
          else if (dir === 1) wheels.push("wheelDown");
          // dir 2/3 = horizontal wheel — dropped.
        }
        // Non-wheel reports (clicks/drags/releases) are dropped: not re-added to text.
      }
      text += data.slice(last);
      // Hold an incomplete trailing mouse report for the next chunk.
      const partial = text.match(SGR_MOUSE_PARTIAL_TAIL_RE);
      if (partial) {
        pending = partial[0];
        text = text.slice(0, text.length - partial[0].length);
      }
      return { text, wheels };
    },
  };
}
