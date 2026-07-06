import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.js";
import type { RunState } from "./state.js";
import type { Sandbox } from "./sandbox.js";

/**
 * Agent registry. Each specialist is defined by four things (per the spec):
 * a role.md system prompt, a tool subset, an input/output contract, and a
 * validation gate. Two run modes:
 *
 *   - "contract": the agent reasons and returns one JSON object as its final
 *     message. The orchestrator persists it as an artifact and validates it.
 *     (planner -> plan.json, architect -> architecture.json)
 *   - "builder": the agent works in the workspace with file/shell tools. The
 *     gate inspects the workspace (installs, builds, tests).
 */

export interface GateContext {
  state: RunState;
  sandbox: Sandbox;
  log: (msg: string) => void;
}

export interface GateResult {
  pass: boolean;
  detail: string;
}

export type Gate = (ctx: GateContext) => Promise<GateResult>;

export interface AgentDef {
  name: string;
  roleFile: string;
  tools: string[];
  mode: "contract" | "builder";
  /** For contract agents: the artifact filename its JSON output is saved to. */
  artifact?: string;
  maxIterations: number;
  /** Builds the task/input string handed to the agent, using run state. */
  buildTask(state: RunState): string;
  gate: Gate;
}

function loadRole(agent: string): string {
  const p = join(REPO_ROOT, "agents", agent, "role.md");
  return readFileSync(p, "utf8");
}

export function agentSystemPrompt(agent: string): string {
  return loadRole(agent);
}

// --- gate helpers ---------------------------------------------------------

function ok(detail: string): GateResult {
  return { pass: true, detail };
}
function fail(detail: string): GateResult {
  return { pass: false, detail };
}

/** Run a sequence of shell steps; stop at the first non-zero exit. */
async function runSteps(
  ctx: GateContext,
  cwd: string,
  steps: Array<{ label: string; command: string; timeoutMs?: number; env?: Record<string, string> }>,
): Promise<GateResult> {
  for (const step of steps) {
    ctx.log(`gate: ${step.label} (${step.command})`);
    const r = await ctx.sandbox.exec(step.command, { cwd, timeoutMs: step.timeoutMs ?? 300_000, env: step.env });
    if (r.exitCode !== 0) {
      const out = `${r.stdout}\n${r.stderr}`.trim().slice(-4000);
      return fail(`Step "${step.label}" failed (exit ${r.exitCode})${r.timedOut ? " [timeout]" : ""}:\n${out}`);
    }
  }
  return ok(`All ${steps.length} step(s) passed.`);
}

// --- contract validators --------------------------------------------------

const planGate: Gate = async ({ state }) => {
  if (!state.hasArtifact("plan.json")) return fail("plan.json was not produced.");
  let plan: unknown;
  try {
    plan = state.readArtifact("plan.json");
  } catch (e) {
    return fail(`plan.json is not valid JSON: ${(e as Error).message}`);
  }
  const p = plan as { tasks?: unknown; project?: unknown };
  if (!p || typeof p !== "object") return fail("plan.json must be a JSON object.");
  if (!Array.isArray(p.tasks) || p.tasks.length === 0) return fail("plan.json must have a non-empty tasks array.");
  return ok(`Plan has ${p.tasks.length} task(s).`);
};

const architectureGate: Gate = async ({ state }) => {
  if (!state.hasArtifact("architecture.json")) return fail("architecture.json was not produced.");
  let arch: any;
  try {
    arch = state.readArtifact("architecture.json");
  } catch (e) {
    return fail(`architecture.json is not valid JSON: ${(e as Error).message}`);
  }
  const problems: string[] = [];
  if (!arch.projectName) problems.push("missing projectName");
  if (!arch.stack) problems.push("missing stack");
  if (!arch.database?.models?.length) problems.push("database.models must be non-empty");
  if (arch.database?.provider && arch.database.provider !== "postgresql") {
    problems.push(`database.provider must be "postgresql" (got "${arch.database.provider}")`);
  }
  if (!arch.api?.endpoints?.length) problems.push("api.endpoints must be non-empty");
  if (!Array.isArray(arch.folders) || arch.folders.length === 0) problems.push("folders must be non-empty");
  const hasHealth = Array.isArray(arch.api?.endpoints)
    ? arch.api.endpoints.some((e: any) => String(e.path).includes("/health"))
    : false;
  if (!hasHealth) problems.push("api.endpoints must include a /health endpoint");
  if (problems.length) return fail(`architecture.json invalid: ${problems.join("; ")}`);
  return ok(`Contract frozen: ${arch.database.models.length} model(s), ${arch.api.endpoints.length} endpoint(s).`);
};

// --- builder gates --------------------------------------------------------

// A syntactically-valid placeholder URL. prisma generate/validate only parse
// the schema and read env(); they never open a connection, so this is enough to
// prove the schema and migrations are valid without a live database.
const DUMMY_DB_URL = "postgresql://user:pass@localhost:5432/app";

const backendGate: Gate = (ctx) =>
  runSteps(ctx, "backend", [
    { label: "install", command: "npm install" },
    { label: "prisma generate", command: "npx prisma generate", env: { DATABASE_URL: DUMMY_DB_URL } },
    { label: "prisma validate", command: "npx prisma validate", env: { DATABASE_URL: DUMMY_DB_URL } },
    { label: "build", command: "npm run build" },
    { label: "test", command: "npm test", env: { NODE_ENV: "test" } },
  ]);

const frontendGate: Gate = (ctx) =>
  runSteps(ctx, "frontend", [
    { label: "install", command: "npm install" },
    { label: "build", command: "npm run build" },
  ]);

const qaGate: Gate = (ctx) =>
  runSteps(ctx, "backend", [{ label: "test", command: "npm test", env: { NODE_ENV: "test" } }]);

const reviewerGate: Gate = (ctx) =>
  runSteps(ctx, "backend", [
    { label: "lint", command: "npm run lint" },
    { label: "test", command: "npm test", env: { NODE_ENV: "test" } },
  ]);

const devopsGate: Gate = async ({ sandbox }) => {
  const required = [
    "backend/Dockerfile",
    "frontend/Dockerfile",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
  ];
  const missing = required.filter((f) => !existsSync(sandbox.resolve(f)));
  if (missing.length) return fail(`Missing deploy files: ${missing.join(", ")}`);
  return ok("Deployment files present.");
};

// --- task builders --------------------------------------------------------

function contractContext(state: RunState): string {
  return `Target stack: ${state.manifest.stack}\nRequest: ${state.manifest.request}`;
}

function frozenContractBlock(state: RunState): string {
  const arch = state.readArtifactText("architecture.json");
  return `The frozen contract (architecture.json) is:\n\n\`\`\`json\n${arch}\n\`\`\``;
}

// --- registry -------------------------------------------------------------

const FILE_TOOLS = ["write_file", "read_file", "edit_file", "list_files", "run_shell", "run_tests", "read_state"];

export const AGENTS: Record<string, AgentDef> = {
  planner: {
    name: "planner",
    roleFile: "planner",
    tools: ["read_state"],
    mode: "contract",
    artifact: "plan.json",
    maxIterations: 4,
    buildTask: (state) =>
      `${contractContext(state)}\n\nProduce the plan.json object for this request. Output JSON only.`,
    gate: planGate,
  },

  architect: {
    name: "architect",
    roleFile: "architect",
    tools: ["read_state"],
    mode: "contract",
    artifact: "architecture.json",
    maxIterations: 4,
    buildTask: (state) => {
      const plan = state.readArtifactText("plan.json");
      return `${contractContext(state)}\n\nThe plan.json is:\n\n\`\`\`json\n${plan}\n\`\`\`\n\nProduce the frozen architecture.json object. Output JSON only.`;
    },
    gate: architectureGate,
  },

  backend: {
    name: "backend",
    roleFile: "backend",
    tools: FILE_TOOLS,
    mode: "builder",
    maxIterations: 60,
    buildTask: (state) =>
      `${frozenContractBlock(state)}\n\nBuild the backend under \`backend/\` per your role. Run your gate (install, prisma generate, prisma validate, build, test) until everything is green, then confirm.`,
    gate: backendGate,
  },

  frontend: {
    name: "frontend",
    roleFile: "frontend",
    tools: [...FILE_TOOLS, "browser_check"],
    mode: "builder",
    maxIterations: 50,
    buildTask: (state) =>
      `${frozenContractBlock(state)}\n\nBuild the frontend under \`frontend/\` per your role. Run your gate (install, build) until green, then confirm.`,
    gate: frontendGate,
  },

  qa: {
    name: "qa",
    roleFile: "qa",
    tools: FILE_TOOLS,
    mode: "builder",
    maxIterations: 40,
    buildTask: (state) =>
      `${frozenContractBlock(state)}\n\nHarden the backend test suite per your role. Ensure \`npm test\` in \`backend/\` passes with expanded coverage, then confirm.`,
    gate: qaGate,
  },

  reviewer: {
    name: "reviewer",
    roleFile: "reviewer",
    tools: FILE_TOOLS,
    mode: "builder",
    maxIterations: 40,
    buildTask: () =>
      `Review and clean the backend per your role. Configure and pass \`npm run lint\`, keep \`npm test\` green, then confirm.`,
    gate: reviewerGate,
  },

  devops: {
    name: "devops",
    roleFile: "devops",
    tools: ["write_file", "read_file", "edit_file", "list_files", "run_shell", "read_state"],
    mode: "builder",
    maxIterations: 30,
    buildTask: (state) =>
      `${frozenContractBlock(state)}\n\nProduce deployment configuration per your role: backend/Dockerfile, frontend/Dockerfile, docker-compose.yml, .github/workflows/ci.yml, and a generated-project README.md. Then confirm.`,
    gate: devopsGate,
  },
};

/** The ordered pipeline. scaffold is a deterministic orchestrator step, not an agent. */
export const PIPELINE: string[] = ["planner", "architect", "backend", "frontend", "qa", "reviewer", "devops"];
