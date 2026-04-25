import * as vscode from "vscode";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";

const PLANS_RELATIVE = ".planstack/plans/*.json";
const SEED_RELATIVE = "seed/*.json";

async function loadPlansFromPattern(
  folder: vscode.WorkspaceFolder,
  relativeGlob: string,
): Promise<Plan[]> {
  const pattern = new vscode.RelativePattern(folder, relativeGlob);
  const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 200, undefined);
  const out: Plan[] = [];
  for (const uri of uris) {
    try {
      const doc = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(doc).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      out.push(validatePlanJson(parsed));
    } catch {
      // Skip broken files; keep UI responsive.
    }
  }
  return out;
}

/**
 * Load valid plan JSON from each workspace folder: `.planstack/plans/*.json` first, then `seed/*.json`.
 * Same `id` in both trees keeps the `.planstack/plans` copy (seed duplicate skipped).
 */
export async function loadPlansFromWorkspace(): Promise<Plan[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return [];
  }
  const all: Plan[] = [];
  for (const folder of folders) {
    const fromPlanstack = await loadPlansFromPattern(folder, PLANS_RELATIVE);
    const ids = new Set(fromPlanstack.map((p) => p.id));
    const fromSeed = await loadPlansFromPattern(folder, SEED_RELATIVE);
    const merged = [...fromPlanstack];
    for (const p of fromSeed) {
      if (!ids.has(p.id)) {
        ids.add(p.id);
        merged.push(p);
      }
    }
    all.push(...merged);
  }
  return all;
}
