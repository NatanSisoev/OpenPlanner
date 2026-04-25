import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface FileDiff {
  /** Workspace-relative path that should be used when opening a diff. */
  path: string;
  /** Optional source path for rename/copy records. */
  oldPath?: string;
  /** Optional UI label (e.g. rename old -> new) while keeping `path` openable. */
  displayPath?: string;
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
 * Parse `git diff --numstat -z HEAD` output into structured per-file data.
 * - Regular record: `<add>\t<del>\t<path>\0`
 * - Rename/copy record: `<add>\t<del>\t\0<old>\0<new>\0`
 * Binary files use `-` for counts.
 */
export function parseNumstatZ(numstatZ: string): FileDiff[] {
  const result: FileDiff[] = [];
  const tokens = numstatZ.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i];
    if (!raw) {
      continue;
    }

    const parts = raw.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const addStr = parts[0] ?? "";
    const delStr = parts[1] ?? "";
    const firstPath = parts.slice(2).join("\t");
    const additions = addStr === "-" ? 0 : parseInt(addStr!, 10);
    const deletions = delStr === "-" ? 0 : parseInt(delStr!, 10);
    if (isNaN(additions) || isNaN(deletions)) {
      continue;
    }

    if (firstPath) {
      result.push({ path: firstPath, additions, deletions });
      continue;
    }

    // Rename/copy format with NUL-separated old/new paths.
    const oldPath = tokens[i + 1] ?? "";
    const newPath = tokens[i + 2] ?? "";
    if (!newPath) {
      continue;
    }
    i += 2;
    result.push({
      path: newPath,
      oldPath: oldPath || undefined,
      displayPath: oldPath ? `${oldPath} -> ${newPath}` : newPath,
      additions,
      deletions,
    });
  }
  return result;
}

/** Per-file diff stats vs HEAD. Returns empty array if not a repo or git fails. */
export async function getWorktreeNumstat(cwd: string): Promise<FileDiff[]> {
  const git = process.platform === "win32" ? "git.exe" : "git";
  try {
    const { stdout } = await execFileAsync(git, ["diff", "--numstat", "-z", "HEAD"], {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return parseNumstatZ(String(stdout));
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
