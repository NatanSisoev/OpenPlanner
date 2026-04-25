/** Plan JSON on disk — canonical format defined in designUI/typescript.ts. */

export type ExecutionState = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface GitInfo {
  baseBranch: string;
  planBranch: string;
}

export interface Task {
  id: string;
  state: ExecutionState;
  desc: string;
  commit: boolean;
  prompt?: string;
}

export interface Phase {
  id: string;
  state: ExecutionState;
  title: string;
  description: string;
  tasks: Task[];
}

export interface Plan {
  id: string;
  state: ExecutionState;
  title: string;
  createdAt: string;
  git: GitInfo;
  phases: Phase[];
}
