/** Instructions bundled into the headless agent prompt (stdout must be JSON only). */

export const PLAN_JSON_SCHEMA_HINT = `You must output exactly ONE JSON object and nothing else (no markdown, no prose).

Schema:
- id: string (slug, unique within repo; use lowercase letters, digits, hyphens only)
- title: string (human-readable plan title)
- phases: array of objects, each with:
  - id: string (unique within this plan)
  - title: string
  - body: string (what to do in this phase)
  - status: one of "pending" | "in_progress" | "done" | "blocked"
  - dependsOn: optional string[] of phase ids
  - git: optional { "phaseBranch"?: string }
- git: optional plan-level { "baseBranch"?: string, "planBranch"?: string }

Example (shape only):
{"id":"my-plan","title":"My plan","phases":[{"id":"p1","title":"First","body":"Do X","status":"pending"}]}`;

export function buildPlanCreationPrompt(userRequest: string): string {
  const body = userRequest.trim();
  return `${PLAN_JSON_SCHEMA_HINT}

User request:
${body}

Output ONLY the JSON object.`;
}
