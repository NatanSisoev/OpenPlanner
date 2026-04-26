/**
 * Plan JSON on-disk shape.
 *
 * A plan is a tree of work: plan -> phases -> tasks. Every level shares the
 * same lifecycle states (`WorkState`). Phases and tasks may carry an optional
 * free-text `assignee`. Plans optionally carry Git metadata so the extension can
 * resolve which branch a phase should run on.
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

/** Client-side metadata for MongoDB sync (newest-wins reconcile). */
export interface PlanSyncMeta {
  /** ISO-8601 instant last written for this plan (local or after pull). */
  updatedAt: string;
  /** Increments on each local save; tie-break with updatedAt. */
  revision: number;
}

export interface Task {
  id: string;
  state: WorkState;
  desc: string;
  /** Whether this task should end with a git commit when run. */
  commit: boolean;
  /** Optional override prompt used when handing the task off. */
  prompt?: string;
  /** Optional human-readable owner label (free text). */
  assignee?: string;
}

export interface Phase {
  id: string;
  state: WorkState;
  title: string;
  description: string;
  tasks: Task[];
  /** Optional human-readable owner label (free text). */
  assignee?: string;
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
  /** Optional; used for Atlas plan sync / last-write-wins. */
  sync?: PlanSyncMeta;
}
