import * as vscode from "vscode";
import { type ExecutorProfileId, isExecutorProfileId } from "./executorProfiles";

function executorCfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("planstack.executor");
}

function cursorCfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("planstack.cursor");
}

/**
 * Active headless CLI profile for Create plan, Send, and Run phase when executionMode is `cli`.
 * Uses `planstack.executor.activeProfile` when set at workspace/global level; otherwise
 * legacy non-empty `planstack.cursor.activeProfile`; otherwise Cursor CLI.
 */
export function getActiveExecutorProfileId(): ExecutorProfileId {
  const insp = executorCfg().inspect<string>("activeProfile");
  const explicitRaw = insp?.workspaceFolderValue ?? insp?.workspaceValue ?? insp?.globalValue;
  if (explicitRaw !== undefined && explicitRaw !== null) {
    const s = String(explicitRaw).trim();
    if (isExecutorProfileId(s)) {
      return s;
    }
  }
  const legacy = cursorCfg().get<string>("activeProfile")?.trim();
  if (legacy && isExecutorProfileId(legacy)) {
    return legacy;
  }
  return "cursor-agent-cli";
}

export function getWriteHandoffFile(): boolean {
  return executorCfg().get<boolean>("writeHandoffFile") ?? true;
}

/** Path relative to workspace folder (POSIX-style segments OK). */
export function getHandoffFileRelativePath(): string {
  const raw = executorCfg().get<string>("handoffFileRelativePath")?.trim();
  return raw && raw.length > 0 ? raw : ".planstack/handoff.md";
}

/** When true, write the handoff file before headless CLI runs (Junie @file in same repo). */
export function getWriteHandoffFileOnCliRun(): boolean {
  return executorCfg().get<boolean>("writeHandoffFileOnCliRun") ?? true;
}

export function getJunieExecutable(): string {
  return executorCfg().get<string>("juniePath")?.trim() || "junie";
}
