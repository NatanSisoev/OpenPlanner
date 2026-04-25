import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import type { Plan } from "../plan/types";
import { getGitApi, type GitAPI, type GitRepository } from "./resolver";

const execFileAsync = promisify(execFile);

export interface MergePlanBranchResult {
  baseBranch: string;
  planBranch: string;
  status: "merged" | "already_merged";
  detail?: string;
}

function pickRepository(api: GitAPI): GitRepository | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder && api.getRepository) {
    const fromFolder = api.getRepository(folder);
    if (fromFolder) {
      return fromFolder;
    }
  }
  return api.repositories[0];
}

function gitExec(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const git = process.platform === "win32" ? "git.exe" : "git";
  return execFileAsync(git, args, {
    cwd,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

function shortDetail(text: string, maxChars = 800): string {
  const t = text.trim();
  if (!t) {
    return "";
  }
  return t.length <= maxChars ? t : `${t.slice(0, maxChars)}…`;
}

async function ensureLocalBranchExists(repo: GitRepository, branchName: string): Promise<void> {
  try {
    await repo.getBranch(branchName);
  } catch {
    throw new Error(`Local branch "${branchName}" does not exist.`);
  }
}

async function isAncestor(cwd: string, possibleAncestor: string, possibleDescendant: string): Promise<boolean> {
  try {
    await gitExec(cwd, ["merge-base", "--is-ancestor", possibleAncestor, possibleDescendant]);
    return true;
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === "number" ? (e as { code: number }).code : undefined;
    if (code === 1) {
      return false;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not check merge ancestry: ${shortDetail(msg)}`);
  }
}

export async function mergePlanBranchNoFf(plan: Plan): Promise<MergePlanBranchResult> {
  if (plan.state !== "completed") {
    throw new Error(`Plan "${plan.id}" is not completed yet.`);
  }
  const planBranch = plan.git?.planBranch?.trim();
  if (!planBranch) {
    throw new Error(`Plan "${plan.id}" has no git.planBranch configured.`);
  }
  const baseBranch = plan.git?.baseBranch?.trim() || "main";
  if (baseBranch === planBranch) {
    throw new Error("Base branch and plan branch are the same; merge skipped.");
  }

  const gitApi = await getGitApi();
  if (!gitApi || gitApi.repositories.length === 0) {
    throw new Error("No Git repository is available in this workspace.");
  }
  const repo = pickRepository(gitApi);
  if (!repo) {
    throw new Error("No Git repository is available in this workspace.");
  }
  const cwd = repo.rootUri.fsPath;

  await ensureLocalBranchExists(repo, planBranch);
  await ensureLocalBranchExists(repo, baseBranch);

  const status = await gitExec(cwd, ["status", "--porcelain"]);
  if (status.stdout.trim()) {
    throw new Error(
      `Working tree is not clean. Commit/stash changes before merging.\n${shortDetail(status.stdout, 300)}`,
    );
  }

  await repo.checkout(baseBranch);

  const alreadyMerged = await isAncestor(cwd, planBranch, baseBranch);
  if (alreadyMerged) {
    return { baseBranch, planBranch, status: "already_merged" };
  }

  try {
    const merge = await gitExec(cwd, ["merge", "--no-ff", "--no-edit", planBranch]);
    const detail = shortDetail(`${merge.stdout}\n${merge.stderr}`);
    return { baseBranch, planBranch, status: "merged", detail: detail || undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Merge failed. Resolve conflicts and continue manually (or abort with git merge --abort).\n${shortDetail(msg)}`,
    );
  }
}
