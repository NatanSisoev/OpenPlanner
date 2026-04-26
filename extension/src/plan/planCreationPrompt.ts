/** Instructions bundled into the headless agent prompt (stdout must be JSON only). */
import type { Plan } from "./types";

export const PLAN_JSON_SCHEMA_HINT = `You must output exactly ONE JSON object and nothing else (no markdown, no prose).

Schema:
- id: string (slug; lowercase letters, digits, hyphens)
- state: one of "pending" | "in_progress" | "completed" | "failed" | "cancelled"
- title: string
- createdAt: optional ISO-8601 string (e.g. "2026-04-25T07:30:00Z")
- git: optional { "baseBranch"?: string, "planBranch"?: string }
- phases: array of:
  - id: string
  - state: same enum as plan
  - title: string
  - description: string (phase scope / narrative)
  - assignee: optional string (human-readable owner label for the phase)
  - tasks: array (can be empty) of:
    - id: string
    - state: same enum
    - desc: string (concrete work item)
    - commit: boolean (whether this item should end in a git commit)
    - assignee: optional string (human-readable owner label for the task)
    Tasks have NO dependencies — only phases do.
  - dependsOn: optional string[] of phase dependency refs.
    Ref forms: "phase-id" (same plan) or "plan-id/phase-id" (another plan).

Example (shape only):
{"id":"my-plan","state":"pending","title":"My plan","phases":[{"id":"p1","state":"pending","title":"First","description":"Do X","tasks":[{"id":"t1","state":"pending","desc":"Step one","commit":true}]}]}`;

export function buildPlanCreationPrompt(userRequest: string): string {
  const body = userRequest.trim();
  return `${PLAN_JSON_SCHEMA_HINT}

User request:
${body}

Output ONLY the JSON object.`;
}

export function buildPlanResyncPrompt(existingPlan: Plan, extraInstructions?: string): string {
  const objectives = [
    existingPlan.title.trim(),
    existingPlan.description?.trim(),
    ...existingPlan.phases.map((phase) => `${phase.title.trim()}: ${phase.description.trim()}`),
  ]
    .filter((x) => x && x.length > 0)
    .join("\n- ");

  const serializedPlan = JSON.stringify(existingPlan, null, 2);
  const custom = extraInstructions?.trim();

  return `${PLAN_JSON_SCHEMA_HINT}

You are re-syncing an existing plan to the CURRENT repository state.
- Preserve the same core goals/objectives.
- Re-evaluate phases/tasks so they match the latest codebase.
- For stale/idle work, reset todo-like work back to "pending" (do NOT leave stale "in_progress").
- Keep the same plan id: "${existingPlan.id}".
- Keep phase ids and task ids stable when possible; if you must replace a phase/task, use a clear new id.

Existing objectives:
- ${objectives}

Existing plan JSON:
${serializedPlan}

${custom ? `Additional user instructions:\n${custom}\n` : ""}Output ONLY the JSON object.`;
}
