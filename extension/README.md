# HackUPC Planstack (VS Code / Cursor extension)

Orchestration UI for phased plans (`.planstack/plans/*.json`) with **native handoff**: copy a phase prompt to the clipboard, then optionally run a VS Code command to focus Cursor Composer / Agent ([product plan](../docs/ide_plan_execution_1.plan.md)).

## Try the UI in Cursor

1. Open this repository as the workspace folder in **Cursor**.
2. Press **F5** (launch config in [../.vscode](../.vscode)) to open an **Extension Development Host**.
3. In the host window, open the **Planstack** icon in the **activity bar** (left).
4. Sidebar order (top → bottom): **Overview**, **Plans** (tree of `.planstack/plans/*.json`, e.g. [demo](../.planstack/plans/demo.json)), then **Chat**. Use the **Plans** view title **refresh** if needed.
5. **Chat → Create plan:** type what you want in the box, then **Create plan** (not Send). The extension runs `agent -p --trust` in the workspace, parses a single JSON plan from stdout, validates it, and writes **`.planstack/plans/<id>.json`** (pretty-printed). **Send** stays local-only. You need **`CURSOR_API_KEY`** in the environment that launches Cursor, or run **Command Palette → “Planstack: Set Cursor API key”** (stored in VS Code Secret Storage). The Cursor CLI must be on `PATH` (or set **`planstack.cursor.agentPath`**).
6. Expand the demo plan, **right‑click a phase → Planstack: Run phase** (or use the context action). Configure **`planstack.cursor.openComposerCommand`** (or legacy `hackupc.nativeHandoff.openComposerCommand`) for auto‑focus.

**Command Palette:** `Planstack: Set Cursor API key` · `HackUPC: Native handoff demo` (fixed clipboard spike).

### Cursor CLI and Extension Host `PATH`

`./scripts/cursor-agent-smoke.sh` uses your **terminal**’s environment. **Planstack → Create plan** runs `agent` from the **Extension Host**, which often **does not** inherit the same `PATH` as an interactive shell—especially if Cursor was opened from the Dock. **`~/.bashrc` is Bash-only**; on macOS with **zsh**, put `export PATH="$HOME/.local/bin:$PATH"` in **`~/.zshrc`** and/or **`~/.zprofile`**, then **fully quit and reopen Cursor**.

The extension also **prepends `~/.local/bin` to the child `PATH`** when that directory exists, and if **`planstack.cursor.agentPath`** is the default `agent`, it will run **`~/.local/bin/agent`** when that file exists—so a typical Cursor CLI install under `~/.local/bin` works even when GUI Cursor’s `PATH` is minimal.

If the binary lives somewhere else, set **`planstack.cursor.agentPath`** to the **absolute path** from `which agent` in a shell where the CLI works.

## Source layout

Matches [extension_and_repo_structure.plan.md](../docs/extension_and_repo_structure.plan.md):

| Path | Role |
|------|------|
| `src/extension.ts` | Activation, tree view, commands |
| `src/plan/*` | Types, validation, loader, CLI plan creation (`agentCliRunner`, `createPlanFromCli`, `writePlan`, …) |
| `src/ui/planTreeProvider.ts` | Sidebar tree (plans → phases) |
| `src/dispatch/router.ts` | `planstack.cursor.handoff` routing |
| `src/dispatch/cursorNativeHandoff.ts` | Clipboard + `executeCommand` |
| `src/dispatch/cursorSdk.ts`, `cursorCli.ts`, `claudeCode.ts` | Stubs for non‑native modes |
| `src/git/resolver.ts` | `effectiveWorkBranch` + best‑effort `vscode.git` snapshot |

## Build

```bash
cd extension
npm install
npm run compile
```

Use `npm run watch` during development.
