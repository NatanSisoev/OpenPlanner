import * as vscode from "vscode";
import type { Plan } from "./types";

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
