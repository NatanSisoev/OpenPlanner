/** Plan JSON on disk (see docs/ide_plan_execution_1.plan.md). */

export type PhaseStatus = "pending" | "in_progress" | "done" | "blocked";

export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled" | "failed" | "skipped";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
}

export interface PhaseGitMeta {
  phaseBranch?: string;
}

export interface PlanGitMeta {
  baseBranch?: string;
  planBranch?: string;
}

export interface Phase {
  id: string;
  title: string;
  body: string;
  status: PhaseStatus;
  dependsOn?: string[];
  git?: PhaseGitMeta;
  tasks?: Task[];
}

export interface Plan {
  id: string;
  title: string;
  phases: Phase[];
  git?: PlanGitMeta;
}
