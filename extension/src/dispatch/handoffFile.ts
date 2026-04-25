import * as path from "path";
import * as vscode from "vscode";
import { getHandoffFileRelativePath } from "../plan/executorConfig";

export type HandoffFileMeta = {
  planId?: string;
  phaseId?: string;
  planTitle?: string;
  phaseTitle?: string;
};

/**
 * Writes the phase (or any) prompt to the configured handoff path under the workspace
 * so JetBrains Junie users can @-attach one file. Creates parent dirs when needed.
 */
export async function writePlanstackHandoffFile(
  workspaceRoot: vscode.Uri,
  body: string,
  meta?: HandoffFileMeta,
): Promise<vscode.Uri> {
  const rel = getHandoffFileRelativePath().replace(/\\/g, "/");
  const segments = rel.split("/").filter(Boolean);
  const targetUri = vscode.Uri.joinPath(workspaceRoot, ...segments);
  const parentUri =
    segments.length > 1 ? vscode.Uri.joinPath(workspaceRoot, ...segments.slice(0, -1)) : workspaceRoot;
  const footerParts: string[] = [];
  if (meta?.planId) {
    footerParts.push(`planId: ${meta.planId}`);
  }
  if (meta?.phaseId) {
    footerParts.push(`phaseId: ${meta.phaseId}`);
  }
  if (meta?.planTitle || meta?.phaseTitle) {
    footerParts.push(`title: ${[meta.planTitle, meta.phaseTitle].filter(Boolean).join(" › ")}`);
  }
  const footer =
    footerParts.length > 0
      ? `\n\n---\n*Planstack handoff metadata — safe to delete before sending to Junie.*\n${footerParts.join(" · ")}\n`
      : "";
  const text = body.trimEnd() + footer;
  await vscode.workspace.fs.createDirectory(parentUri);
  await vscode.workspace.fs.writeFile(targetUri, Buffer.from(text, "utf8"));
  return targetUri;
}

/** Resolve display path for UI (relative when under workspace). */
export function handoffPathForMessage(workspaceRoot: vscode.Uri, written: vscode.Uri): string {
  const rel = path.relative(workspaceRoot.fsPath, written.fsPath);
  if (rel && !rel.startsWith("..")) {
    return rel.split(path.sep).join("/");
  }
  return written.fsPath;
}
