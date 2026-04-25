interface Task {
  id: string;
  checkbox?: boolean;
  state: "pending" | "in_progress" | "completed";
  desc: string;
  timestamp: string;
}

interface Fase {
  id: string;
  checkbox?: boolean;
  state: "pending" | "in_progress" | "completed";
  tasks: Task[];
}

interface Plan {
  id: string;
  checkbox?: boolean;
  state: "pending" | "in_progress" | "completed";
  fases: Fase[];
}