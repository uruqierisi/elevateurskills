/**
 * elevateurskills terminal identity. One small palette, used by the TUI.
 * The primary accent is a teal — deliberately not Strix green — so the tool
 * has its own look. Everything else is reserved semantics.
 */
export const theme = {
  /** Primary brand accent (teal). Tool lines, headers, active glyphs. */
  accent: "#3fbfb0",
  /** Reasoning / thinking blocks. */
  thinking: "magenta" as const,
  /** Passed gates. */
  pass: "green" as const,
  /** Failures. */
  fail: "red" as const,
  /** Handoff dividers and secondary chrome. */
  muted: "gray" as const,
};

export const VERSION_FALLBACK = "0.1.0";
export const TAGLINE = "Open-source AI engineering team for your apps";
