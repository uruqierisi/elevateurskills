import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.js";
import { isProfileId, PROFILE_IDS } from "./profile.js";
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

  // Classification fields are always required and must be self-consistent.
  if (!isProfileId(arch.profile)) problems.push(`profile must be one of ${PROFILE_IDS.join(", ")}`);
  if (!Array.isArray(arch.requiredAgents) || arch.requiredAgents.length === 0) {
    problems.push("requiredAgents must be a non-empty array");
  } else if (!arch.requiredAgents.includes("architect")) {
    problems.push("requiredAgents must include architect");
  }
  if (typeof arch.needsSandbox !== "boolean") problems.push("needsSandbox must be a boolean");
  if (typeof arch.needsDatabase !== "boolean") problems.push("needsDatabase must be a boolean");

  if (!arch.projectName) problems.push("missing projectName");
  if (!arch.stack) problems.push("missing stack");
  if (!Array.isArray(arch.folders) || arch.folders.length === 0) problems.push("folders must be non-empty");

  // Database + API are only required when the contract declares a database.
  if (arch.needsDatabase === true) {
    if (!arch.database?.models?.length) problems.push("database.models must be non-empty when needsDatabase");
    if (arch.database?.provider && arch.database.provider !== "postgresql") {
      problems.push(`database.provider must be "postgresql" (got "${arch.database.provider}")`);
    }
    if (!arch.api?.endpoints?.length) problems.push("api.endpoints must be non-empty when needsDatabase");
    const hasHealth = Array.isArray(arch.api?.endpoints)
      ? arch.api.endpoints.some((e: any) => String(e.path).includes("/health"))
      : false;
    if (!hasHealth) problems.push("api.endpoints must include a /health endpoint when needsDatabase");
  }

  if (problems.length) return fail(`architecture.json invalid: ${problems.join("; ")}`);

  const shape = arch.needsDatabase
    ? `${arch.database.models.length} model(s), ${arch.api.endpoints.length} endpoint(s)`
    : `${arch.folders.length} folder(s)`;
  return ok(`Contract frozen [${arch.profile}]: ${shape}.`);
};

/** existsSync against a workspace-relative path, safe against confinement throws. */
function wsExists(sandbox: Sandbox, rel: string): boolean {
  try {
    return existsSync(sandbox.resolve(rel));
  } catch {
    return false;
  }
}

/** Read architecture.json defensively; returns {} if absent/unparsable. */
function safeArch(state: RunState): Record<string, unknown> {
  try {
    return state.hasArtifact("architecture.json") ? state.readArtifact("architecture.json") : {};
  } catch {
    return {};
  }
}

// --- builder gates --------------------------------------------------------

// prisma generate/validate only parse the schema and read env(); they never
// open a connection. A working DATABASE_URL is already injected into every
// sandbox command (the sidecar's real URL, or the placeholder — see
// createSandbox), so the gate no longer has to supply one. The test step forces
// NODE_ENV=test, which selects the in-memory repository per the backend role.
const backendGate: Gate = (ctx) =>
  runSteps(ctx, "backend", [
    { label: "install", command: "npm install" },
    { label: "prisma generate", command: "npx prisma generate" },
    { label: "prisma validate", command: "npx prisma validate" },
    { label: "build", command: "npm run build" },
    { label: "test", command: "npm test", env: { NODE_ENV: "test" } },
  ]);

/** Candidate directories (workspace-relative) that may hold a frontend project. */
function findBuildDir(sandbox: Sandbox, state: RunState): string | null {
  const arch = safeArch(state);
  const folders = Array.isArray(arch.folders) ? (arch.folders as string[]) : [];
  const roots = new Set<string>([...folders.map((f) => f.split("/")[0]), "frontend", "app", "."]);
  for (const dir of roots) {
    const rel = dir === "." ? "package.json" : `${dir}/package.json`;
    try {
      if (existsSync(sandbox.resolve(rel))) return dir;
    } catch {
      /* path escaped confinement — skip */
    }
  }
  return null;
}

/** Locate the site's index.html across common static layouts. */
function findIndexHtml(sandbox: Sandbox, state: RunState): string | null {
  const arch = safeArch(state);
  const folders = Array.isArray(arch.folders) ? (arch.folders as string[]) : [];
  const candidates = [
    ...folders.map((f) => `${f}/index.html`),
    "index.html",
    "site/index.html",
    "public/index.html",
    "src/index.html",
    "frontend/index.html",
  ];
  for (const rel of candidates) {
    try {
      const abs = sandbox.resolve(rel);
      if (existsSync(abs)) return abs;
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Static-site gate: no command execution. Confirm an index.html exists and is
 * well-formed enough to render. This is what lets a no-build static site pass
 * without ever starting Docker or a build.
 */
const staticSiteGate: Gate = async ({ sandbox, state, log }) => {
  const indexPath = findIndexHtml(sandbox, state);
  if (!indexPath) return fail("No index.html found — a static site needs an index.html at its root.");
  log(`gate: validating static HTML at ${indexPath}`);
  const html = readFileSync(indexPath, "utf8");
  const lower = html.toLowerCase();
  const problems: string[] = [];
  if (!/<html[\s>]/.test(lower)) problems.push("missing <html>");
  if (!lower.includes("<body")) problems.push("missing <body>");
  if (html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length < 40) {
    problems.push("page has almost no visible text content");
  }
  if (problems.length) return fail(`index.html is not a valid page: ${problems.join("; ")}`);
  return ok("Static site renders: index.html is valid HTML.");
};

/**
 * Frontend gate. If there is a buildable project (a package.json), install and
 * build it; otherwise fall back to the static-HTML gate. Basing the branch on
 * the presence of a build — not just the profile — keeps it correct even when
 * overrides mix a static profile with other agents.
 */
const frontendGate: Gate = (ctx) => {
  const buildDir = findBuildDir(ctx.sandbox, ctx.state);
  if (buildDir) {
    return runSteps(ctx, buildDir === "." ? "" : buildDir, [
      { label: "install", command: "npm install" },
      { label: "build", command: "npm run build" },
    ]);
  }
  return staticSiteGate(ctx);
};

const qaGate: Gate = (ctx) =>
  runSteps(ctx, "backend", [{ label: "test", command: "npm test", env: { NODE_ENV: "test" } }]);

const reviewerGate: Gate = (ctx) => {
  // Prove nothing broke, adapted to what the project actually is: lint+test a
  // backend, build a frontend app, or validate the static HTML (no execution).
  if (wsExists(ctx.sandbox, "backend/package.json")) {
    return runSteps(ctx, "backend", [
      { label: "lint", command: "npm run lint" },
      { label: "test", command: "npm test", env: { NODE_ENV: "test" } },
    ]);
  }
  const buildDir = findBuildDir(ctx.sandbox, ctx.state);
  if (buildDir) {
    return runSteps(ctx, buildDir === "." ? "" : buildDir, [
      { label: "install", command: "npm install" },
      { label: "build", command: "npm run build" },
    ]);
  }
  return staticSiteGate(ctx);
};

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
  return (
    `Request: ${state.manifest.request}\n` +
    `Default stack (applies to fullstack/api-only only; ignore it for a static site): ${state.manifest.stack}`
  );
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
      const forced = state.manifest.shared.forcedProfile as string | undefined;
      const hint = forced
        ? `\n\nThe operator has FORCED the profile to "${forced}". Set "profile": "${forced}" and emit a contract that matches it (agents/needs per that profile).`
        : "";
      return `${contractContext(state)}\n\nThe plan.json is:\n\n\`\`\`json\n${plan}\n\`\`\`${hint}\n\nProduce the frozen architecture.json object. Output JSON only.`;
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
    buildTask: (state) => {
      const arch = safeArch(state);
      const isStatic = arch.profile === "static-site" || arch.needsSandbox === false;
      if (isStatic) {
        const folder = (Array.isArray(arch.folders) && (arch.folders as string[])[0]) || "site";
        return (
          `${frozenContractBlock(state)}\n\n` +
          `This is a **static-site** profile: build a no-build static site under \`${folder}/\` — ` +
          `semantic HTML, CSS, and light vanilla JS only. **No framework, no build step, no server.** ` +
          `Create at least \`${folder}/index.html\` plus its linked CSS/JS/assets, with real, specific ` +
          `content for the request (not lorem ipsum). Any contact form posts to a \`mailto:\` link or a ` +
          `third-party form endpoint — never a custom backend. Then confirm.`
        );
      }
      return `${frozenContractBlock(state)}\n\nBuild the frontend under \`frontend/\` per your role. Run your gate (install, build) until green, then confirm.`;
    },
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
