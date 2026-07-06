import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, join } from "node:path";
import { defineSchema, requireString, type Tool } from "./types.js";

/** Writes (creating parent dirs) a file inside the sandbox workspace. */
export const writeFileTool: Tool = {
  name: "write_file",
  schema: defineSchema("write_file", "Create or overwrite a file in the workspace. Creates parent directories as needed.", {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path, e.g. src/index.ts" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  }),
  async execute(args, ctx) {
    const path = requireString(args, "path");
    const content = typeof args.content === "string" ? args.content : "";
    const abs = ctx.sandbox.resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    ctx.log(`write_file ${path} (${content.length} bytes)`);
    return { ok: true, content: `Wrote ${path} (${content.length} bytes).` };
  },
};

export const readFileTool: Tool = {
  name: "read_file",
  schema: defineSchema("read_file", "Read a UTF-8 file from the workspace.", {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative path" } },
    required: ["path"],
  }),
  async execute(args, ctx) {
    const path = requireString(args, "path");
    const abs = ctx.sandbox.resolve(path);
    if (!existsSync(abs)) return { ok: false, content: `File not found: ${path}` };
    const content = readFileSync(abs, "utf8");
    return { ok: true, content };
  },
};

/** Replace an exact substring in an existing file (single or all occurrences). */
export const editFileTool: Tool = {
  name: "edit_file",
  schema: defineSchema("edit_file", "Replace an exact string in a file. Fails if old_string is absent or (when replace_all is false) ambiguous.", {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  }),
  async execute(args, ctx) {
    const path = requireString(args, "path");
    const oldStr = requireString(args, "old_string");
    const newStr = typeof args.new_string === "string" ? args.new_string : "";
    const replaceAll = args.replace_all === true;
    const abs = ctx.sandbox.resolve(path);
    if (!existsSync(abs)) return { ok: false, content: `File not found: ${path}` };
    const original = readFileSync(abs, "utf8");
    const count = original.split(oldStr).length - 1;
    if (count === 0) return { ok: false, content: `old_string not found in ${path}` };
    if (count > 1 && !replaceAll) {
      return { ok: false, content: `old_string appears ${count} times in ${path}; set replace_all or make it unique.` };
    }
    const updated = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    writeFileSync(abs, updated, "utf8");
    ctx.log(`edit_file ${path} (${count} replacement${count === 1 ? "" : "s"})`);
    return { ok: true, content: `Edited ${path} (${count} replacement${count === 1 ? "" : "s"}).` };
  },
};

/** Recursive directory listing, skipping heavy/noise dirs. */
export const listFilesTool: Tool = {
  name: "list_files",
  schema: defineSchema("list_files", "List files under a workspace directory (recursive, skips node_modules/.git/dist).", {
    type: "object",
    properties: { path: { type: "string", description: "Directory (default '.')" } },
    required: [],
  }),
  async execute(args, ctx) {
    const rel = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
    const root = ctx.sandbox.resolve(rel);
    if (!existsSync(root)) return { ok: false, content: `Directory not found: ${rel}` };
    const skip = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage"]);
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const abs = join(dir, entry);
        const st = statSync(abs);
        const relPath = relative(ctx.sandbox.root, abs).split("\\").join("/");
        if (st.isDirectory()) {
          out.push(relPath + "/");
          walk(abs);
        } else {
          out.push(relPath);
        }
      }
    };
    walk(root);
    return { ok: true, content: out.length ? out.join("\n") : "(empty)" };
  },
};
