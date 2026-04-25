import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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
