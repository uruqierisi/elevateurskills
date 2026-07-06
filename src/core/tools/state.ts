import { defineSchema, requireString, type Tool } from "./types.js";

/** Reads run-level shared state (the whole object, or one key). */
export const readStateTool: Tool = {
  name: "read_state",
  schema: defineSchema("read_state", "Read shared run state. Omit key to read everything.", {
    type: "object",
    properties: { key: { type: "string", description: "Optional state key" } },
    required: [],
  }),
  async execute(args, ctx) {
    if (!ctx.state) return { ok: false, content: "State is not available in this context." };
    const key = typeof args.key === "string" && args.key.length > 0 ? args.key : undefined;
    const value = ctx.state.read(key);
    return { ok: true, content: JSON.stringify(value ?? null, null, 2) };
  },
};

/** Writes a JSON-serialisable value to a run-state key. */
export const writeStateTool: Tool = {
  name: "write_state",
  schema: defineSchema("write_state", "Write a JSON value to a shared run-state key.", {
    type: "object",
    properties: {
      key: { type: "string" },
      value: { description: "Any JSON value" },
    },
    required: ["key", "value"],
  }),
  async execute(args, ctx) {
    if (!ctx.state) return { ok: false, content: "State is not available in this context." };
    const key = requireString(args, "key");
    ctx.state.write(key, args.value);
    ctx.log(`write_state ${key}`);
    return { ok: true, content: `Wrote state key "${key}".` };
  },
};
