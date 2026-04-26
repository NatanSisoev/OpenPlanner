import * as path from "path";
import * as vscode from "vscode";
import { traceEvent } from "../debug/trace";

const DEFAULT_DEBOUNCE_MS = 200;

function shouldRevealPath(fsPathNorm: string, cwdNorm: string): boolean {
  const rel = path.relative(cwdNorm, fsPathNorm);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(path.sep);
  return !segments.some((s) => s === ".git" || s === "node_modules");
}

/**
 * While the Cursor headless agent is applying edits, watch the workspace tree under `cwd`
 * and open matching files as preview editors so the user can see what is being touched.
 */
export function startRevealAgentEditedFilesSession(cwd: string, debugTraceId?: string): vscode.Disposable {
  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  if (!cfg.get<boolean>("revealAgentEditedFiles", true)) {
    return { dispose: () => {} };
  }

  const cwdNorm = path.normalize(cwd);
  const preserveFocus = !cfg.get<boolean>("revealAgentEditedFilesFocusEditor", false);
  const debounceMs = Math.max(50, cfg.get<number>("revealAgentEditedFilesDebounceMs") ?? DEFAULT_DEBOUNCE_MS);

  let disposed = false;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const flushReveal = (uri: vscode.Uri): void => {
    if (disposed) {
      return;
    }
    const fsPathNorm = path.normalize(uri.fsPath);
    if (!shouldRevealPath(fsPathNorm, cwdNorm)) {
      return;
    }
    void (async () => {
      if (disposed) {
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (disposed) {
          return;
        }
        await vscode.window.showTextDocument(doc, {
          preview: true,
          preserveFocus,
        });
        if (debugTraceId) {
          traceEvent(debugTraceId, "revealAgentEditedFile", { path: fsPathNorm });
        }
      } catch {
        // Non-text or unreadable; skip silently.
      }
    })();
  };

  const scheduleReveal = (uri: vscode.Uri): void => {
    if (disposed) {
      return;
    }
    const key = path.normalize(uri.fsPath);
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        flushReveal(uri);
      }, debounceMs),
    );
  };

  const base = vscode.Uri.file(cwdNorm);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, "**/*"));

  const onUri = (uri: vscode.Uri | undefined): void => {
    if (uri) {
      scheduleReveal(uri);
    }
  };

  watcher.onDidChange(onUri);
  watcher.onDidCreate(onUri);

  return new vscode.Disposable(() => {
    disposed = true;
    watcher.dispose();
    for (const t of pending.values()) {
      clearTimeout(t);
    }
    pending.clear();
  });
}
