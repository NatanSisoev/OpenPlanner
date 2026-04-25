import type { Phase, PhaseStatus, Plan } from "./types";

const PHASE_STATUSES: ReadonlySet<PhaseStatus> = new Set([
  "pending",
  "in_progress",
  "done",
  "blocked",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string): string {
  if (typeof v === "string" && v.trim().length > 0) {
    return v.trim();
  }
  throw new Error(`Invalid or missing string: ${field}`);
}

function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  throw new Error(`Invalid optional string: ${field}`);
}

function asPhaseStatus(v: unknown, field: string): PhaseStatus {
  if (typeof v === "string" && PHASE_STATUSES.has(v as PhaseStatus)) {
    return v as PhaseStatus;
  }
  throw new Error(`Invalid phase status: ${field}`);
}

function parsePhaseGit(raw: unknown): Phase["git"] {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error("phase.git must be an object");
  }
  return {
    phaseBranch: asOptionalString(raw.phaseBranch, "phase.git.phaseBranch"),
  };
}

function parsePlanGit(raw: unknown): Plan["git"] {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error("plan.git must be an object");
  }
  return {
    baseBranch: asOptionalString(raw.baseBranch, "git.baseBranch"),
    planBranch: asOptionalString(raw.planBranch, "git.planBranch"),
  };
}

function parsePhase(raw: unknown, index: number): Phase {
  if (!isRecord(raw)) {
    throw new Error(`phases[${index}] must be an object`);
  }
  const dependsOn = raw.dependsOn;
  let depends: string[] | undefined;
  if (dependsOn !== undefined && dependsOn !== null) {
    if (!Array.isArray(dependsOn) || !dependsOn.every((d) => typeof d === "string")) {
      throw new Error(`phases[${index}].dependsOn must be an array of strings`);
    }
    depends = dependsOn as string[];
  }
  return {
    id: asString(raw.id, `phases[${index}].id`),
    title: asString(raw.title, `phases[${index}].title`),
    body: typeof raw.body === "string" ? raw.body : "",
    status: asPhaseStatus(raw.status, `phases[${index}].status`),
    dependsOn: depends,
    git: parsePhaseGit(raw.git),
  };
}

/** Parse and validate workspace plan JSON. */
export function validatePlanJson(raw: unknown): Plan {
  if (!isRecord(raw)) {
    throw new Error("Plan root must be an object");
  }
  const phasesRaw = raw.phases;
  if (!Array.isArray(phasesRaw)) {
    throw new Error("Plan must have a phases array");
  }
  const phases = phasesRaw.map((p, i) => parsePhase(p, i));
  return {
    id: asString(raw.id, "id"),
    title: asString(raw.title, "title"),
    phases,
    git: parsePlanGit(raw.git),
  };
}
