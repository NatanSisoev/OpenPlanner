import type { Phase, Plan } from "./types";

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
    "Execute only the work described in this phase body; do not expand scope to other phases unless blocked.",
    "",
    phase.body,
  ];
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
  return lines.join("\n");
}
