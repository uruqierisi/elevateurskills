import type { EventBus } from "../core/events.js";
import { attachPlainRenderer, type Renderer } from "./plain.js";
import { attachTuiRenderer } from "./tui.js";

export type { Renderer } from "./plain.js";

import type { RunControl } from "../core/loop.js";

export interface RendererOptions {
  /** Force the plain renderer even on a TTY. */
  plain?: boolean;
  /** Resolved `provider/model` for the cost estimate. */
  model?: string;
  /** Shared stop flag the TUI toggles on ctrl-q / esc. */
  control?: RunControl;
  /** Render a one-row layout-debug header (rows/chrome/transcript counts). */
  debugLayout?: boolean;
}

/**
 * Auto-selects a renderer. TUI on an interactive TTY; plain otherwise (non-TTY,
 * CI, piped, or --plain). If the TUI fails to mount for any reason, we fall
 * back to plain rather than crashing the run. (TUI branch added in step 3.)
 */
export function attachRenderer(bus: EventBus, opts: RendererOptions = {}): Renderer {
  const useTui = !opts.plain && Boolean(process.stdout.isTTY);
  if (useTui) {
    try {
      return attachTuiRenderer(bus, { model: opts.model, control: opts.control, debugLayout: opts.debugLayout });
    } catch {
      // Ink failed to mount — degrade to the always-works plain renderer.
    }
  }
  return attachPlainRenderer(bus, { model: opts.model });
}
