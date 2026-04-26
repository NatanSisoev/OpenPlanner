import type { Plan, Task } from "./types";

/** If `task.prompt` is empty, set it to `task.desc` so Run task has handoff text. */
export function ensureTaskPromptFromDesc(task: Task): void {
  const desc = (task.desc ?? "").trim();
  if (!desc) {
    return;
  }
  if ((task.prompt ?? "").trim()) {
    return;
  }
  task.prompt = desc;
}

/** Apply {@link ensureTaskPromptFromDesc} to every task in the plan (mutates in place). */
export function applyTaskPromptDefaultsFromDesc(plan: Plan): void {
  for (const phase of plan.phases ?? []) {
    for (const task of phase.tasks ?? []) {
      ensureTaskPromptFromDesc(task);
    }
  }
}
