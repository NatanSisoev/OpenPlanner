import type { WorktreeChangeSummary } from "./worktreeChangeSummary";

const MAX_BASELINE_DIFF_LINES = 8;
const MAX_ADDED_LINES = 12;
const MAX_REMOVED_LINES = 8;
const MAX_LINE_CHARS = 100;

function normLines(block: string): string[] {
  return block
    .split("\n")
    .map((l) => l.trimEnd())
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Distilled Chat text for mid-run git polling: first snapshot = short baseline;
 * later snapshots = only lines that appeared or disappeared vs `previous` diff --stat.
 */
export function formatGitSnapshotDeltaForChat(
  previous: WorktreeChangeSummary | undefined,
  current: WorktreeChangeSummary,
): string | undefined {
  const curStat = normLines(current.diffStat);
  const prevStat = previous ? normLines(previous.diffStat) : [];

  if (!previous) {
    const parts: string[] = ["(baseline)"];
    if (current.statusLine) {
      parts.push(clip(current.statusLine, MAX_LINE_CHARS));
    }
    const head = curStat.slice(0, MAX_BASELINE_DIFF_LINES).map((l) => clip(l, MAX_LINE_CHARS));
    if (head.length > 0) {
      parts.push(...head);
    }
    if (curStat.length > MAX_BASELINE_DIFF_LINES) {
      parts.push(`… +${curStat.length - MAX_BASELINE_DIFF_LINES} more file(s) in diff --stat`);
    } else if (!current.statusLine && head.length === 0) {
      return "(clean vs HEAD)";
    }
    return parts.join("\n");
  }

  const prevSet = new Set(prevStat);
  const curSet = new Set(curStat);
  const added = curStat.filter((l) => !prevSet.has(l));
  const removed = prevStat.filter((l) => !curSet.has(l));

  const parts: string[] = [];

  if (current.statusLine !== previous.statusLine) {
    parts.push(
      `status: ${clip(previous.statusLine || "(none)", MAX_LINE_CHARS)} → ${clip(current.statusLine || "(none)", MAX_LINE_CHARS)}`,
    );
  }

  const showAdded = added.slice(0, MAX_ADDED_LINES);
  for (const l of showAdded) {
    parts.push(`+ ${clip(l, MAX_LINE_CHARS)}`);
  }
  if (added.length > MAX_ADDED_LINES) {
    parts.push(`+ … (${added.length - MAX_ADDED_LINES} more new/changed lines)`);
  }

  const showRemoved = removed.slice(0, MAX_REMOVED_LINES);
  for (const l of showRemoved) {
    parts.push(`- ${clip(l, MAX_LINE_CHARS)}`);
  }
  if (removed.length > MAX_REMOVED_LINES) {
    parts.push(`- … (${removed.length - MAX_REMOVED_LINES} more removed lines)`);
  }

  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

/** Stable fingerprint for skip-if-unchanged between polls. */
export function gitSnapshotFingerprint(s: WorktreeChangeSummary): string {
  return `${s.statusLine}\n${s.diffStat}`;
}
