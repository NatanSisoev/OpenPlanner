/** Neutral executor profile ids (settings + Chat UI). */
export type ExecutorProfileId = "cursor-agent-cli" | "junie-cli";

export const EXECUTOR_PROFILE_IDS: readonly ExecutorProfileId[] = ["cursor-agent-cli", "junie-cli"];

export function isExecutorProfileId(value: string | undefined | null): value is ExecutorProfileId {
  return value === "cursor-agent-cli" || value === "junie-cli";
}

/** User-visible labels for settings and Chat dropdown. */
export const EXECUTOR_PROFILE_LABELS: Record<ExecutorProfileId, string> = {
  "cursor-agent-cli": "Cursor CLI (agent)",
  "junie-cli": "Junie CLI",
};
