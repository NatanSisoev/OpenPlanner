import * as vscode from "vscode";

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

  const commandId =
    vscode.workspace.getConfiguration("planstack.cursor").get<string>("openComposerCommand")?.trim() ||
    vscode.workspace.getConfiguration("hackupc.nativeHandoff").get<string>("openComposerCommand")?.trim();

  if (!commandId) {
    await vscode.window.showInformationMessage(
      "HackUPC handoff: prompt copied to clipboard. Open Composer or Chat (e.g. Cmd+I or Cmd+L) and paste (Cmd+V). " +
        "To auto-open the panel, set Settings → HackUPC native handoff → Open Composer Command to a command ID from the Command Palette (gear → Copy Command ID).",
    );
    return;
  }

  try {
    await revealHandoffDocument(prompt);
    await vscode.commands.executeCommand(commandId);
    await vscode.window.showInformationMessage(
      `HackUPC handoff: prompt is on the clipboard and open in a preview tab. Ran "${commandId}". ` +
        `If Composer still shows only an @-mention to another file (e.g. the plan JSON), clear it and paste (Cmd+V), or rely on the open handoff tab as context.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(
      `HackUPC handoff: prompt was copied, but executeCommand("${commandId}") failed: ${msg}. Check hackupc.nativeHandoff.openComposerCommand.`,
    );
  }
}
