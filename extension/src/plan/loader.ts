import * as vscode from "vscode";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";

const PLANS_RELATIVE = ".planstack/plans/*.json";

/**
 * Load all valid plan files under `.planstack/plans/*.json` from workspace folders.
 * Invalid files are skipped; diagnostics can be added later.
 */
export async function loadPlansFromWorkspace(): Promise<Plan[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return [];
  }
  const out: Plan[] = [];
  for (const folder of folders) {
    const pattern = new vscode.RelativePattern(folder, PLANS_RELATIVE);
    const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 200, undefined);
    for (const uri of uris) {
      try {
        const doc = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(doc).toString("utf8");
        const parsed: unknown = JSON.parse(text);
        out.push(validatePlanJson(parsed));
      } catch {
        // Skip broken files for v1 tree; keep UI responsive.
      }
    }
  }
  return out;
}
