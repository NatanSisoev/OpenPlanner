import type { Phase, PhaseState, Plan, PlanState, Task, TaskState } from "./types";

const PLAN_STATES: ReadonlySet<PlanState> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

const PHASE_STATES: ReadonlySet<PhaseState> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

const TASK_STATES: ReadonlySet<TaskState> = new Set([
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

function asPlanState(v: unknown, field: string): PlanState {
  if (typeof v === "string" && PLAN_STATES.has(v as PlanState)) {
    return v as PlanState;
  }
  throw new Error(`Invalid plan state: ${field}`);
}

function asPhaseState(v: unknown, field: string): PhaseState {
  if (typeof v === "string" && PHASE_STATES.has(v as PhaseState)) {
    return v as PhaseState;
  }
  throw new Error(`Invalid phase state: ${field}`);
}

function asTaskState(v: unknown, field: string): TaskState {
  if (typeof v === "string" && TASK_STATES.has(v as TaskState)) {
    return v as TaskState;
  }
  throw new Error(`Invalid task state: ${field}`);
}

function asBoolean(v: unknown, field: string): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  throw new Error(`Invalid boolean: ${field}`);
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

function parseTask(raw: unknown, phaseIndex: number, taskIndex: number): Task {
  if (!isRecord(raw)) {
    throw new Error(`phases[${phaseIndex}].tasks[${taskIndex}] must be an object`);
  }
  return {
    id: asString(raw.id, `phases[${phaseIndex}].tasks[${taskIndex}].id`),
    state: asTaskState(raw.state, `phases[${phaseIndex}].tasks[${taskIndex}].state`),
    desc: typeof raw.desc === "string" ? raw.desc : "",
    commit: asBoolean(raw.commit, `phases[${phaseIndex}].tasks[${taskIndex}].commit`),
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

  const tasksRaw = raw.tasks;
  if (!Array.isArray(tasksRaw)) {
    throw new Error(`phases[${index}].tasks must be an array`);
  }
  const tasks = tasksRaw.map((t, j) => parseTask(t, index, j));

  return {
    id: asString(raw.id, `phases[${index}].id`),
    state: asPhaseState(raw.state, `phases[${index}].state`),
    title: asString(raw.title, `phases[${index}].title`),
    description: typeof raw.description === "string" ? raw.description : "",
    tasks,
    dependsOn: depends,
    git: parsePhaseGit(raw.git),
  };
}

/** Parse and validate workspace plan JSON (seed-aligned schema). */
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
    state: asPlanState(raw.state, "state"),
    title: asString(raw.title, "title"),
    createdAt: asOptionalString(raw.createdAt, "createdAt"),
    phases,
    git: parsePlanGit(raw.git),
  };
}
