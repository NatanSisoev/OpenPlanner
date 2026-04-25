# Planstack: phase run status sync (execution UI)

This document describes how **plan / phase / task** lifecycle states stay consistent with **CLI phase execution** after the changes in the HackUPC Planstack extension.

## Storage model

- All states are persisted in **`.planstack/plans/*.json`** on the `Plan`, each `Phase`, and each `Task` (`WorkState`: `pending` | `in_progress` | `completed` | `failed` | `cancelled`). Phases persist `dependsOn` phase refs (`phase-id` or `plan-id/phase-id`). Tasks also persist `dependsOn` task refs (`task-id`, `phase-id/task-id`, or `plan-id/phase-id/task-id`).
- The extension writes the file via **`savePlanPreservingFile`** and reloads via **`loadPlansFromWorkspace`** + file watcher **`watchPlans`**.

## When status updates (CLI execution mode only)

`planstack.cursor.executionMode` must be **`cli`** (default). The hook **`onCliRunFinished`** is passed from [`extension.ts`](../extension/src/extension.ts) through [`dispatch/router.ts`](../extension/src/dispatch/router.ts) into [`dispatch/cursorCli.ts`](../extension/src/dispatch/cursorCli.ts) and invoked when the headless agent run **terminates** or **cannot start**.

| Callback kind | When fired | Effect on disk (after reloading plan from workspace) |
|---------------|------------|--------------------------------------------------------|
| **`success`** | Process exits with code **0** | Target **phase** → `completed`. Every **task** in that phase that is not already `cancelled` or `failed` → `completed`. Then **`recomputeAggregates`** and save. |
| **`error`** | Non-zero exit, spawn/runtime error, **no workspace**, **no API key** | Phase → `failed`. Tasks in **`in_progress`** → `failed`. Recompute aggregates, save. |
| **`stopped`** | User stop / process killed (message contains `stopped`) | Phase → `cancelled`. Tasks in **`in_progress`** → `cancelled`. Recompute aggregates, save. |

**`AgentRunBusyError`** (another run still active): **no** callback — nothing was started for this invocation.

## Entry points

1. **Overview sidebar** – **Run** on a phase: the webview already sets **`in_progress`** via `updatePhase` before `runPhase`. The callback still applies **success / error / stopped** so a failed run does not leave the phase stuck in **`in_progress`**.
2. **Plans tree** – **Run phase** command: the extension sets **`in_progress`** on disk **before** dispatch (parity with sidebar), then applies the same callback rules.

Before dispatch, `Run phase` also checks task-level dependencies for every task in the phase. Incomplete dependencies outside the current phase block the run; dependencies inside the phase are treated as ordering hints for the phase prompt.

## Native-first and SDK

- **`native-first`** and **`sdk-*`** paths **do not** receive `onCliRunFinished` (no deterministic process exit in the extension). Plan JSON is **not** auto-updated by this mechanism; the user (or agent editing the repo) must update states manually.
- **`sdk-local` / `sdk-cloud`** remain stubs in `cursorSdk.ts`.

## Run task button (Overview)

The per-task **Run** control checks the task's `dependsOn` refs first. If every dependency resolves to a completed task, it marks the task **`in_progress`**, runs the task prompt through the agent, then marks it **`completed`**, **`failed`**, or **`cancelled`** from the process outcome.

## Implementation map

| Piece | File |
|-------|------|
| Callback type `CliPhaseRunFinishedKind` | `extension/src/dispatch/cursorCli.ts` |
| Optional `onCliRunFinished` on dispatch | `extension/src/dispatch/router.ts` (`DispatchPhaseOptions`) |
| Invoke callback on outcomes + pre-spawn skips | `extension/src/dispatch/cursorCli.ts` |
| Load JSON, mutate, `recomputeAggregates`, save, refresh | `extension/src/extension.ts` (`phaseRunHooks.applyOutcome`) |

## Mid-run progress in Chat (CLI)

While **Run phase (CLI)** is active, optional timers in [`cursorCli.ts`](../extension/src/dispatch/cursorCli.ts) post **system lines** to Planstack Chat (independent of the live stream block):

| Setting | Default | `0` |
|---------|---------|-----|
| `planstack.cursor.cliRunGitSnapshotIntervalMs` | 30000 | Disables **`[git]`** mid-run lines; only posts when the snapshot **changes**. First post is a short **baseline** (status + head of `git diff --stat` vs `HEAD`); later posts are **deltas** (new/removed `--stat` lines and status-line changes), not a full repeat of the snapshot. |
| `planstack.cursor.cliRunAgentDigestIntervalMs` | 15000 | Disables **`[agent]`** tail digests of buffered stdout/stderr; only posts when the tail fingerprint **changes**. |

The **45s “still running”** heartbeat is cleared as soon as the CLI process returns, so it does not continue after completion while post-run dialogs or git summary run.

## Validation checklist

- Sidebar **Run phase**: CLI success → phase and eligible tasks **completed**; UI matches JSON.
- CLI **non-zero exit** → phase **failed**, in-progress tasks **failed**.
- **Stop agents** / killed run → **cancelled** semantics where `stopped` is detected.
- **No API key** / **no folder** after optimistic run → **error** path clears stuck **`in_progress`**.
- **`npm run compile`** in `extension/`.
