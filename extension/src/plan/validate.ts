import type { ExecutionState, Phase, Plan, Task } from "./types";

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
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

function asOptionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

function asState(v: unknown, field: string): ExecutionState {
  if (typeof v === "string" && KNOWN_STATES.has(v)) {
    return v as ExecutionState;
  }
  // Be lenient — unknown states fall back to "pending".
  if (typeof v === "string" && v.trim().length > 0) {
    console.warn(`Planstack: unrecognised state "${v}" at ${field}, defaulting to "pending"`);
  }
  return "pending";
}

function parseTask(raw: unknown, phaseIndex: number, taskIndex: number): Task {
  if (!isRecord(raw)) {
    throw new Error(`phases[${phaseIndex}].tasks[${taskIndex}] must be an object`);
  }
  return {
    id: asString(raw.id, `phases[${phaseIndex}].tasks[${taskIndex}].id`),
    state: asState(raw.state, `phases[${phaseIndex}].tasks[${taskIndex}].state`),
    desc: typeof raw.desc === "string" ? raw.desc.trim() : "",
    commit: raw.commit === true,
    prompt: asOptionalString(raw.prompt),
  };
}

function parsePhase(raw: unknown, index: number): Phase {
  if (!isRecord(raw)) {
    throw new Error(`phases[${index}] must be an object`);
  }
  const tasksRaw = raw.tasks;
  const tasks: Task[] = Array.isArray(tasksRaw)
    ? tasksRaw.map((t, i) => parseTask(t, index, i))
    : [];
  return {
    id: asString(raw.id, `phases[${index}].id`),
    state: asState(raw.state, `phases[${index}].state`),
    title: asString(raw.title, `phases[${index}].title`),
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    tasks,
  };
}

function parseGit(raw: unknown): Plan["git"] {
  if (!isRecord(raw)) {
    return { baseBranch: "", planBranch: "" };
  }
  return {
    baseBranch: typeof raw.baseBranch === "string" ? raw.baseBranch.trim() : "",
    planBranch: typeof raw.planBranch === "string" ? raw.planBranch.trim() : "",
  };
}

/** Parse and validate workspace plan JSON. Lenient on unknown fields and states. */
export function validatePlanJson(raw: unknown): Plan {
  if (!isRecord(raw)) {
    throw new Error("Plan root must be an object");
  }
  const phasesRaw = raw.phases;
  if (!Array.isArray(phasesRaw)) {
    throw new Error("Plan must have a phases array");
  }
  return {
    id: asString(raw.id, "id"),
    state: asState(raw.state, "state"),
    title: asString(raw.title, "title"),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    git: parseGit(raw.git),
    phases: phasesRaw.map((p, i) => parsePhase(p, i)),
  };
}
