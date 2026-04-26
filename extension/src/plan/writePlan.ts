import * as vscode from "vscode";
import type { Plan } from "./types";
import { stampLocalPlanSync } from "./planSyncStamp";
import { validatePlanJson } from "./validate";

export type SavePlanOptions = {
  /** When true, do not bump `plan.sync` (e.g. after Mongo reconcile wrote remote winner). */
  skipSyncStamp?: boolean;
};

/** Safe filename segment from plan id (keeps alnum, dash, underscore). */
export function sanitizePlanFileBasename(planId: string): string {
  const s = planId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s.length > 0 ? s : "plan";
}

/**
 * Write `content` to `target` via `<target>.tmp` + rename so a crashed write
 * can't leave a half-written plan file on disk.
 */
async function atomicWriteUtf8(target: vscode.Uri, content: string): Promise<void> {
  const tmp = target.with({ path: `${target.path}.tmp` });
  const bytes = new TextEncoder().encode(content);
  await vscode.workspace.fs.writeFile(tmp, bytes);
  try {
    await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
  } catch (err) {
    try {
      await vscode.workspace.fs.delete(tmp);
    } catch {
      // best-effort cleanup of the orphaned tmp
    }
    throw err;
  }
}

export async function saveValidatedPlan(
  plan: Plan,
  workspaceRoot: vscode.Uri,
  options?: SavePlanOptions,
): Promise<vscode.Uri> {
  if (!options?.skipSyncStamp) {
    stampLocalPlanSync(plan);
  }
  const dir = vscode.Uri.joinPath(workspaceRoot, ".planstack", "plans");
  await vscode.workspace.fs.createDirectory(dir);
  const base = sanitizePlanFileBasename(plan.id);
  const file = vscode.Uri.joinPath(dir, `${base}.json`);
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  await atomicWriteUtf8(file, json);
  return file;
}

export async function savePlanPreservingFile(
  plan: Plan,
  workspaceRoot: vscode.Uri,
  options?: SavePlanOptions,
): Promise<vscode.Uri> {
  const existing = await findPlanFileById(plan.id, workspaceRoot);
  if (existing) {
    if (!options?.skipSyncStamp) {
      stampLocalPlanSync(plan);
    }
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    await atomicWriteUtf8(existing, json);
    return existing;
  }
  return saveValidatedPlan(plan, workspaceRoot, options);
}

export async function deletePlanFile(planId: string, workspaceRoot: vscode.Uri): Promise<boolean> {
  const existing = await findPlanFileById(planId, workspaceRoot);
  if (!existing) {
    return false;
  }
  await vscode.workspace.fs.delete(existing, { useTrash: true });
  return true;
}

async function findPlanFileById(planId: string, workspaceRoot: vscode.Uri): Promise<vscode.Uri | undefined> {
  const pattern = new vscode.RelativePattern(workspaceRoot, ".planstack/plans/*.json");
  const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 200, undefined);
  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      const validated = validatePlanJson(parsed);
      if (validated.id === planId) {
        return uri;
      }
    } catch {
      // Ignore invalid plan files while searching.
    }
  }
  return undefined;
}
