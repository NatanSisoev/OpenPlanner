# HackUPC extension (native handoff spike)

This package implements the **second approach** from the product plan: **native handoff** — copy a constructed prompt to the clipboard, then optionally call `vscode.commands.executeCommand` so Cursor can open or focus Composer / Agent ([ide plan](../docs/ide_plan_execution_1.plan.md)).

It does **not** run the headless `agent` CLI (that is the other path; see repo [docs/cursor_agent_cli_validation.md](../docs/cursor_agent_cli_validation.md)).

## Try it in Cursor

1. Open this repository as the workspace folder in **Cursor**.
2. From the repo root, press **F5** (or **Run → Start Debugging**) — launch config is under [../.vscode](../.vscode).
3. A new **[Extension Development Host]** window opens.
4. In that window, open **Command Palette** (Cmd+Shift+P) and run **“HackUPC: Native handoff demo (clipboard + Composer)”**.
5. You should get a toast: prompt copied; if you configured `hackupc.nativeHandoff.openComposerCommand`, the matching panel command runs next.

### Optional: auto-open Composer / Chat

Cursor’s internal command IDs can change between releases. To wire auto-focus:

1. Command Palette → search for the action that opens the UI you want (e.g. Composer).
2. Use **gear → Copy Command ID** (or your Cursor build’s equivalent).
3. In Settings (JSON or UI), set **`hackupc.nativeHandoff.openComposerCommand`** to that string.

If you leave it empty, the spike still validates **clipboard handoff**; you only open the panel yourself.

## Build

```bash
cd extension
npm install
npm run compile
```

## Layout

Matches the planned dispatch location: [`src/dispatch/cursorNativeHandoff.ts`](src/dispatch/cursorNativeHandoff.ts).
