import type { Tool } from "./types.js";
import type { ToolSchema } from "../llm.js";
import { writeFileTool, readFileTool, editFileTool, listFilesTool } from "./fs.js";
import { runShellTool, runTestsTool } from "./shell.js";
import { readStateTool, writeStateTool } from "./state.js";
import { browserCheckTool, spawnSubagentTool } from "./misc.js";

export type { Tool, ToolContext, ToolResult, StateAccess } from "./types.js";

/** The full shared tool registry. Agents receive a named subset. */
export const ALL_TOOLS: Tool[] = [
  writeFileTool,
  readFileTool,
  editFileTool,
  listFilesTool,
  runShellTool,
  runTestsTool,
  readStateTool,
  writeStateTool,
  browserCheckTool,
  spawnSubagentTool,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Resolve a subset of tools by name. Unknown names throw (fail fast on typos). */
export function selectTools(names: string[]): Tool[] {
  return names.map((n) => {
    const t = BY_NAME.get(n);
    if (!t) throw new Error(`Unknown tool "${n}". Known: ${[...BY_NAME.keys()].join(", ")}`);
    return t;
  });
}

/** OpenAI-format schemas for a set of tools. */
export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}
