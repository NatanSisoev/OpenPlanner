import * as vscode from "vscode";
import { postChatSystemMessage } from "../ui/chatStatusBridge";
import { handoffPathForMessage, writePlanstackHandoffFile } from "./handoffFile";
import { getWriteHandoffFile } from "../plan/executorConfig";

/**
 * When Composer opens, Cursor often auto-inserts an @-mention for the **previously**
 * active editor (e.g. `seed/plan-auth-refactor.json`). If that file is the plan JSON,
 * the model sees the raw plan file—not the clipboard handoff. Opening a preview editor
 * whose document *is* the handoff makes the injected context match the intended prompt.
 */
async function revealHandoffDocument(prompt: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: prompt,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, {
    preview: true,
    preserveFocus: false,
  });
}

/**
 * Primary Cursor path from ide_plan_execution_1.plan.md:
 * put payload on clipboard, optionally run executeCommand to open/focus Composer.
 */
export async function handoffToNativeComposer(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder && getWriteHandoffFile()) {
    try {
      const written = await writePlanstackHandoffFile(folder.uri, prompt);
      postChatSystemMessage(
        `Handoff file: ${handoffPathForMessage(folder.uri, written)} — attach in Junie or another agent.`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showWarningMessage(`Planstack: could not write handoff file: ${msg.slice(0, 200)}`);
    }
  }

  const commandId =
    vscode.workspace.getConfiguration("planstack.cursor").get<string>("openComposerCommand")?.trim() ||
    vscode.workspace.getConfiguration("hackupc.nativeHandoff").get<string>("openComposerCommand")?.trim();

  if (!commandId) {
    await vscode.window.showInformationMessage(
      "Planstack (native-first): prompt copied to clipboard — open Composer or Chat (Cmd+I / Cmd+L) and paste (Cmd+V). " +
        "Optional: set planstack.cursor.openComposerCommand to a command ID from the palette (Copy Command ID). " +
        "Default Run phase is headless CLI; you chose native-first execution in settings.",
    );
    return;
  }

  try {
    await revealHandoffDocument(prompt);
    await vscode.commands.executeCommand(commandId);
    await vscode.window.showInformationMessage(
      `Planstack handoff: prompt is on the clipboard and open in a preview tab. Ran "${commandId}". ` +
        `If Composer still shows only an @-mention to another file (e.g. the plan JSON), clear it and paste (Cmd+V), or rely on the open handoff tab as context.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(
      `Planstack handoff: prompt was copied, but executeCommand("${commandId}") failed: ${msg}. Check planstack.cursor.openComposerCommand.`,
    );
  }
}
