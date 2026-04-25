import * as vscode from "vscode";

/** Placeholder for Cursor `agent` CLI headless path. */
export async function handoffViaAgentCli(_prompt: string): Promise<void> {
  await vscode.window.showWarningMessage(
    "Planstack: CLI handoff is not wired yet. Use native-first, or implement cursorCli.ts.",
  );
}
