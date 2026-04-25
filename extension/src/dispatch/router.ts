import * as vscode from "vscode";
import { getExecutionMode, type ExecutionMode } from "../plan/modes";
import { handoffClaudeTerminal } from "./claudeCode";
import { handoffViaAgentCli } from "./cursorCli";
import { handoffToNativeComposer } from "./cursorNativeHandoff";
import { handoffViaCursorSdk } from "./cursorSdk";

/** @deprecated Use ExecutionMode from plan/modes.ts; kept for callers that imported HandoffMode. */
export type HandoffMode = ExecutionMode;

/** @deprecated Use getExecutionMode from plan/modes.ts. */
export function getConfiguredHandoffMode(): ExecutionMode {
  return getExecutionMode();
}

export type DispatchPhaseOptions = {
  /** Shown in Chat status lines (e.g. plan title › phase title). */
  statusLabel?: string;
};

/**
 * Routes phase execution per `planstack.cursor.executionMode` (legacy: `planstack.cursor.handoff`).
 */
export async function dispatchPhaseHandoff(
  prompt: string,
  extensionContext: vscode.ExtensionContext,
  options?: DispatchPhaseOptions,
): Promise<void> {
  const mode = getExecutionMode();
  switch (mode) {
    case "native-first":
      return handoffToNativeComposer(prompt);
    case "sdk-local":
      return handoffViaCursorSdk(prompt, "local");
    case "sdk-cloud":
      return handoffViaCursorSdk(prompt, "cloud");
    case "cli":
      return handoffViaAgentCli(prompt, extensionContext, options?.statusLabel);
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Optional path: integrated terminal + `claude` (product doc). */
export async function dispatchClaudeHandoff(prompt: string): Promise<void> {
  return handoffClaudeTerminal(prompt);
}
