/** Plan JSON on disk — aligned with `seed/*.json` (see repo seed/). */

export type PlanState = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type PhaseState = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface PhaseGitMeta {
  phaseBranch?: string;
}

export interface PlanGitMeta {
  baseBranch?: string;
  planBranch?: string;
}

export interface Task {
  id: string;
  state: TaskState;
  desc: string;
  commit: boolean;
}

export interface Phase {
  id: string;
  state: PhaseState;
  title: string;
  description: string;
  tasks: Task[];
  dependsOn?: string[];
  git?: PhaseGitMeta;
}

export interface Plan {
  id: string;
  state: PlanState;
  title: string;
  createdAt?: string;
  phases: Phase[];
  git?: PlanGitMeta;
}
