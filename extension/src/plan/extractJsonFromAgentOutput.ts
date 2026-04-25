/**
 * Pull a single JSON object from model output: fenced ```json block, else first balanced `{...}` (double-quoted strings only).
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{")) {
      return inner;
    }
  }

  const start = trimmed.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in agent output.");
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  throw new Error("Unbalanced braces in agent output (invalid JSON fragment).");
}
