# CLAUDE.md

Orientation for Claude (and other agents) working in this repository.

## What this project is

PlanStack is a Cursor-first VS Code extension that adds a thin orchestration layer on top of native agent workflows. Plans live on disk as JSON; phases and tasks have explicit state; the sidebar surfaces them; **Run phase** copies a built prompt to the clipboard and (optionally) focuses Cursor Composer / Agent. The product boundary is firm: PlanStack owns **structured intent → start of execution**; native surfaces own the actual editing. Don't propose features that re-implement diff UIs, accept/reject loops, or in-extension code review.

Read these before doing non-trivial work:
- [`docs/base_idea.md`](docs/base_idea.md) — problem statement.
- [`docs/ide_plan_execution_1.plan.md`](docs/ide_plan_execution_1.plan.md) — the canonical product plan. Tracks scope, dispatch priorities, Git model, settings, repo layout, risks. **If a question is about intended behaviour, this file is the source of truth.**
- [`docs/extension_and_repo_structure.plan.md`](docs/extension_and_repo_structure.plan.md) — VS Code extension manifest requirements and the rationale for keeping the extension under `extension/` while docs live at the root.
- [`docs/cursor_agent_cli_validation.md`](docs/cursor_agent_cli_validation.md) — what the Cursor headless CLI (`agent -p`) does and how the smoke test exercises it.

## Repo layout

```
HackUPC/
  README.md                    # Project README (entry point for humans)
  CLAUDE.md                    # This file
  LICENSE                      # MIT
  .planstack/plans/            # Live plan JSON loaded by the extension tree
  .vscode/                     # F5 launch + compile task for the extension
  designUI/                    # UI design notes (plans-as-nodes, state-as-color)
  docs/                        # Product writing (see "Read these before…" above)
  extension/                   # The VS Code / Cursor extension package
    package.json               # Manifest: views, commands, configuration
    tsconfig.json              # ES2022, commonjs, src/ → out/
    src/
      extension.ts             # Activation, command + view registration
      plan/                    # Plan types, validate, loader, prompt builders, CLI plan creation
      ui/                      # Tree provider, chat webview, sidebar webview
      dispatch/                # router + native handoff + sdk / cli / claude stubs
      git/resolver.ts          # effectiveWorkBranch + git snapshot
    media/                     # Activity bar icon, webview JS
    out/                       # Compiled JS (tsc output, gitignored in extension/.gitignore)
    README.md                  # Build / run instructions for the extension
  scripts/cursor-agent-smoke.sh  # Cursor CLI smoke (read-only by default; --write-demo to write)
  seed/                        # Example plans (auth refactor, CI infra, dashboard feature)
  talks/                       # Sponsor talk notes (BendingSpoons, JetBrains)
  tools/cursor-sdk-smoke/      # Standalone TS smoke for @cursor/february SDK path
```

## Plan data model

The on-disk shape is defined in [`extension/src/plan/types.ts`](extension/src/plan/types.ts) and validated in [`extension/src/plan/validate.ts`](extension/src/plan/validate.ts). Every level (plan / phase / task) carries a state from the same enum: `pending`, `in_progress`, `completed`, `failed`, `cancelled`. Plans and phases optionally carry Git metadata. Branch resolution is normative:

```
effectiveWorkBranch(phase) := phase.git.phaseBranch ?? plan.git.planBranch ?? null
```

Do **not** introduce a single field name `git.branch` at two hierarchy levels — flattening creates ambiguity. See [`extension/src/git/resolver.ts`](extension/src/git/resolver.ts).

Examples to model new plans on: [`seed/plan-auth-refactor.json`](seed/plan-auth-refactor.json), [`seed/plan-ci-infra.json`](seed/plan-ci-infra.json), [`seed/plan-dashboard-feature.json`](seed/plan-dashboard-feature.json).

## Dispatch model

`Run phase` is routed by [`extension/src/dispatch/router.ts`](extension/src/dispatch/router.ts) based on the `planstack.cursor.handoff` setting:

| Mode | File | Notes |
|------|------|-------|
| `native-first` (default) | `dispatch/cursorNativeHandoff.ts` | Clipboard + optional `executeCommand` to focus Composer. **Default for interactive code phases.** |
| `sdk-local` / `sdk-cloud` | `dispatch/cursorSdk.ts` | `@cursor/february` — headless / cloud / CI. Stub-level. |
| `cli` | `dispatch/cursorCli.ts` | `agent -p` headless. Stub-level. |
| (separate path) | `dispatch/claudeCode.ts` | Spawns `claude` in an integrated terminal — stays in user's tty flow. |

Native-first is the default because streaming agent output into an OutputChannel diverges from the native edit loop. Don't change that priority without updating the product plan.

## Build, run, validate

```bash
# Compile the extension
cd extension
npm install
npm run compile          # or npm run watch

# Run the extension in Cursor / VS Code
# From repo root, press F5 (uses .vscode/launch.json)

# Smoke-test the Cursor headless CLI (requires CURSOR_API_KEY)
./scripts/cursor-agent-smoke.sh
./scripts/cursor-agent-smoke.sh --write-demo   # exercises --force
```

There is currently no test suite and no linter wired up — don't claim "tests pass" without checking. `npm run compile` is the closest thing to a build gate.

## Conventions for code changes

- **TypeScript strict, ES2022, commonjs.** Match the style in `extension/src/`.
- **Stay inside the product boundary.** New UI for orchestration (tree, badges, status, blockers) is fine. New UI for *editing* is not — that belongs to Composer / Agent / Claude Code.
- **Plan JSON is the source of truth.** Don't add second-class state somewhere else (e.g. extension globalState mirroring plan state).
- **Don't break the schema in `seed/`.** Those files are demos used during the hackathon. If you change the schema, migrate the seed files in the same change.
- **Command IDs**: existing IDs use the `hackupc.planstack.*` and `hackupc.nativeHandoff.*` prefixes. Add new ones under `hackupc.planstack.*` unless there's a reason not to. Settings live under `planstack.cursor.*` (with one legacy `hackupc.nativeHandoff.openComposerCommand` kept as a fallback — see [`package.json`](extension/package.json)).
- **Activation events** in `extension/package.json` must match the views and commands you actually register in `extension.ts`. Mismatches cause silent activation failures.

## Cursor CLI `PATH` gotcha

`scripts/cursor-agent-smoke.sh` uses your shell's environment. The Extension Host (where `Chat → Create plan` runs `agent`) often does **not** inherit that `PATH`, especially when Cursor was launched from the macOS Dock. The extension prepends `~/.local/bin` to the child `PATH` when present, and falls back to `~/.local/bin/agent` when `planstack.cursor.agentPath` is the default `agent`. If the binary lives elsewhere, set `planstack.cursor.agentPath` to the absolute path from `which agent`. Don't recommend `~/.bashrc` edits to zsh users — write to `~/.zshrc` and/or `~/.zprofile` and fully restart Cursor.

## What not to do

- Don't introduce a custom diff viewer, file edit stream, or accept/reject UI inside the extension.
- Don't move docs out of the repo root or move the extension out of `extension/`.
- Don't assume JetBrains support — it's explicitly out of scope.
- Don't run network calls or `agent -p` from automated checks without `--trust` and an explicit API key — see [`docs/cursor_agent_cli_validation.md`](docs/cursor_agent_cli_validation.md).

## Hackathon context

Group of four, hackathon timeline. Interfaces, command IDs, and webview internals are still moving. Prefer minimal, reversible changes; favour additions in `seed/` or `docs/` over schema churn when validating ideas.
