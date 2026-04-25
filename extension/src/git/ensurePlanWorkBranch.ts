import * as vscode from "vscode";
import type { Plan } from "../plan/types";
import { postChatSystemMessage } from "../ui/chatStatusBridge";
import { getGitApi, type GitAPI, type GitRepository } from "./resolver";

function planChatLabel(plan: Plan): string {
  const t = plan.title.trim();
  return t.length > 0 ? `${t} (${plan.id})` : plan.id;
}

function mementoKey(planId: string): string {
  return `planstack.git.planBranchReady.${planId}`;
}

async function localBranchExists(repo: GitRepository, name: string): Promise<boolean> {
  try {
    await repo.getBranch(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the ref to create `planBranch` from: `baseBranch` if it exists locally, else current HEAD (with warning).
 */
async function resolveStartRef(repo: GitRepository, planBranch: string, baseBranch: string): Promise<string> {
  if (await localBranchExists(repo, baseBranch)) {
    return baseBranch;
  }
  const head = repo.state.HEAD?.name ?? repo.state.HEAD?.commit;
  if (!head) {
    throw new Error("Cannot resolve a base ref: no local HEAD.");
  }
  void vscode.window.showWarningMessage(
    `Planstack: base branch "${baseBranch}" not found locally; creating "${planBranch}" from current HEAD.`,
  );
  return head;
}

function pickRepository(api: GitAPI): GitRepository | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder && api.getRepository) {
    const r = api.getRepository(folder);
    if (r) {
      return r;
    }
  }
  return api.repositories[0];
}

/**
 * On first Run phase for this plan (per workspace memento), create `git.planBranch` from `git.baseBranch` (default `main`) if missing, then check out.
 * No-op when `git.planBranch` is absent, or Git is unavailable (Chat explains).
 */
/** @returns whether Run phase should continue (false = branch prep failed; abort execution). */
export async function ensurePlanWorkBranch(plan: Plan, workspaceState: vscode.Memento): Promise<boolean> {
  const label = planChatLabel(plan);

  if (workspaceState.get<boolean>(mementoKey(plan.id))) {
    return true;
  }

  const planBranch = plan.git?.planBranch?.trim();
  if (!planBranch) {
    postChatSystemMessage(`${label}: no git.planBranch in plan — branch setup skipped.`);
    return true;
  }

  const api = await getGitApi();

  if (!api || !api.repositories?.length) {
    postChatSystemMessage(`${label}: no Git repository here — branch setup skipped.`);
    return true;
  }

  const repo = pickRepository(api);
  if (!repo) {
    postChatSystemMessage(`${label}: no Git repository here — branch setup skipped.`);
    return true;
  }

  const baseBranch = plan.git?.baseBranch?.trim() || "main";

  try {
    if (await localBranchExists(repo, planBranch)) {
      await repo.checkout(planBranch);
      postChatSystemMessage(`${label}: checked out existing branch "${planBranch}".`);
    } else {
      const startRef = await resolveStartRef(repo, planBranch, baseBranch);
      await repo.createBranch(planBranch, true, startRef);
      postChatSystemMessage(`${label}: created and checked out branch "${planBranch}" from "${startRef}".`);
    }
    await workspaceState.update(mementoKey(plan.id), true);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Planstack: could not prepare branch "${planBranch}": ${msg.slice(0, 500)}`);
    return false;
  }
}
