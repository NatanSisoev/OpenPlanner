import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
}

export interface WorktreeChangeSummary {
  /** First line of `git status -sb` (branch + short counts). */
  statusLine: string;
  /** Full `git diff --stat HEAD` text (may be empty if clean). */
  diffStat: string;
}

/**
 * Read-only snapshot of working tree vs HEAD. Returns undefined if not a git repo or git fails.
 */
export async function getWorktreeChangeSummary(cwd: string): Promise<WorktreeChangeSummary | undefined> {
  const git = process.platform === "win32" ? "git.exe" : "git";
  try {
    const { stdout: diffStat } = await execFileAsync(git, ["diff", "--stat", "HEAD"], {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const { stdout: statusOut } = await execFileAsync(git, ["status", "-sb"], {
      cwd,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const lines = String(statusOut).trim().split("\n");
    return {
      diffStat: String(diffStat).trim(),
      statusLine: (lines[0] || "").trim(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Parse `git diff --numstat HEAD` output into structured per-file data.
 * Numstat format: `<additions>\t<deletions>\t<path>` (binary files use `-`).
 */
export function parseNumstat(numstat: string): FileDiff[] {
  const result: FileDiff[] = [];
  for (const line of numstat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const [addStr, delStr, ...pathParts] = parts;
    const filePath = pathParts.join("\t");
    const additions = addStr === "-" ? 0 : parseInt(addStr!, 10);
    const deletions = delStr === "-" ? 0 : parseInt(delStr!, 10);
    if (!filePath || isNaN(additions) || isNaN(deletions)) {
      continue;
    }
    result.push({ path: filePath, additions, deletions });
  }
  return result;
}

/** Per-file diff stats vs HEAD. Returns empty array if not a repo or git fails. */
export async function getWorktreeNumstat(cwd: string): Promise<FileDiff[]> {
  const git = process.platform === "win32" ? "git.exe" : "git";
  try {
    const { stdout } = await execFileAsync(git, ["diff", "--numstat", "HEAD"], {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return parseNumstat(String(stdout));
  } catch {
    return [];
  }
}

/** One line for chat / toast; truncates long stat blocks. */
export function formatGitSummaryChatLine(summary: WorktreeChangeSummary, maxChars = 420): string {
  const parts: string[] = [];
  if (summary.statusLine) {
    parts.push(summary.statusLine);
  }
  if (summary.diffStat) {
    parts.push(summary.diffStat.length <= maxChars ? summary.diffStat : `${summary.diffStat.slice(0, maxChars)}…`);
  }
  if (parts.length === 0) {
    return "Git: no diff vs HEAD (clean or not a repo).";
  }
  return parts.join("\n");
}
