/** Instructions bundled into the headless agent prompt (stdout must be JSON only). */

export const PLAN_JSON_SCHEMA_HINT = `You must output exactly ONE JSON object and nothing else (no markdown, no prose).

Schema:
- id: string (slug, unique within repo; lowercase letters, digits, hyphens only)
- state: one of "pending" | "in_progress" | "completed" | "failed" | "cancelled"
- title: string (human-readable plan title)
- createdAt: ISO 8601 timestamp string
- git: { "baseBranch": string, "planBranch": string }
- phases: array of objects, each with:
  - id: string (unique within this plan)
  - state: one of "pending" | "in_progress" | "completed" | "failed" | "cancelled"
  - title: string
  - description: string (what to do in this phase)
  - tasks: array of objects, each with:
    - id: string (unique within this phase)
    - state: one of "pending" | "in_progress" | "completed" | "failed" | "cancelled"
    - desc: string (what this task does)
    - commit: boolean (whether this task should produce a git commit)
    - prompt: optional string (agent prompt override for this task)

Example (shape only):
{"id":"my-plan","state":"pending","title":"My plan","createdAt":"2026-01-01T00:00:00Z","git":{"baseBranch":"main","planBranch":"planstack/my-plan"},"phases":[{"id":"p1","state":"pending","title":"First phase","description":"Do X","tasks":[{"id":"t1","state":"pending","desc":"Do X step 1","commit":true}]}]}`;

export function buildPlanCreationPrompt(userRequest: string): string {
  const body = userRequest.trim();
  return `${PLAN_JSON_SCHEMA_HINT}

User request:
${body}

Output ONLY the JSON object.`;
}
