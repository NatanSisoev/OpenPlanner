// ─── Status ───────────────────────────────────────────────────────────────────

type Status = "pending" | "running" | "done" | "blocked" | "cancelled";

// ─── Task ─────────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description?: string;
  status: Status;
  selected: boolean;          // whether the user has checked it for execution
  dependsOn?: string[];       // task IDs within the same phase
  assignee?: string;          // agent id or human handle
  output?: unknown;           // result produced when done
  createdAt: Date;
  updatedAt: Date;
}

// ─── Phase ────────────────────────────────────────────────────────────────────

interface Phase {
  id: string;
  title: string;
  description?: string;
  status: Status;
  tasks: Task[];
  dependsOn?: string[];       // phase IDs within the same plan
  order: number;              // display / default execution order
  createdAt: Date;
  updatedAt: Date;
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  title: string;
  description?: string;
  status: Status;
  phases: Phase[];
  dependsOn?: string[];       // other plan IDs (cross-plan dependency graph)
  owner?: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Registry (top-level store) ───────────────────────────────────────────────

interface PlanRegistry {
  plans: Record<string, Plan>;  // keyed by plan.id for O(1) lookup
}