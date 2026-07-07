/**
 * Project profiles make the pipeline adaptive: a request is classified into a
 * profile, and only the agents that profile needs are run. The sandbox (Docker)
 * is activated only when a profile actually needs to execute commands.
 *
 * The Architect classifies the request and records the profile fields in the
 * frozen architecture.json; CLI overrides can force a profile or agent set. This
 * module is the single place that maps a profile to its agents/needs and that
 * resolves the final plan from the contract + overrides.
 */

export type ProfileId = "static-site" | "frontend-app" | "api-only" | "fullstack";

export const PROFILE_IDS: ProfileId[] = ["static-site", "frontend-app", "api-only", "fullstack"];

export interface ProjectPlan {
  profile: ProfileId;
  /** Agents that actually run (always includes "architect"). */
  requiredAgents: string[];
  /** Whether any running stage needs command execution (→ Docker/local exec). */
  needsSandbox: boolean;
  /** Whether the contract includes a database. */
  needsDatabase: boolean;
}

/**
 * Default agent set + needs per profile. `architect` is always present (it is
 * the classifier and produces the frozen contract). `planner` is not listed
 * here — it always runs, before classification, to produce plan.json.
 */
export const PROFILES: Record<ProfileId, ProjectPlan> = {
  "static-site": {
    profile: "static-site",
    requiredAgents: ["architect", "frontend", "reviewer"],
    needsSandbox: false,
    needsDatabase: false,
  },
  "frontend-app": {
    profile: "frontend-app",
    requiredAgents: ["architect", "frontend", "qa", "reviewer", "devops"],
    needsSandbox: true,
    needsDatabase: false,
  },
  "api-only": {
    profile: "api-only",
    requiredAgents: ["architect", "backend", "qa", "reviewer", "devops"],
    needsSandbox: true,
    needsDatabase: true,
  },
  fullstack: {
    profile: "fullstack",
    requiredAgents: ["architect", "backend", "frontend", "qa", "reviewer", "devops"],
    needsSandbox: true,
    needsDatabase: true,
  },
};

export interface PlanOverrides {
  /** --profile: force a profile (ignores the Architect's classification). */
  profile?: ProfileId;
  /** --agents: force an explicit agent set. */
  agents?: string[];
  /** --force-backend: pull the backend agent back in (implies sandbox + db). */
  forceBackend?: boolean;
  /** --no-backend: drop the backend agent. */
  noBackend?: boolean;
}

export function isProfileId(s: unknown): s is ProfileId {
  return typeof s === "string" && (PROFILE_IDS as string[]).includes(s);
}

/** Architect always runs; make sure it's present in any explicit agent set. */
function withArchitect(agents: string[]): string[] {
  return agents.includes("architect") ? agents : ["architect", ...agents];
}

/**
 * Read the plan the Architect recorded in architecture.json, falling back to
 * the safe default (fullstack) when the fields are absent or invalid — so an
 * older/looser contract still runs, just without the adaptive trimming.
 */
export function planFromArch(archRaw: unknown): ProjectPlan {
  const arch = (archRaw ?? {}) as {
    profile?: unknown;
    requiredAgents?: unknown;
    needsSandbox?: unknown;
    needsDatabase?: unknown;
  };
  if (!isProfileId(arch.profile)) return { ...PROFILES.fullstack };
  const base = PROFILES[arch.profile];
  const requiredAgents =
    Array.isArray(arch.requiredAgents) && arch.requiredAgents.every((a) => typeof a === "string") && arch.requiredAgents.length > 0
      ? withArchitect(arch.requiredAgents as string[])
      : base.requiredAgents;
  return {
    profile: arch.profile,
    requiredAgents,
    needsSandbox: typeof arch.needsSandbox === "boolean" ? arch.needsSandbox : base.needsSandbox,
    needsDatabase: typeof arch.needsDatabase === "boolean" ? arch.needsDatabase : base.needsDatabase,
  };
}

/**
 * Resolve the final plan from the contract + CLI overrides. Precedence:
 *   --agents  > --profile > architecture.json > fullstack default,
 * then --no-backend / --force-backend adjust the result.
 */
export function resolvePlan(archRaw: unknown, ov: PlanOverrides = {}): ProjectPlan {
  let plan: ProjectPlan;
  if (ov.agents && ov.agents.length > 0) {
    // Explicit agent set: keep the profile/needs from arch (or default) as a
    // base, but override the agent list.
    const base = ov.profile ? PROFILES[ov.profile] : planFromArch(archRaw);
    plan = { ...base, requiredAgents: withArchitect(ov.agents) };
  } else if (ov.profile) {
    plan = { ...PROFILES[ov.profile] };
  } else {
    plan = planFromArch(archRaw);
  }

  if (ov.noBackend) {
    plan = { ...plan, requiredAgents: plan.requiredAgents.filter((a) => a !== "backend") };
  }
  if (ov.forceBackend) {
    const requiredAgents = plan.requiredAgents.includes("backend")
      ? plan.requiredAgents
      : [...plan.requiredAgents, "backend"];
    plan = { ...plan, requiredAgents, needsSandbox: true, needsDatabase: true };
  }

  // A run that executes any command needs the sandbox; a backend always implies
  // a database. Keep the flags internally consistent after overrides.
  if (plan.requiredAgents.includes("backend")) plan = { ...plan, needsSandbox: true, needsDatabase: true };
  return plan;
}
