import * as vscode from "vscode";
import { logLine } from "../log";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";

const PLANS_GLOB = ".planstack/plans/*.json";

async function loadPlansFromFolder(folder: vscode.WorkspaceFolder): Promise<Plan[]> {
  const pattern = new vscode.RelativePattern(folder, PLANS_GLOB);
  const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 200, undefined);
  const out: Plan[] = [];
  for (const uri of uris) {
    try {
      const doc = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(doc).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      out.push(validatePlanJson(parsed));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logLine(`loader: skipping ${uri.fsPath} (${msg})`);
    }
  }
  return out;
}

/**
 * Load valid plan JSON from `.planstack/plans/*.json` across every workspace
 * folder. Duplicate ids are dropped (later wins is undefined; warn so the user
 * knows their tree has duplicates).
 */
export async function loadPlansFromWorkspace(): Promise<Plan[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return [];
  }
  const seen = new Set<string>();
  const all: Plan[] = [];
  for (const folder of folders) {
    for (const plan of await loadPlansFromFolder(folder)) {
      if (seen.has(plan.id)) {
        logLine(`loader: duplicate plan id ${plan.id} (keeping first occurrence)`);
        continue;
      }
      seen.add(plan.id);
      all.push(plan);
    }
  }
  return all;
}

/**
 * Watch `.planstack/plans/*.json` for create/change/delete and call `onChange`
 * after a short debounce. Returns a Disposable that tears the watcher down.
 */
export function watchPlans(onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${PLANS_GLOB}`);
  let timer: NodeJS.Timeout | undefined;
  const fire = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, 150);
  };
  const subs = [
    watcher,
    watcher.onDidCreate(fire),
    watcher.onDidChange(fire),
    watcher.onDidDelete(fire),
  ];
  return new vscode.Disposable(() => {
    if (timer) {
      clearTimeout(timer);
    }
    for (const s of subs) {
      s.dispose();
    }
  });
}
