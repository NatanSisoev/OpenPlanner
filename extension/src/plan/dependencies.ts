import type { Phase, Plan, Task, WorkState } from "./types";

export interface PhaseDependencyRefParts {
  planId?: string;
  phaseId: string;
}

export interface TaskDependencyRefParts {
  planId?: string;
  phaseId?: string;
  taskId: string;
}

export interface ResolvedPhaseDependency {
  plan: Plan;
  phase: Phase;
}

export interface ResolvedTaskDependency {
  plan: Plan;
  phase: Phase;
  task: Task;
}

export type PhaseDependencyResolution =
  | { ok: true; target: ResolvedPhaseDependency }
  | { ok: false; reason: "malformed" | "missing"; message: string };

export type TaskDependencyResolution =
  | { ok: true; target: ResolvedTaskDependency }
  | { ok: false; reason: "malformed" | "missing" | "ambiguous"; message: string };

export interface PhaseDependencyBlocker {
  ref: string;
  label: string;
  reason: "malformed" | "missing" | "self" | "incomplete";
  state?: WorkState;
}

export interface TaskDependencyBlocker {
  ref: string;
  label: string;
  reason: "malformed" | "missing" | "ambiguous" | "self" | "incomplete";
  state?: WorkState;
}

export function parsePhaseDependencyRef(ref: string): PhaseDependencyRefParts | undefined {
  const parts = ref.split("/").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  if (parts.length === 1) {
    return { phaseId: parts[0]! };
  }
  if (parts.length === 2) {
    return { planId: parts[0]!, phaseId: parts[1]! };
  }
  return undefined;
}

export function parseTaskDependencyRef(ref: string): TaskDependencyRefParts | undefined {
  const parts = ref.split("/").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  if (parts.length === 1) {
    return { taskId: parts[0]! };
  }
  if (parts.length === 2) {
    return { phaseId: parts[0]!, taskId: parts[1]! };
  }
  if (parts.length === 3) {
    return { planId: parts[0]!, phaseId: parts[1]!, taskId: parts[2]! };
  }
  return undefined;
}

export function formatPhaseDependencyTarget(target: ResolvedPhaseDependency): string {
  return `${target.plan.id}/${target.phase.id}`;
}

export function formatTaskDependencyTarget(target: ResolvedTaskDependency): string {
  return `${target.plan.id}/${target.phase.id}/${target.task.id}`;
}

export function resolvePhaseDependencyRef(
  allPlans: readonly Plan[],
  currentPlan: Plan,
  ref: string,
): PhaseDependencyResolution {
  const parsed = parsePhaseDependencyRef(ref);
  if (!parsed) {
    return {
      ok: false,
      reason: "malformed",
      message: `malformed phase dependency "${ref}"`,
    };
  }

  const plan = parsed.planId ? allPlans.find((p) => p.id === parsed.planId) : currentPlan;
  const phase = plan?.phases.find((ph) => ph.id === parsed.phaseId);
  if (!plan || !phase) {
    return {
      ok: false,
      reason: "missing",
      message: `unknown phase dependency "${ref}"`,
    };
  }
  return { ok: true, target: { plan, phase } };
}

export function resolveTaskDependencyRef(
  allPlans: readonly Plan[],
  currentPlan: Plan,
  ref: string,
): TaskDependencyResolution {
  const parsed = parseTaskDependencyRef(ref);
  if (!parsed) {
    return {
      ok: false,
      reason: "malformed",
      message: `malformed dependency "${ref}"`,
    };
  }

  if (parsed.planId) {
    const plan = allPlans.find((p) => p.id === parsed.planId);
    const phase = plan?.phases.find((ph) => ph.id === parsed.phaseId);
    const task = phase?.tasks.find((t) => t.id === parsed.taskId);
    if (!plan || !phase || !task) {
      return {
        ok: false,
        reason: "missing",
        message: `unknown task dependency "${ref}"`,
      };
    }
    return { ok: true, target: { plan, phase, task } };
  }

  if (parsed.phaseId) {
    const phase = currentPlan.phases.find((ph) => ph.id === parsed.phaseId);
    const task = phase?.tasks.find((t) => t.id === parsed.taskId);
    if (!phase || !task) {
      return {
        ok: false,
        reason: "missing",
        message: `unknown task dependency "${ref}"`,
      };
    }
    return { ok: true, target: { plan: currentPlan, phase, task } };
  }

  const matches: ResolvedTaskDependency[] = [];
  for (const phase of currentPlan.phases) {
    for (const task of phase.tasks) {
      if (task.id === parsed.taskId) {
        matches.push({ plan: currentPlan, phase, task });
      }
    }
  }

  if (matches.length === 1) {
    return { ok: true, target: matches[0]! };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `ambiguous task dependency "${ref}"; use phase-id/task-id`,
    };
  }
  return {
    ok: false,
    reason: "missing",
    message: `unknown task dependency "${ref}"`,
  };
}

function sameTask(
  left: ResolvedTaskDependency,
  right: { plan: Plan; phase: Phase; task: Task },
): boolean {
  return left.plan.id === right.plan.id && left.phase.id === right.phase.id && left.task.id === right.task.id;
}

function samePhase(
  left: ResolvedPhaseDependency,
  right: { plan: Plan; phase: Phase },
): boolean {
  return left.plan.id === right.plan.id && left.phase.id === right.phase.id;
}

export function blockingPhaseDependencies(
  allPlans: readonly Plan[],
  plan: Plan,
  phase: Phase,
): PhaseDependencyBlocker[] {
  const blockers: PhaseDependencyBlocker[] = [];
  for (const ref of phase.dependsOn ?? []) {
    const resolved = resolvePhaseDependencyRef(allPlans, plan, ref);
    if (!resolved.ok) {
      blockers.push({
        ref,
        label: resolved.message,
        reason: resolved.reason,
      });
      continue;
    }
    const targetLabel = formatPhaseDependencyTarget(resolved.target);
    if (samePhase(resolved.target, { plan, phase })) {
      blockers.push({
        ref,
        label: `${targetLabel} (self)`,
        reason: "self",
      });
      continue;
    }
    if (resolved.target.phase.state !== "completed") {
      blockers.push({
        ref,
        label: `${targetLabel} (${resolved.target.phase.state})`,
        reason: "incomplete",
        state: resolved.target.phase.state,
      });
    }
  }
  return blockers;
}

export function blockingTaskDependencies(
  allPlans: readonly Plan[],
  plan: Plan,
  phase: Phase,
  task: Task,
): TaskDependencyBlocker[] {
  const blockers: TaskDependencyBlocker[] = [];
  for (const ref of task.dependsOn ?? []) {
    const resolved = resolveTaskDependencyRef(allPlans, plan, ref);
    if (!resolved.ok) {
      blockers.push({
        ref,
        label: resolved.message,
        reason: resolved.reason,
      });
      continue;
    }
    const targetLabel = formatTaskDependencyTarget(resolved.target);
    if (sameTask(resolved.target, { plan, phase, task })) {
      blockers.push({
        ref,
        label: `${targetLabel} (self)`,
        reason: "self",
      });
      continue;
    }
    if (resolved.target.task.state !== "completed") {
      blockers.push({
        ref,
        label: `${targetLabel} (${resolved.target.task.state})`,
        reason: "incomplete",
        state: resolved.target.task.state,
      });
    }
  }
  return blockers;
}

export function blockingTaskDependenciesForPhase(
  allPlans: readonly Plan[],
  plan: Plan,
  phase: Phase,
): TaskDependencyBlocker[] {
  const blockers: TaskDependencyBlocker[] = [];
  for (const task of phase.tasks) {
    for (const ref of task.dependsOn ?? []) {
      const resolved = resolveTaskDependencyRef(allPlans, plan, ref);
      if (!resolved.ok) {
        blockers.push({
          ref,
          label: `${task.id} depends on ${resolved.message}`,
          reason: resolved.reason,
        });
        continue;
      }
      if (sameTask(resolved.target, { plan, phase, task })) {
        blockers.push({
          ref,
          label: `${task.id} depends on itself`,
          reason: "self",
        });
        continue;
      }
      if (resolved.target.plan.id === plan.id && resolved.target.phase.id === phase.id) {
        continue;
      }
      if (resolved.target.task.state !== "completed") {
        blockers.push({
          ref,
          label: `${task.id} depends on ${formatTaskDependencyTarget(resolved.target)} (${resolved.target.task.state})`,
          reason: "incomplete",
          state: resolved.target.task.state,
        });
      }
    }
  }
  return blockers;
}

export function formatTaskDependencyBlockers(blockers: readonly TaskDependencyBlocker[]): string {
  return blockers.map((blocker) => blocker.label).join(", ");
}

export function formatPhaseDependencyBlockers(blockers: readonly PhaseDependencyBlocker[]): string {
  return blockers.map((blocker) => blocker.label).join(", ");
}
