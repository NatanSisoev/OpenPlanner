# PlanStack

A Cursor-first VS Code extension that turns ephemeral agent plans into tracked, **phased**, dependency-aware work units. PlanStack adds a thin orchestration layer on top of native agent workflows: plans are first-class JSON files on disk, the sidebar surfaces them as a tree, and **Run phase** dispatches a focused prompt to the configured executor.

The product boundary is firm: PlanStack owns **structured intent → start of execution**. Diffs, accept/reject, and code review stay in native surfaces (Composer, Agent, Claude Code).

---

## Installation

### From .vsix (recommended)

1. Download the latest `.vsix` from the [Releases](../../releases) page.
2. In VS Code or Cursor: open the Command Palette → **Extensions: Install from VSIX…** and select the file.
3. Or install from the terminal:
   ```bash
   code --install-extension planstack-*.vsix
   ```

### From source

```bash
cd extension
npm install
npm run compile
npm run package        # produces hackupc-planstack-spike-0.0.1.vsix
code --install-extension hackupc-planstack-spike-0.0.1.vsix
```

---

## Prerequisites

<<<<<<< HEAD
Each `.planstack/plans/*.json` file is a single plan. Every level (plan / phase / task) carries a state from the same enum: `pending`, `in_progress`, `completed`, `failed`, `cancelled`. Phases may declare `dependsOn` to reference `phase-id` in the same plan or `plan-id/phase-id` in another plan.

Tasks also carry `dependsOn`, a string array of task dependencies. Use `[]` when there are no blockers. Supported task refs are `task-id` for a unique task in the same plan, `phase-id/task-id` for a task in another phase of the same plan, and `plan-id/phase-id/task-id` for a cross-plan dependency. The validator rejects malformed same-plan task refs, unknown same-plan refs, self-references, duplicate phase ids, and duplicate task ids inside one phase. The full shape lives in [`extension/src/plan/types.ts`](extension/src/plan/types.ts), the parser in [`extension/src/plan/validate.ts`](extension/src/plan/validate.ts).
=======
PlanStack in `cli` mode (the default) requires the **Cursor headless agent CLI**:

- Install the Cursor CLI and confirm `agent --version` works in a terminal.
- Set your API key: **Command Palette → Planstack: Set Cursor API key** (stored in VS Code Secret Storage). Alternatively, export `CURSOR_API_KEY` in the environment that launches Cursor.
- If the binary is not on `PATH`, set `planstack.cursor.agentPath` to the absolute path.
- **Windows users:** if your agent CLI is inside WSL, enable `planstack.cursor.useWsl`.

---

## UI overview

Open the **Planstack** icon in the activity bar. The sidebar has three panels (top → bottom):

| Panel | Purpose |
|---|---|
| **Overview** | Plan list with run/merge actions, push/pull remote sync |
| **Plans** | Tree view: plans → phases → tasks, with inline run and state controls |
| **Chat** | Live agent output stream, system messages, and plan creation via the agent CLI |

---

## Core workflow

### 1. Create a plan

**Chat panel → type a description → Create plan.**

The extension runs `agent -p --trust` in the workspace (read-only), parses the JSON plan from stdout, validates it, and writes `.planstack/plans/<id>.json`. The Plans tree refreshes automatically.

You can also create plans, phases, and tasks manually via the Command Palette (`Planstack: Add Plan`, `Planstack: Add Phase`, `Planstack: Add Task`) or directly in the Overview panel.

### 2. Run a phase

**Plans tree → right-click a phase → Planstack: Run phase**, or use the inline ▶ button, or click **Run** in the Overview panel.

Before execution you choose:
- **Prepare/switch branch, then run** — creates `git.planBranch` from `git.baseBranch` (if missing) and checks it out, then dispatches.
- **Run on current branch** — skips branch setup and runs immediately.

The extension dispatches the phase prompt to the configured executor (default: `agent -p --trust --force`). On completion the phase and its tasks are automatically marked `completed`, `failed`, or `cancelled` in the plan JSON.

### 3. Run all phases sequentially

**Overview → Run plan** — asks for the branch decision once, then runs each non-terminal phase in sequence. If a phase fails the auto-run stops.

### 4. Run a single task

**Overview → ▶ on a task** — runs `agent --force` with just that task's prompt. Marks the task `completed` or `failed` on exit.

### 5. Re-sync a plan

**Plans tree title bar → ⟳**, or **Command Palette → Planstack: Re-sync plan to current codebase.**

Sends the existing plan + current workspace state to the agent and regenerates the plan JSON, resetting any stale `in_progress` phases/tasks to `pending`.

### 6. Merge a plan

**Overview → Merge**, or **Command Palette → Planstack: Merge completed plan branch into base branch.**

Merges `git.planBranch` into `git.baseBranch` with `--no-ff` using the built-in Git extension.

---

## Plan file format

Plans live in `.planstack/plans/*.json`. The schema is defined in [`extension/src/plan/types.ts`](extension/src/plan/types.ts).

```jsonc
{
  "id": "plan-launch-mvp",
  "title": "Launch onboarding MVP",
  "state": "pending",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "git": {
    "baseBranch": "main",
    "planBranch": "planstack/plan-launch-mvp"
  },
  "phases": [
    {
      "id": "phase-api",
      "title": "API implementation",
      "state": "pending",
      "description": "Build the REST endpoints",
      "dependsOn": [],
      "tasks": [
        {
          "id": "task-auth-endpoint",
          "desc": "Build login endpoint",
          "state": "pending",
          "commit": true,
          "prompt": "Implement POST /auth/login using JWT..."
        }
      ]
    }
  ]
}
```

State values: `pending` · `in_progress` · `completed` · `failed` · `cancelled`. Phase and plan states are derived from their children — they cannot be set directly.

Phases may declare `dependsOn: string[]` referencing other phase IDs. The validator enforces no duplicate IDs, no self-references, and no references to unknown IDs.

---
>>>>>>> 785c909d1a40e511663f971abaad66508e449544

## Dispatch modes

Controlled by `planstack.cursor.executionMode`:

| Mode | Behaviour |
|---|---|
| `cli` *(default)* | Runs `agent -p --trust --force` headless. Streams stdout/stderr to Output → Planstack and the Chat live stream. Single concurrent run; auto-updates plan JSON on exit. |
| `native-first` | Copies the prompt to the clipboard and optionally focuses Cursor Composer via `planstack.cursor.openComposerCommand`. |
| `sdk-local` / `sdk-cloud` | `@cursor/february` headless. Stub-level. |

---

## Remote sync

The Overview panel's **Push** and **Pull** buttons sync plan JSON to/from a remote HTTP API.

Set `planstack.cursor.syncApiBaseUrl` (e.g. `http://localhost:8787`) or export `PLANSTACK_SYNC_API_BASE_URL`. Push uploads all local plans; Pull fetches the remote index and downloads each plan, writing/overwriting the local files.

---

## Settings reference

All settings live under `planstack.cursor.*`. Open **Settings → search "Planstack"** to configure.

| Setting | Default | Description |
|---|---|---|
| `executionMode` | `cli` | Dispatcher for Run phase: `cli`, `native-first`, `sdk-local`, `sdk-cloud`, or empty (legacy fallback). |
| `planningMode` | `cli` | How Chat → Create plan generates JSON. Currently only `cli`. |
| `agentPath` | `agent` | Path to the Cursor headless agent binary. Set to an absolute path if not on `PATH`. |
| `agentTimeoutMs` | `180000` | Max ms to wait for a single agent run before killing it. |
| `agentMaxStdoutChars` | `2000000` | Safety cap on stdout characters captured from the agent. |
| `agentChatLiveStream` | `true` | Show a live scrollable agent output block in the Chat panel during runs. |
| `cliStreamAgentOutput` | `true` | Stream agent stdout/stderr to Output → Planstack during runs. |
| `cliStreamProgressThrottleMs` | `2000` | Minimum ms between Run phase notification progress updates. |
| `cliStreamChatThrottleMs` | `25000` | Minimum ms between Chat system lines when live stream is off. |
| `showGitSummaryAfterCliRun` | `true` | After a successful CLI run, append `git diff --stat` vs HEAD to Output and Chat. |
| `cliRunGitSnapshotIntervalMs` | `30000` | Interval (ms) to post git status deltas to Chat during a run. `0` disables. |
| `cliRunAgentDigestIntervalMs` | `15000` | Interval (ms) to post a short agent output tail to Chat during a run. `0` disables. |
| `chatMentionsMaxFiles` | `6` | Max `@file` mentions resolved per Chat message. |
| `chatMentionsMaxFileBytes` | `65536` | Max bytes for a single `@file` mention. |
| `chatMentionsMaxTotalChars` | `120000` | Max combined characters injected from all `@file` mentions per message. |
| `syncApiBaseUrl` | `""` | Base URL for the remote sync API (Overview Push/Pull). |
| `openComposerCommand` | `""` | VS Code command ID to focus Cursor Composer after clipboard handoff (`native-first` mode). |
| `useWsl` | `false` | **Windows only.** Spawn the agent inside WSL instead of native Windows. |
| `wslDistro` | `Ubuntu` | WSL distribution name to use when `useWsl` is enabled. |

---

## Command palette

| Command | Description |
|---|---|
| `Planstack: Add Plan` | Create a new plan interactively |
| `Planstack: Add Phase` | Add a phase to an existing plan |
| `Planstack: Add Task` | Add a task to an existing phase |
| `Planstack: Refresh plans` | Reload plan JSON from disk |
| `Planstack: Re-sync plan to current codebase` | Regenerate a plan against the current workspace |
| `Planstack: Run phase (execution)` | Run the selected phase |
| `Planstack: Merge completed plan branch into base branch` | Merge `planBranch` → `baseBranch` with `--no-ff` |
| `Planstack: Set Cursor API key` | Store `CURSOR_API_KEY` in VS Code Secret Storage |
| `Planstack: Debug Cursor CLI connection` | Verify the agent path, API key, and exit code |
| `Planstack: Stop agent CLI processes` | Send SIGTERM to all running agent processes |

---

## Development

```bash
cd extension
npm install
npm run compile      # one-shot build
npm run watch        # rebuild on save
```

Press **F5** from the repo root to launch an Extension Development Host with the extension loaded. The Plans tree is populated from `.planstack/plans/*.json` in the open workspace and refreshes automatically on file changes.

To package a `.vsix` for distribution:

```bash
npm run package      # → hackupc-planstack-spike-0.0.1.vsix
```

Type-check without emitting:

```bash
npx tsc -p . --noEmit
```

### Local settings (not committed)

Copy `.vscode/settings.example.json` to `.vscode/settings.json` and fill in your values. This file is gitignored.

---

## Repo layout

```
HackUPC/
  README.md                         # this file
  CLAUDE.md                         # orientation for AI agents
  LICENSE                           # MIT
  .planstack/plans/                 # live plan JSON loaded by the extension
  .vscode/                          # F5 launch config + compile task
  extension/
    package.json                    # manifest: views, commands, configuration
    tsconfig.json
    .vscodeignore                   # packaging exclusions
    src/
      extension.ts                  # activation, command registration
      log.ts                        # shared Output channel
      plan/                         # types, validate, loader, watcher, prompt builder, CLI runner, remote sync
      ui/                           # tree provider, sidebar webview, chat webview, stream bridges
      dispatch/                     # router + cli / native / sdk / claude dispatchers
      git/                          # branch resolver, work-branch setup, post-run diff summary, merge
      debug/                        # trace utilities
    media/                          # activity-bar icon, webview JS + CSS
    out/                            # tsc output (gitignored)
```
