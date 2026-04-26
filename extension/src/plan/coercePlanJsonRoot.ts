function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasPhasesArray(v: unknown): boolean {
  return isRecord(v) && Array.isArray(v.phases);
}

/**
 * Some CLIs/models wrap the plan in an envelope (`result`, `data`, etc.).
 * Normalize to the inner object Planstack's validator expects.
 */
export function coercePlanJsonRoot(parsed: unknown): unknown {
  if (hasPhasesArray(parsed)) {
    return parsed;
  }
  if (!isRecord(parsed)) {
    return parsed;
  }

  const directKeys = ["plan", "result", "data", "payload", "content", "response"] as const;
  for (const k of directKeys) {
    const inner = parsed[k];
    if (hasPhasesArray(inner)) {
      return inner;
    }
  }

  const nestedPaths: readonly (readonly [string, string])[] = [
    ["result", "plan"],
    ["result", "data"],
    ["data", "plan"],
    ["response", "plan"],
    ["output", "plan"],
  ];
  for (const [a, b] of nestedPaths) {
    const mid = parsed[a];
    if (!isRecord(mid)) {
      continue;
    }
    const inner = mid[b];
    if (hasPhasesArray(inner)) {
      return inner;
    }
  }

  return parsed;
}
