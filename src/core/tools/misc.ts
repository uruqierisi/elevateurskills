import { defineSchema, requireString, type Tool } from "./types.js";

/**
 * Frontend smoke check. Uses Playwright if it is installed in the workspace to
 * load a URL and assert the page renders. Playwright is heavy and optional, so
 * this degrades to a clear "not installed" message rather than crashing the run.
 */
export const browserCheckTool: Tool = {
  name: "browser_check",
  schema: defineSchema("browser_check", "Load a URL in a headless browser and report whether it rendered (title + basic body text). Requires Playwright in the workspace.", {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to load, e.g. http://localhost:5173" },
      wait_selector: { type: "string", description: "Optional CSS selector to wait for" },
    },
    required: ["url"],
  }),
  async execute(args, ctx) {
    const url = requireString(args, "url");
    const waitSelector = typeof args.wait_selector === "string" ? args.wait_selector : "";
    const script = [
      "const { chromium } = require('playwright');",
      "(async () => {",
      "  const browser = await chromium.launch();",
      "  const page = await browser.newPage();",
      `  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });`,
      waitSelector ? `  await page.waitForSelector(${JSON.stringify(waitSelector)}, { timeout: 15000 });` : "",
      "  const title = await page.title();",
      "  const text = (await page.innerText('body')).slice(0, 300);",
      "  console.log('BROWSER_CHECK_OK title=' + JSON.stringify(title));",
      "  console.log(text);",
      "  await browser.close();",
      "})().catch((e) => { console.error('BROWSER_CHECK_FAIL ' + e.message); process.exit(1); });",
    ].join("\n");

    const b64 = Buffer.from(script, "utf8").toString("base64");
    const cmd = `node -e "eval(Buffer.from('${b64}','base64').toString())"`;
    ctx.log(`browser_check ${url}`);
    const r = await ctx.sandbox.exec(cmd, { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      const hint = /Cannot find module 'playwright'/.test(r.stderr)
        ? " (Playwright not installed — run `npm i -D playwright && npx playwright install chromium` in the workspace.)"
        : "";
      return { ok: false, content: `browser_check failed${hint}\n${r.stderr || r.stdout}` };
    }
    return { ok: true, content: r.stdout.trim() };
  },
};

/**
 * Orchestrator-only. Lets an agent (in practice, the orchestrator) delegate to
 * a specialist subagent. Wired via ctx.spawnSubagent.
 */
export const spawnSubagentTool: Tool = {
  name: "spawn_subagent",
  schema: defineSchema("spawn_subagent", "Spawn a specialist subagent (planner, architect, backend, frontend, qa, reviewer, devops) with a task and await its result.", {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name" },
      task: { type: "string", description: "Task description / input for the agent" },
    },
    required: ["agent", "task"],
  }),
  async execute(args, ctx) {
    if (!ctx.spawnSubagent) return { ok: false, content: "spawn_subagent is not available in this context." };
    const agent = requireString(args, "agent");
    const task = requireString(args, "task");
    const result = await ctx.spawnSubagent({ agent, task });
    return { ok: true, content: result };
  },
};
