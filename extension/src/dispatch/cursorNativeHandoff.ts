import * as vscode from "vscode";

/**
 * Primary Cursor path from ide_plan_execution_1.plan.md:
 * put payload on clipboard, optionally run executeCommand to open/focus Composer.
 */
export async function handoffToNativeComposer(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);

  const commandId = vscode.workspace
    .getConfiguration("hackupc.nativeHandoff")
    .get<string>("openComposerCommand")
    ?.trim();

  if (!commandId) {
    await vscode.window.showInformationMessage(
      "HackUPC handoff: prompt copied to clipboard. Open Composer or Chat (e.g. Cmd+I or Cmd+L) and paste (Cmd+V). " +
        "To auto-open the panel, set Settings → HackUPC native handoff → Open Composer Command to a command ID from the Command Palette (gear → Copy Command ID).",
    );
    return;
  }

  try {
    await vscode.commands.executeCommand(commandId);
    await vscode.window.showInformationMessage(
      `HackUPC handoff: prompt copied; ran command "${commandId}". Paste (Cmd+V) in the input if the text did not appear automatically.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(
      `HackUPC handoff: prompt was copied, but executeCommand("${commandId}") failed: ${msg}. Check hackupc.nativeHandoff.openComposerCommand.`,
    );
  }
}
