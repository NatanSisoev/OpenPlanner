import type { Phase, Plan, Task } from "./types";

/** Clipboard payload for native agent (ide_plan_execution_1.plan.md). */
export function buildPhaseHandoffPrompt(
  plan: Plan,
  phase: Phase,
  extras?: { currentHead?: string; effectiveWorkBranch?: string; baseBranch?: string },
): string {
  const lines: string[] = [
    `# Plan: ${plan.title}`,
    `## Phase (run only this): ${phase.title}`,
    "",
    "Execute only the work described in this phase description and its tasks; do not expand scope to other phases unless blocked.",
    "",
    phase.description,
  ];

  if (phase.tasks.length > 0) {
    lines.push("", "### Tasks");
    for (const t of phase.tasks) {
      lines.push(`- **${t.id}** [${t.state}]${t.commit ? " (commit)" : ""}: ${t.desc}`);
    }
  }

  if (extras?.effectiveWorkBranch || extras?.baseBranch || extras?.currentHead) {
    lines.push("", "## Version control context");
    if (extras.currentHead) {
      lines.push(`- Current checkout: ${extras.currentHead}`);
    }
    if (extras.effectiveWorkBranch) {
      lines.push(`- Effective work branch (plan): ${extras.effectiveWorkBranch}`);
    }
    if (extras.baseBranch) {
      lines.push(`- Base branch: ${extras.baseBranch}`);
    }
  }

  lines.push(
    "",
    "Implement the work in this repository with normal file edits (not JSON-only or plan-file output).",
  );
  return lines.join("\n");
}

export function buildTaskHandoffPrompt(
  plan: Plan,
  phase: Phase,
  task: Task,
  extras?: { currentHead?: string; effectiveWorkBranch?: string; baseBranch?: string },
): string {
  const lines: string[] = [
    `# Plan: ${plan.title}`,
    `## Phase: ${phase.title}`,
    `## Task (run only this): ${task.desc}`,
    "",
    "Execute only the work described in this single task. Do not start other tasks even if they look related; the user is intentionally running this task in isolation.",
  ];
  if (task.commit) {
    lines.push(
      "",
      "When the task is done, end with a single git commit summarizing the change.",
    );
  }
  if (task.prompt && task.prompt.trim()) {
    lines.push("", "### Task-specific guidance", task.prompt.trim());
  }
  if (extras?.effectiveWorkBranch || extras?.baseBranch || extras?.currentHead) {
    lines.push("", "## Version control context");
    if (extras.currentHead) {
      lines.push(`- Current checkout: ${extras.currentHead}`);
    }
    if (extras.effectiveWorkBranch) {
      lines.push(`- Effective work branch (plan): ${extras.effectiveWorkBranch}`);
    }
    if (extras.baseBranch) {
      lines.push(`- Base branch: ${extras.baseBranch}`);
    }
  }
  lines.push(
    "",
    "Implement the work in this repository with normal file edits (not JSON-only or plan-file output).",
  );
  return lines.join("\n");
}
