import type { Sandbox } from "../sandbox.js";
import type { ToolSchema } from "../llm.js";

/** Minimal key/value view of run state exposed to read_state/write_state. */
export interface StateAccess {
  read(key?: string): unknown;
  write(key: string, value: unknown): void;
}

/** Everything a tool needs to do its job. Assembled per agent by the loop. */
export interface ToolContext {
  sandbox: Sandbox;
  log: (msg: string) => void;
  state?: StateAccess;
  /** Orchestrator-only: spawn a specialist subagent and await its result. */
  spawnSubagent?: (input: { agent: string; task: string }) => Promise<string>;
}

export interface ToolResult {
  /** false signals the model that the action failed and should be corrected. */
  ok: boolean;
  /** Text shown back to the model as the tool result. */
  content: string;
}

export interface Tool {
  name: string;
  schema: ToolSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Helper: build an OpenAI-style function tool schema. */
export function defineSchema(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

/** Coerce an unknown arg to a required non-empty string, or throw. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or invalid string argument "${key}"`);
  }
  return v;
}
