/**
 * Plan JSON on-disk shape.
 *
 * A plan is a tree of work: plan -> phases -> tasks. Every level shares the
 * same lifecycle states (`WorkState`). Plans optionally carry Git metadata so
 * the extension can resolve which branch a phase should run on.
 */

/** Lifecycle state shared by plans, phases, and tasks. */
export type WorkState =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

/** All valid `WorkState` values, in canonical UI order. */
export const WORK_STATES: readonly WorkState[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
];

// Back-compat aliases (older code paths still import these names).
export type PlanState = WorkState;
export type PhaseState = WorkState;
export type TaskState = WorkState;
export type ExecutionState = WorkState;

export interface GitInfo {
  /** Branch the plan is based on (e.g. `main`). */
  baseBranch?: string;
  /** Working branch that owns this plan's commits. */
  planBranch?: string;
}

/**
 * A phase dependency reference. Tasks have no dependencies — only phases do,
 * and they may only reference other phases.
 *
 * Supported JSON forms:
 * - `phase-id` for a phase in the same plan.
 * - `plan-id/phase-id` for a phase in another plan.
 */
export type PhaseDependencyRef = string;

export interface Task {
  id: string;
  state: WorkState;
  desc: string;
  /** Whether this task should end with a git commit when run. */
  commit: boolean;
  /** Optional override prompt used when handing the task off. */
  prompt?: string;
}

export interface Phase {
  id: string;
  state: WorkState;
  title: string;
  description: string;
  tasks: Task[];
  /** Other phases that must complete first. */
  dependsOn?: PhaseDependencyRef[];
}

export interface Plan {
  id: string;
  state: WorkState;
  title: string;
  /** Optional high-level plan summary shown in the UI. */
  description?: string;
  /** ISO-8601 timestamp; optional. */
  createdAt?: string;
  phases: Phase[];
  git?: GitInfo;
}
