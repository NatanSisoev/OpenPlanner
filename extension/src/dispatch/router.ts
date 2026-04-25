import * as vscode from "vscode";
import { handoffClaudeTerminal } from "./claudeCode";
import { handoffViaAgentCli } from "./cursorCli";
import { handoffToNativeComposer } from "./cursorNativeHandoff";
import { handoffViaCursorSdk } from "./cursorSdk";

export type HandoffMode = "native-first" | "sdk-local" | "sdk-cloud" | "cli";

export function getConfiguredHandoffMode(): HandoffMode {
  const raw = vscode.workspace.getConfiguration("planstack.cursor").get<string>("handoff");
  if (
    raw === "sdk-local" ||
    raw === "sdk-cloud" ||
    raw === "cli" ||
    raw === "native-first"
  ) {
    return raw;
  }
  return "native-first";
}

/**
 * Routes phase handoff per `planstack.cursor.handoff` (ide_plan_execution_1.plan.md).
 */
export async function dispatchPhaseHandoff(prompt: string): Promise<void> {
  const mode = getConfiguredHandoffMode();
  switch (mode) {
    case "native-first":
      return handoffToNativeComposer(prompt);
    case "sdk-local":
      return handoffViaCursorSdk(prompt, "local");
    case "sdk-cloud":
      return handoffViaCursorSdk(prompt, "cloud");
    case "cli":
      return handoffViaAgentCli(prompt);
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
