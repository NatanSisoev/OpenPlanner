# HackUPC Planstack (VS Code / Cursor extension)

Orchestration UI for phased plans (JSON under `.planstack/plans/` and optional `seed/`, schema aligned with [`seed/`](../seed/)) with separate **planning** vs **execution** settings ([product plan](../docs/ide_plan_execution_1.plan.md)).

### Planning vs execution (two settings)

| Context | User action | Setting | Default / notes |
|--------|-------------|---------|-----------------|
| **Planning** | **Chat → Create plan** | `planstack.cursor.planningMode` | `cli` — headless `agent -p --trust` (read-only), JSON plan on stdout |
| **Execution** | **Plans → Run phase** | `planstack.cursor.executionMode` | **Default `cli`:** headless `agent -p --trust --force` (may edit files). **`native-first`:** clipboard + optional `openComposerCommand`. Empty → legacy `planstack.cursor.handoff` (default `cli`). |

Shared: `planstack.cursor.agentPath`, `agentTimeoutMs`, `agentMaxStdoutChars`, and the stored Cursor API key (used for **Create plan** and for **`executionMode: cli`**).

## Try the UI in Cursor

1. Open this repository as the workspace folder in **Cursor**.
2. Press **F5** (launch config in [../.vscode](../.vscode)) to open an **Extension Development Host**.
3. In the host window, open the **Planstack** icon in the **activity bar** (left).
4. Sidebar order (top → bottom): **Overview**, **Plans** (tree: plans → phases → tasks from `.planstack/plans/*.json` and `seed/*.json`, e.g. [demo](../.planstack/plans/demo.json)), then **Chat**. Use the **Plans** view title **refresh** if needed.
5. **Chat → Create plan:** type what you want in the box, then **Create plan** (not Send). The extension runs `agent -p --trust` in the workspace, parses a single JSON plan from stdout, validates it, and writes **`.planstack/plans/<id>.json`** (pretty-printed). **Send** stays local-only. You need **`CURSOR_API_KEY`** in the environment that launches Cursor, or run **Command Palette → “Planstack: Set Cursor API key”** (stored in VS Code Secret Storage). The Cursor CLI must be on `PATH` (or set **`planstack.cursor.agentPath`**).
6. Expand the demo plan, **right‑click a phase → Planstack: Run phase** (default: **CLI** in the repo with **`--force`**; needs **`CURSOR_API_KEY`** + `agent` like Create plan). For **Composer paste handoff** instead, set **`planstack.cursor.executionMode`** to **`native-first`** and optionally **`planstack.cursor.openComposerCommand`**.

### Git branch on first Run phase (per plan)

If the plan JSON includes **`git.planBranch`** (and optional **`git.baseBranch`**, default `main`), the **first** Run phase for that plan in this workspace uses the built-in **Git** extension to **create the branch from the base** (if missing) and **check it out**, then remembers success in **workspace state** (keyed by plan `id`). Later Run phases skip branch setup. Repos using **`master`** should set **`git.baseBranch`** accordingly.

If **`git.planBranch`** is missing, or there is **no Git repo** / **Git extension**, a **Chat** system line explains the skip; execution still runs (unless branch checkout **fails**, in which case Run phase aborts after an error toast).

**Command Palette:** `Planstack: Set Cursor API key` · `Planstack: Debug Cursor CLI connection` · `HackUPC: Native handoff demo` (fixed clipboard spike).

### Quick CLI diagnostics

Run **`Planstack: Debug Cursor CLI connection`** to verify the full Extension Host -> `agent` path used by:

- **Chat -> Create plan** (`agent -p --trust`)
- **Run phase** when `planstack.cursor.executionMode = cli` (`agent -p --trust --force`)

The command logs resolved `agentPath`, API-key presence, PATH sample, exit code, and output tails in **Output -> Planstack**.

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
| `src/ui/planTreeProvider.ts` | Sidebar tree (plans → phases → tasks) |
| `src/dispatch/router.ts` | Phase execution dispatch (`getExecutionMode` / legacy handoff) |
| `src/plan/modes.ts` | `planningMode` + `executionMode` resolution |
| `src/ui/chatStatusBridge.ts` | Run phase CLI → Chat system lines when the Chat view is open |
| `src/dispatch/cursorNativeHandoff.ts` | Clipboard + `executeCommand` |
| `src/dispatch/cursorCli.ts` | **`executionMode: cli`** — `agent -p --trust --force` for phase work |
| `src/dispatch/cursorSdk.ts`, `claudeCode.ts` | Stubs / optional paths |
| `src/git/resolver.ts` | `effectiveWorkBranch` + exported `getGitApi` / `vscode.git` typings |
| `src/git/ensurePlanWorkBranch.ts` | First Run phase per plan: create/checkout `git.planBranch` |

## Build

```bash
cd extension
npm install
npm run compile
```

Use `npm run watch` during development.
