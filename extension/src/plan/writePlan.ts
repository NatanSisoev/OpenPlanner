import * as vscode from "vscode";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";

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

export async function saveValidatedPlan(plan: Plan, workspaceRoot: vscode.Uri): Promise<vscode.Uri> {
  const dir = vscode.Uri.joinPath(workspaceRoot, ".planstack", "plans");
  await vscode.workspace.fs.createDirectory(dir);
  const base = sanitizePlanFileBasename(plan.id);
  const file = vscode.Uri.joinPath(dir, `${base}.json`);
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(json));
  return file;
}

export async function savePlanPreservingFile(plan: Plan, workspaceRoot: vscode.Uri): Promise<vscode.Uri> {
  const existing = await findPlanFileById(plan.id, workspaceRoot);
  if (existing) {
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(existing, new TextEncoder().encode(json));
    return existing;
  }
  return saveValidatedPlan(plan, workspaceRoot);
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
