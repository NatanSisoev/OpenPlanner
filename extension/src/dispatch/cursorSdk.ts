import * as vscode from "vscode";

/** Placeholder for @cursor/february / headless paths (non-default). */
export async function handoffViaCursorSdk(
  _prompt: string,
  _target: "local" | "cloud",
): Promise<void> {
  await vscode.window.showWarningMessage(
    "Planstack: SDK execution is not wired yet. Set planstack.cursor.executionMode to native-first for clipboard handoff, or implement cursorSdk.ts for your environment.",
  );
}
