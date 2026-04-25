/** Instructions bundled into the headless agent prompt (stdout must be JSON only). Matches `seed/*.json`. */

export const PLAN_JSON_SCHEMA_HINT = `You must output exactly ONE JSON object and nothing else (no markdown, no prose).

Schema (same shape as repo seed/ examples):
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
  - tasks: array (can be empty) of:
    - id: string
    - state: same enum
    - desc: string (concrete work item)
    - commit: boolean (whether this item should end in a git commit)
  - dependsOn: optional string[] of phase ids (cross-phase deps)
  - git: optional { "phaseBranch"?: string }

Example (shape only):
{"id":"my-plan","state":"pending","title":"My plan","phases":[{"id":"p1","state":"pending","title":"First","description":"Do X","tasks":[{"id":"t1","state":"pending","desc":"Step one","commit":true}]}]}`;

export function buildPlanCreationPrompt(userRequest: string): string {
  const body = userRequest.trim();
  return `${PLAN_JSON_SCHEMA_HINT}

User request:
${body}

Output ONLY the JSON object.`;
}
