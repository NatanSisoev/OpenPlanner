import * as vscode from "vscode";

/**
 * Product direction: spawn `claude` in integrated terminal (not implemented in v1 shell).
 */
export async function handoffClaudeTerminal(_prompt: string): Promise<void> {
  await vscode.window.showInformationMessage(
    "Planstack: Claude Code terminal handoff will open a terminal with context here in a later iteration.",
  );
}
