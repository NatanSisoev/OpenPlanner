import type { GitInfo, Phase, PhaseState, Plan, PlanState, Task, TaskState } from "./types";
import { parsePhaseDependencyRef, parseTaskDependencyRef } from "./dependencies";

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

function asOptionalStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!Array.isArray(v)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return v.map((item, index) => asString(item, `${field}[${index}]`));
}

function asGitInfo(v: unknown, field: string): GitInfo | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!isRecord(v)) {
    throw new Error(`Invalid git object: ${field}`);
  }
  const baseBranch = typeof v.baseBranch === "string" ? v.baseBranch.trim() : undefined;
  const planBranch = typeof v.planBranch === "string" ? v.planBranch.trim() : undefined;
  if (!baseBranch && !planBranch) {
    return undefined;
  }
  return {
    baseBranch: baseBranch || undefined,
    planBranch: planBranch || undefined,
  };
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
  const fieldPrefix = `phases[${phaseIndex}].tasks[${taskIndex}]`;
  return {
    id: asString(raw.id, `${fieldPrefix}.id`),
    state: asTaskState(raw.state, `${fieldPrefix}.state`),
    desc: typeof raw.desc === "string" ? raw.desc.trim() : "",
    commit: asBoolean(raw.commit, `${fieldPrefix}.commit`),
    dependsOn: asOptionalStringArray(raw.dependsOn, `${fieldPrefix}.dependsOn`) ?? [],
    prompt: asOptionalString(raw.prompt),
  };
}

function parsePhase(raw: unknown, index: number): Phase {
  if (!isRecord(raw)) {
    throw new Error(`phases[${index}] must be an object`);
  }
  const dependsOn = raw.dependsOn;
  let depends: string[] | undefined;
  if (dependsOn !== undefined && dependsOn !== null) {
    depends = asOptionalStringArray(dependsOn, `phases[${index}].dependsOn`);
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
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    tasks,
    dependsOn: depends,
  };
}

/** Parse and validate workspace plan JSON (seed-aligned schema). */
/** Cross-phase checks that need every phase parsed before they can run. */
function checkPhaseInvariants(plan: Plan): void {
  // 1. No duplicate phase ids
  const seen = new Set<string>();
  for (const p of plan.phases) {
    if (seen.has(p.id)) {
      throw new Error(`duplicate phase id "${p.id}"`);
    }
    seen.add(p.id);
  }
  // 2. Same-plan dependsOn refs must exist and cannot self-reference.
  const allIds = new Set(plan.phases.map((p) => p.id));
  for (const p of plan.phases) {
    for (const dep of p.dependsOn ?? []) {
      const parsed = parsePhaseDependencyRef(dep);
      if (!parsed) {
        throw new Error(
          `phase "${p.id}" has malformed dependency "${dep}" (use phase-id or plan-id/phase-id)`,
        );
      }
      if (parsed.planId && parsed.planId !== plan.id) {
        continue;
      }
      if (parsed.phaseId === p.id) {
        throw new Error(`phase "${p.id}" depends on itself`);
      }
      if (!allIds.has(parsed.phaseId)) {
        throw new Error(`phase "${p.id}" depends on unknown phase id "${dep}"`);
      }
    }
  }
}

/** Cross-task checks that need the containing plan parsed first. */
function checkTaskInvariants(plan: Plan): void {
  const tasksById = new Map<string, { phaseId: string; task: Task }[]>();
  const tasksByQualifiedId = new Map<string, Task>();

  for (const phase of plan.phases) {
    const idsInPhase = new Set<string>();
    for (const task of phase.tasks) {
      if (idsInPhase.has(task.id)) {
        throw new Error(`duplicate task id "${task.id}" in phase "${phase.id}"`);
      }
      idsInPhase.add(task.id);

      const list = tasksById.get(task.id) ?? [];
      list.push({ phaseId: phase.id, task });
      tasksById.set(task.id, list);
      tasksByQualifiedId.set(`${phase.id}/${task.id}`, task);
    }
  }

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      for (const dep of task.dependsOn) {
        const parsed = parseTaskDependencyRef(dep);
        if (!parsed) {
          throw new Error(
            `task "${task.id}" has malformed dependency "${dep}" (use task-id, phase-id/task-id, or plan-id/phase-id/task-id)`,
          );
        }

        if (parsed.planId && parsed.planId !== plan.id) {
          continue;
        }

        let target: Task | undefined;
        if (parsed.phaseId) {
          target = tasksByQualifiedId.get(`${parsed.phaseId}/${parsed.taskId}`);
          if (!target) {
            throw new Error(`task "${task.id}" depends on unknown task "${dep}"`);
          }
        } else {
          const matches = tasksById.get(parsed.taskId) ?? [];
          if (matches.length === 0) {
            throw new Error(`task "${task.id}" depends on unknown task "${dep}"`);
          }
          if (matches.length > 1) {
            throw new Error(`task "${task.id}" has ambiguous dependency "${dep}"; use phase-id/task-id`);
          }
          target = matches[0]!.task;
        }

        if (target === task) {
          throw new Error(`task "${task.id}" depends on itself`);
        }
      }
    }
  }
}

export function validatePlanJson(raw: unknown): Plan {
  if (!isRecord(raw)) {
    throw new Error("Plan root must be an object");
  }
  const phasesRaw = raw.phases;
  if (!Array.isArray(phasesRaw)) {
    throw new Error("Plan must have a phases array");
  }
  const phases = phasesRaw.map((p, i) => parsePhase(p, i));
  const plan = {
    id: asString(raw.id, "id"),
    state: asPlanState(raw.state, "state"),
    title: asString(raw.title, "title"),
    description: asOptionalString(raw.description),
    createdAt: asOptionalString(raw.createdAt),
    phases,
    git: asGitInfo(raw.git, "git"),
  };
  checkPhaseInvariants(plan);
  checkTaskInvariants(plan);
  return plan;
}
