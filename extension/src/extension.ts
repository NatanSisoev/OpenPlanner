import * as vscode from "vscode";
import { handoffToNativeComposer } from "./dispatch/cursorNativeHandoff";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.nativeHandoff.demo", async () => {
      const prompt =
        `HackUPC native handoff spike (${new Date().toISOString()}):\n\n` +
        `Summarize docs/base_idea.md in two bullet points. Only that file for context.`;

      await handoffToNativeComposer(prompt);
    }),
  );
}

export function deactivate(): void {}
