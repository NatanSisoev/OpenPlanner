# HackUPC Planstack (VS Code / Cursor extension)

Orchestration UI for phased plans (JSON under `.planstack/plans/` and optional `seed/`, schema aligned with [`seed/`](../seed/)) with separate **planning** vs **execution** settings ([product plan](../docs/ide_plan_execution_1.plan.md)).

### Planning vs execution (two settings)

| Context | User action | Setting | Default / notes |
|--------|-------------|---------|-----------------|
| **Planning** | **Chat → Create plan** | `planstack.cursor.planningMode` | `cli` — headless CLI (profile below), JSON plan on stdout |
| **Execution** | **Plans → Run phase** | `planstack.cursor.executionMode` | **Default `cli`:** headless CLI with edits (Cursor: `--force`; Junie: task run). **`native-first`:** clipboard + optional `openComposerCommand` + handoff file (see below). Empty → legacy `planstack.cursor.handoff` (default `cli`). |

**Executor profile:** `planstack.executor.activeProfile` — **`cursor-agent-cli`** (Cursor `agent`) or **`junie-cli`** ([Junie CLI](https://junie.jetbrains.com/docs/junie-cli.html)). Mirrored by the **Executor** dropdown in Planstack Chat. Legacy: non-empty `planstack.cursor.activeProfile`.

Shared timeouts/output caps: `planstack.cursor.agentTimeoutMs`, `agentMaxStdoutChars`. Paths: `planstack.cursor.agentPath` (Cursor), `planstack.executor.juniePath` (Junie). Keys: **Planstack: Set Cursor API key** / **Planstack: Set Junie API token** (or `CURSOR_API_KEY` / `JUNIE_API_KEY` in the Extension Host env).

**Junie + IntelliJ:** same-repo workflow and `.planstack/handoff.md` — see [docs/planstack-junie.md](../docs/planstack-junie.md). Optional Tier C (full Planstack UI inside IntelliJ) would be a separate JetBrains plugin, not this package.

**Concurrency:** Only **one** headless CLI run may be active at a time (Create plan, Run phase, or **Debug CLI**). Starting another while one is running fails fast; wait, or run **`Planstack: Stop agent CLI processes`** / **Chat → Stop agents** (SIGTERM), then retry.

**Phase status after Run phase (CLI only):** When `executionMode` is **`cli`**, the extension persists outcomes to **`.planstack/plans/*.json`** so Overview / Plans stay accurate: **exit 0** marks the phase (and non-terminal tasks under it) **completed**; **failure** marks the phase **failed** and any **in_progress** tasks **failed**; **stopped** runs mark the phase **cancelled** and in-progress tasks **cancelled**. If the CLI cannot start (no workspace folder, no API key), the same **failure** path runs so an optimistic **`in_progress`** is not left stuck. **`native-first`** / **SDK** modes do not auto-update plan JSON (no process exit in the extension). **Overview → Run task** (per-task ▶) only sets the task to **`in_progress`** in JSON; it does not start the agent (task-scoped runs are a future extension). Full spec: [`docs/planstack-phase-run-status-sync.md`](../docs/planstack-phase-run-status-sync.md).

**Visibility:** With **`planstack.cursor.cliStreamAgentOutput`** (default on), live stdout/stderr append to **Output → Planstack** during runs; Run phase also updates the **notification** progress text on a throttle (`cliStreamProgressThrottleMs`). With **`planstack.cursor.agentChatLiveStream`** (default on), the **Chat** panel opens a **single scrollable live block** as soon as the run starts (with a short “waiting / buffering” note), then appends stdout/stderr as the CLI emits them (stderr lines prefixed with `[stderr]`; many builds buffer for a long time before any bytes). The UI keeps at most ~400k characters per run, tail preserved. Turn **`agentChatLiveStream`** off to use only **throttled** Chat system bubbles (`cliStreamChatThrottleMs`). After a successful **Run phase (CLI)**, **`showGitSummaryAfterCliRun`** (default on) appends `git diff --stat HEAD` plus `git status -sb` to Output and posts a short Chat summary — this reflects **working tree vs `HEAD`** (includes any prior local changes).

**Mid-run Chat (CLI only):** **`cliRunGitSnapshotIntervalMs`** (default 30000, **0** = off) posts **`[git]`** lines when the **git snapshot vs HEAD** changes: the **first** tick is a short **baseline** (status line + first lines of `diff --stat`); later ticks show only **deltas** (lines that appeared or disappeared in `--stat`, plus status-line transitions), so unchanged output is not repeated. **`cliRunAgentDigestIntervalMs`** (default 15000, **0** = off) posts **`[agent]`** system lines with a short **stdout/stderr tail** when it changes (in addition to the live stream, if enabled). The **45s heartbeat** stops as soon as the CLI process finishes (not after post-run dialogs).

## Try the UI in Cursor

1. Open this repository as the workspace folder in **Cursor**.
2. Press **F5** (launch config in [../.vscode](../.vscode)) to open an **Extension Development Host**.
3. In the host window, open the **Planstack** icon in the **activity bar** (left).
4. Sidebar order (top → bottom): **Overview**, **Plans** (tree: plans → phases → tasks from `.planstack/plans/*.json` and `seed/*.json`, e.g. [demo](../.planstack/plans/demo.json)), then **Chat**. Use the **Plans** view title **refresh** if needed.
5. **Chat → Create plan:** type what you want, pick **Executor** (Cursor or Junie CLI), then **Create plan** (not Send). The extension runs the configured headless CLI, parses a single JSON plan from stdout, validates it, and writes **`.planstack/plans/<id>.json`**. **Send** runs the same executor with edits enabled. Store **Cursor** or **Junie** credentials via the Command Palette commands below. In **Chat**, `@` suggestions include **`.planstack/plans/*.json`** paths (and `plan:` / `phase:` / `task:`).
6. Expand the demo plan, **right‑click a phase → Planstack: Run phase** (default **CLI**; uses the active executor profile). For **Composer paste handoff** instead, set **`planstack.cursor.executionMode`** to **`native-first`** and optionally **`planstack.cursor.openComposerCommand`**.

### Git branch on first Run phase (per plan)

If the plan JSON includes **`git.planBranch`** (and optional **`git.baseBranch`**, default `main`), the **first** Run phase for that plan in this workspace uses the built-in **Git** extension to **create the branch from the base** (if missing) and **check it out**, then remembers success in **workspace state** (keyed by plan `id`). Later Run phases skip branch setup. Repos using **`master`** should set **`git.baseBranch`** accordingly.

If **`git.planBranch`** is missing, or there is **no Git repo** / **Git extension**, a **Chat** system line explains the skip; execution still runs (unless branch checkout **fails**, in which case Run phase aborts after an error toast).

**Command Palette:** `Planstack: Set Cursor API key` · `Planstack: Set Junie API token` · `Planstack: Debug Cursor CLI connection` · **`Planstack: Stop agent CLI processes`** · `HackUPC: Native handoff demo` (fixed clipboard spike).

### Quick CLI diagnostics

Run **`Planstack: Debug Cursor CLI connection`** to verify the Extension Host path for the **active executor** (`cursor-agent-cli` or `junie-cli`):

- **Chat → Create plan** and **Send**
- **Run phase** when `planstack.cursor.executionMode = cli`

The command logs resolved `agentPath`, API-key presence, PATH sample, exit code, and output tails in **Output -> Planstack**.

### Cursor CLI and Extension Host `PATH`

`./scripts/cursor-agent-smoke.sh` uses your **terminal**’s environment. **Planstack → Create plan** runs `agent` from the **Extension Host**, which often **does not** inherit the same `PATH` as an interactive shell—especially if Cursor was opened from the Dock. **`~/.bashrc` is Bash-only**; on macOS with **zsh**, put `export PATH="$HOME/.local/bin:$PATH"` in **`~/.zshrc`** and/or **`~/.zprofile`**, then **fully quit and reopen Cursor**.

The extension also **prepends `~/.local/bin` to the child `PATH`** when that directory exists, and if **`planstack.cursor.agentPath`** is the default `agent`, it will run **`~/.local/bin/agent`** when that file exists—so a typical Cursor CLI install under `~/.local/bin` works even when GUI Cursor’s `PATH` is minimal.

If the binary lives somewhere else, set **`planstack.cursor.agentPath`** to the **absolute path** from `which agent` in a shell where the CLI works.

On **Windows**, if diagnostics show **`agent.cmd`** / **`cursor.cmd`**, the extension spawns those through a shell (Node cannot run `.cmd` with `shell: false`). You can still point **`planstack.cursor.agentPath`** at **`agent.exe`** or **`cursor.exe`** if you prefer a direct executable.

## Source layout

Matches [extension_and_repo_structure.plan.md](../docs/extension_and_repo_structure.plan.md):

| Path | Role |
|------|------|
| `src/extension.ts` | Activation, commands, Overview webview wiring |
| `src/plan/*` | Types, validation, loader, CLI plan creation (`agentCliRunner`, `createPlanFromCli`, `writePlan`, …) |
| `src/ui/planstackSidebarWebview.ts` | Overview webview (plans → phases → tasks) |
| `src/dispatch/router.ts` | Phase execution dispatch (`getExecutionMode` / legacy handoff) |
| `src/plan/modes.ts` | `planningMode` + `executionMode` resolution |
| `src/ui/chatStatusBridge.ts` | Run phase CLI → Chat system lines when the Chat view is open |
| `src/ui/agentChatStreamBridge.ts` | Coalesced chunks → Chat webview live stream (`agentStreamStart` / `Append` / `End`) |
| `src/dispatch/cursorNativeHandoff.ts` | Clipboard + `executeCommand` |
| `src/dispatch/cursorCli.ts` | **`executionMode: cli`** — `agent -p --trust --force` for phase work |
| `src/dispatch/cursorSdk.ts`, `claudeCode.ts` | Stubs / optional paths |
| `src/git/resolver.ts` | `effectiveWorkBranch` + exported `getGitApi` / `vscode.git` typings |
| `src/git/ensurePlanWorkBranch.ts` | First Run phase per plan: create/checkout `git.planBranch` |
| `src/git/worktreeChangeSummary.ts` | Post–Run phase: `git diff --stat` / `status -sb` for Output + Chat |

## Build

```bash
cd extension
npm install
npm run compile
```

Use `npm run watch` during development.
