# PlanStack

A Cursor-first VS Code extension that turns ephemeral agent plans into tracked, **phased**, dependency-aware work units. PlanStack adds a thin orchestration layer on top of native agent workflows: plans are first-class JSON files on disk, the sidebar surfaces them as a tree, and **Run phase** hands a focused prompt off to the configured executor (Cursor agent CLI, Cursor SDK, or native Composer).

The product boundary is firm: PlanStack owns **structured intent -> start of execution**. The actual editing — diffs, accept/reject, code review — stays in the native surfaces (Composer, Agent, Claude Code).

## Quick start

```bash
cd extension
npm install
npm run compile          # or `npm run watch`
```

Then from the repo root, press **F5** in VS Code / Cursor to launch the Extension Development Host. The PlanStack activity-bar icon shows the Plans tree, populated from `.planstack/plans/*.json`. A demo plan ships at [`.planstack/plans/demo-onboarding.json`](.planstack/plans/demo-onboarding.json) — edit it, save, and the tree refreshes automatically (file watcher).

## Plan schema

Each `.planstack/plans/*.json` file is a single plan. Every level (plan / phase / task) carries a state from the same enum: `pending`, `in_progress`, `completed`, `failed`, `cancelled`. Phases may declare `dependsOn` to reference other phase ids in the same plan; the validator rejects unknown ids, self-references, and duplicate phase ids. The full shape lives in [`extension/src/plan/types.ts`](extension/src/plan/types.ts), the parser in [`extension/src/plan/validate.ts`](extension/src/plan/validate.ts).

## Dispatch modes

`Run phase` is routed by [`extension/src/dispatch/router.ts`](extension/src/dispatch/router.ts) based on the `planstack.cursor.executionMode` setting (legacy alias: `planstack.cursor.handoff`).

| Mode             | File                          | Behaviour                                                                |
|------------------|-------------------------------|--------------------------------------------------------------------------|
| `cli` *(default)* | `dispatch/cursorCli.ts`       | Runs `agent -p --trust --force` headless and edits the workspace.        |
| `native-first`   | `dispatch/cursorNativeHandoff.ts` | Copies the prompt to the clipboard and (optionally) focuses Composer. |
| `sdk-local`      | `dispatch/cursorSdk.ts`       | `@cursor/february` local headless. Stub-level.                           |
| `sdk-cloud`      | `dispatch/cursorSdk.ts`       | `@cursor/february` cloud. Stub-level.                                    |

A separate `dispatch/claudeCode.ts` path can spawn `claude` in an integrated terminal — not wired into the router by default.

## Settings

The extension exposes:

- `planstack.cursor.executionMode` — which dispatcher to use (default: `cli`).
- `planstack.cursor.agentPath` — full path to the Cursor `agent` binary; defaults to bare `agent` and falls back to `~/.local/bin/agent` when present.
- `planstack.cursor.agentTimeoutMs` — kill the headless agent after this many ms.
- `planstack.cursor.agentMaxStdoutChars` — backpressure cap on `stdout` chars.

The `CURSOR_API_KEY` is stored in VS Code's secret storage (`Planstack: Set Cursor API key`) and falls back to the environment variable when absent.

## Repo layout

```
HackUPC/
  README.md                       # this file
  CLAUDE.md                       # orientation for AI agents working here
  LICENSE                         # MIT
  .planstack/plans/               # live plan JSON loaded by the extension
  .vscode/                        # F5 launch + compile task
  extension/                      # the VS Code / Cursor extension package
    package.json                  # manifest: views, commands, configuration
    tsconfig.json                 # ES2022, commonjs, src/ -> out/
    src/
      extension.ts                # activation, command + view registration
      log.ts                      # shared "Planstack" OutputChannel
      plan/                       # plan types, validate, loader, watcher, helpers
      ui/                         # tree provider, chat webview, sidebar webview
      dispatch/                   # router + handoff variants (cli / native / sdk / claude)
      git/                        # branch resolver + work-branch helper
    media/                        # activity-bar icon, webview JS/CSS
```

## What this is not

PlanStack does not implement a custom diff viewer, accept/reject loop, or in-extension code review. Those live in Composer / Agent / Claude Code. The extension only owns structured intent and the dispatch boundary.
