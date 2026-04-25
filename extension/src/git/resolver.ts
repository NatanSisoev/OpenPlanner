import * as vscode from "vscode";
import type { Phase, Plan } from "../plan/types";

/**
 * Normative: `effectiveWorkBranch(phase) := phase.git.phaseBranch ?? plan.git.planBranch ?? null`
 */
export function effectiveWorkBranch(phase: Phase, plan: Plan): string | undefined {
  return phase.git?.phaseBranch ?? plan.git?.planBranch ?? undefined;
}

export interface GitBranchSummary {
  /** Resolved work branch name from plan metadata, if any. */
  effectiveBranch: string | undefined;
  /** Whether the built-in Git extension reported a repository for this workspace (best-effort). */
  hasGitRepository: boolean;
  /** Current HEAD branch or short ref label when available. */
  currentBranchLabel?: string;
}

/**
 * Best-effort snapshot for orchestration UI. Uses `vscode.git` when present; otherwise conservative defaults.
 */
export async function summarizeGitForPlan(
  _workspaceRoot: vscode.Uri,
  phase: Phase,
  plan: Plan,
): Promise<GitBranchSummary> {
  const effectiveBranch = effectiveWorkBranch(phase, plan);
  let hasGitRepository = false;
  let currentBranchLabel: string | undefined;

  try {
    const gitApi = await getGitApi();
    if (gitApi) {
      const repos = gitApi.repositories;
      hasGitRepository = repos.length > 0;
      const repo = repos[0];
      if (repo?.state?.HEAD?.name) {
        currentBranchLabel = repo.state.HEAD.name;
      } else if (repo?.state?.HEAD?.commit) {
        currentBranchLabel = repo.state.HEAD.commit.slice(0, 7);
      }
    }
  } catch {
    // Git extension unavailable or API mismatch — still return branch metadata from plan JSON.
  }

  return { effectiveBranch, hasGitRepository, currentBranchLabel };
}

// ---- Minimal vscode.git typings (avoid coupling to unpublished @types) ----

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: number): GitAPI | undefined;
}

interface GitAPI {
  readonly repositories: GitRepository[];
}

interface GitRepository {
  readonly state: {
    readonly HEAD?: { readonly name?: string; readonly commit?: string };
  };
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) {
    return undefined;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext.exports?.getAPI(1);
}
