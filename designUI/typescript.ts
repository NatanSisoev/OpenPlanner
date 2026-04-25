// Tracks the current execution status.
type ExecutionState = "pending" | "in_progress" | "completed";

// Git branch information for the plan.
interface GitInfo {
  baseBranch: string;
  planBranch: string;
}

// Defines a single task inside a phase.
interface Task {
  id: string;
  state: ExecutionState;
  desc: string;
  commit: boolean;
  prompt?: string;
}

// Groups related tasks under one phase.
interface Phase {
  id: string;
  state: ExecutionState;
  title: string;
  description: string;
  tasks: Task[];
}

// Root structure for a full execution plan.
interface Plan {
  id: string;
  state: ExecutionState;
  title: string;
  createdAt: string;
  git: GitInfo;
  phases: Phase[];
}