import * as vscode from "vscode";
import { logLine } from "../log";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";

const PLANS_GLOB = ".planstack/plans/*.json";

/** Reported alongside successfully-loaded plans so callers can surface invalid files in the UI. */
export interface PlanLoadError {
  uri: vscode.Uri;
  message: string;
}

async function loadPlansFromFolder(
  folder: vscode.WorkspaceFolder,
  onError?: (err: PlanLoadError) => void,
): Promise<Plan[]> {
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
      onError?.({ uri, message: msg });
    }
  }
  return out;
}

/**
 * Load valid plan JSON from `.planstack/plans/*.json` across every workspace
 * folder. Duplicate ids: the first occurrence wins; later occurrences are
 * dropped with a warning so the user knows their tree has duplicates. When
 * `onError` is provided, the caller is notified once per file that failed to
 * parse/validate.
 */
export async function loadPlansFromWorkspace(
  onError?: (err: PlanLoadError) => void,
): Promise<Plan[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return [];
  }
  const seen = new Set<string>();
  const all: Plan[] = [];
  for (const folder of folders) {
    for (const plan of await loadPlansFromFolder(folder, onError)) {
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
