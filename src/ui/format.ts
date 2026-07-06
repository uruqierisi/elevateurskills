/** Small shared helpers for both renderers: width-safe truncation and timing. */

/** Terminal width, defensively (piped output reports 0/undefined). */
export function termWidth(fallback = 80): number {
  const c = process.stdout.columns;
  return c && c > 0 ? c : fallback;
}

/** Truncate to n columns with a single-char ellipsis; never returns longer. */
export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  if (n <= 1) return flat.slice(0, Math.max(0, n));
  return flat.slice(0, n - 1) + "…";
}

/** HH:MM:SS for a timestamp. */
export function clockTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/** Human duration: 900ms -> "0.9s", 65000ms -> "1m05s". */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${String(rem).padStart(2, "0")}s`;
}

/** Compact token count: 1234 -> "1.2k". */
export function humanTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// Rough blended $/1M-token estimate by provider. BYO-key, so this is only a
// ballpark for the footer — deliberately conservative and easy to update.
const RATE_PER_MTOK: Record<string, number> = {
  deepseek: 0.4,
  openai: 5,
  anthropic: 6,
  ollama: 0,
};

/** Rough cost estimate in USD for a token count under a `provider/model` string. */
export function estimateCostUsd(totalTokens: number, model: string): number {
  const provider = model.split("/")[0] ?? "deepseek";
  const rate = RATE_PER_MTOK[provider] ?? 0.5;
  return (totalTokens / 1_000_000) * rate;
}

export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
