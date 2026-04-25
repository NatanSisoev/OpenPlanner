# CLAUDE.md

Orientation for Claude (and other agents) working in this repository.

## What this project is

PlanStack is a Cursor-first VS Code extension that adds a thin orchestration layer on top of native agent workflows. Plans live on disk as JSON; phases and tasks have explicit state; the sidebar surfaces them; **Run phase** dispatches a built prompt to the configured executor. The product boundary is firm: PlanStack owns **structured intent -> start of execution**; native surfaces own the actual editing. Don't propose features that re-implement diff UIs, accept/reject loops, or in-extension code review.

## Repo layout

```
HackUPC/
  README.md                       # human-facing entry point
  CLAUDE.md                       # this file
  LICENSE                         # MIT
  .planstack/plans/               # live plan JSON loaded by the extension
  .vscode/                        # F5 launch + compile task
  extension/                      # the VS Code / Cursor extension package
    package.json                  # manifest: views, commands, configuration
    tsconfig.json                 # ES2022, commonjs, src/ -> out/
    src/
      extension.ts                # activation, command + view registration
      log.ts                      # shared "Planstack" OutputChannel (used by loader, dispatchers)
      plan/                       # plan types, validate, loader, watcher, prompt builders, plansStore
      ui/                         # tree, sidebar + chat webviews, chatStatusBridge, agentChatStreamBridge
      dispatch/                   # router + handoff variants (cli / native / sdk / claude)
      git/                        # branch resolver, work-branch helper, post-run diff summary helper
    media/                        # activity-bar icon, webview JS/CSS
    out/                          # tsc output (gitignored)
```

The repo intentionally has no `docs/`, `seed/`, `scripts/`, `tools/`, or `talks/` directories — earlier drafts referenced these, but the working code now lives entirely under `extension/` plus the `.planstack/plans/` data folder.

## Plan data model

The on-disk shape is defined in [`extension/src/plan/types.ts`](extension/src/plan/types.ts) and validated in [`extension/src/plan/validate.ts`](extension/src/plan/validate.ts). Every level (plan / phase / task) carries a `WorkState` from the same enum: `pending`, `in_progress`, `completed`, `failed`, `cancelled`. Plans optionally carry Git metadata (`baseBranch`, `planBranch`).

Branch resolution is plan-level only — phases inherit it. See [`extension/src/git/resolver.ts`](extension/src/git/resolver.ts):

```
effectiveWorkBranch(plan) := plan.git?.planBranch ?? null
```

(Older drafts had a phase-level `git.phaseBranch` override; that field has been removed because nothing parsed it.)

Phases may declare `dependsOn: string[]` referencing other phase ids in the same plan. The validator enforces:
- no duplicate phase ids,
- no self-references,
- every dependency points to a known phase id.

A working seed plan ships at [`.planstack/plans/demo-onboarding.json`](.planstack/plans/demo-onboarding.json) — model new plans on it.

## Dispatch model

`Run phase` is routed by [`extension/src/dispatch/router.ts`](extension/src/dispatch/router.ts) per `planstack.cursor.executionMode`:

| Mode              | File                              | Notes                                                                                |
|-------------------|-----------------------------------|--------------------------------------------------------------------------------------|
| `cli` *(default)* | `dispatch/cursorCli.ts`           | Runs `agent -p --trust --force` headless. Live stdout/stderr to **Output → Planstack** (`cliStreamAgentOutput`) and, by default, a **live stream block** in Chat (`agentChatLiveStream` via `agentChatStreamBridge.ts`); throttled notification progress; throttled Chat bubbles when live stream is off; single concurrent run; optional **Git vs HEAD** summary (`worktreeChangeSummary.ts`). |
| `native-first`    | `dispatch/cursorNativeHandoff.ts` | Clipboard + optional `executeCommand` to focus Composer.                              |
| `sdk-local` / `sdk-cloud` | `dispatch/cursorSdk.ts`     | `@cursor/february` headless. Stub-level.                                              |
| (separate path)   | `dispatch/claudeCode.ts`          | Spawns `claude` in an integrated terminal. Not wired into the router.                 |

`cli` is the default because the headless agent can edit the workspace directly with `--force`. Don't change that priority without updating this doc.

## Build, run, validate

```bash
# Compile the extension
cd extension
npm install
npm run compile          # or `npm run watch`

# Run the extension in Cursor / VS Code
# From repo root, press F5 (uses .vscode/launch.json)

# Type-check without emitting
cd extension && npx tsc -p . --noEmit
```

There is no test suite or linter wired up — don't claim "tests pass" without checking. `npx tsc -p . --noEmit` is the build gate.

## Conventions for code changes

- **TypeScript strict, ES2022, commonjs.** Match the style in `extension/src/`.
- **Stay inside the product boundary.** New UI for orchestration (tree, badges, status, blockers) is fine. New UI for *editing* is not — that belongs to Composer / Agent / Claude Code.
- **Plan JSON is the source of truth.** Don't add second-class state somewhere else (e.g. `globalState` mirroring plan state). The loader watches `.planstack/plans/*.json` and refreshes the tree automatically — code that mutates plans should write back to disk via [`extension/src/plan/writePlan.ts`](extension/src/plan/writePlan.ts).
- **Aggregate state derives from children.** [`extension/src/plan/aggregate.ts`](extension/src/plan/aggregate.ts) owns the rollup logic: any `in_progress` -> `in_progress`, any `failed` -> `failed`, all `completed` -> `completed`, all `cancelled` -> `cancelled`, otherwise `pending`. Do not write a second copy.
- **Logging.** Use [`extension/src/log.ts`](extension/src/log.ts) (`getOutput`, `logLine`, `showOutput`) so all dispatchers share one "Planstack" output channel.
- **Command IDs**: existing IDs use the `hackupc.planstack.*` and `hackupc.nativeHandoff.*` prefixes. Add new ones under `hackupc.planstack.*` unless there's a reason not to. Settings live under `planstack.cursor.*` (with one legacy `hackupc.nativeHandoff.openComposerCommand` kept as a fallback — see [`extension/package.json`](extension/package.json)).
- **Activation events** in `extension/package.json` must match the views and commands you actually register in `extension.ts`. Mismatches cause silent activation failures.

## Cursor CLI `PATH` gotcha

The Extension Host (where `cli` mode runs `agent`) often does **not** inherit the shell `PATH`, especially when Cursor was launched from the macOS Dock. The extension prepends `~/.local/bin` to the child `PATH` when present, and falls back to `~/.local/bin/agent` when `planstack.cursor.agentPath` is the default `agent`. If the binary lives elsewhere, set `planstack.cursor.agentPath` to the absolute path from `which agent`. Don't recommend `~/.bashrc` edits to zsh users — write to `~/.zshrc` and/or `~/.zprofile` and fully restart Cursor.

## What not to do

- Don't introduce a custom diff viewer, file edit stream, or accept/reject UI inside the extension.
- Don't move docs out of the repo root or move the extension out of `extension/`.
- Don't assume JetBrains support — it's explicitly out of scope.
- Don't run `agent -p` from automated checks without `--trust` and an explicit `CURSOR_API_KEY`.

## Hackathon context

Group of four, hackathon timeline. Interfaces, command IDs, and webview internals are still moving. Prefer minimal, reversible changes; if the change is large, gate it behind a setting or feature flag rather than rewriting cross-cutting code paths in one go.
