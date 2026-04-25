# PlanStack

A Cursor-first VS Code extension that turns ephemeral agent plans into tracked, **phased**, dependency-aware work units. PlanStack adds a thin orchestration layer on top of native agent workflows: plans are first-class JSON objects with phases and tasks, the sidebar surfaces them as a tree, and **Run phase** hands a focused prompt off to Cursor Composer / Agent (or Claude Code in the integrated terminal) so the *editing* experience stays exactly where developers already expect it.

Built at HackUPC by a team of four.

## The problem

Agentic coding plans live in chat threads, scratch files, or scrollback — there is no durable view of what is planned, running, or done. Plans are usually executed all-or-nothing: there is no first-class notion of phases, so you cannot say "run phase 2 only, defer phase 3, mark phase 4 blocked" without rewriting the prompt by hand. Dependencies between plans are implicit and lost. See [`docs/base_idea.md`](docs/base_idea.md) for the full motivation.

## What PlanStack does

Plans are stored on disk as JSON under `.planstack/plans/<id>.json` (with shippable examples in [`seed/`](seed/)). Each plan has phases, each phase has tasks, every level carries a state (`pending` / `in_progress` / `completed` / `failed` / `cancelled`) and optional Git metadata (`baseBranch`, `planBranch`, per-phase `phaseBranch`). The on-disk shape is documented in [`extension/src/plan/types.ts`](extension/src/plan/types.ts).

The extension activates a **Planstack** activity-bar container with three views — Overview, Plans (tree), Chat — and exposes:

- **Run phase (native handoff, default)** — builds a prompt from the plan title, the phase description, the listed tasks, and the resolved Git context (current head, `effectiveWorkBranch(phase)`, base branch), copies it to the clipboard, and optionally runs a configured `executeCommand` to focus Cursor Composer or Agent. From there the user is in the **native** edit loop. See [`extension/src/dispatch/cursorNativeHandoff.ts`](extension/src/dispatch/cursorNativeHandoff.ts).
- **Chat → Create plan** — invokes `agent -p --trust` in the workspace, parses a single JSON plan from stdout, validates it, and writes a pretty-printed `.planstack/plans/<id>.json`. Requires `CURSOR_API_KEY` in the environment that launched Cursor, or set it via `Planstack: Set Cursor API key` (stored in VS Code Secret Storage).
- **Optional non-native modes** — SDK-local, SDK-cloud, and CLI handoff routes are wired through [`extension/src/dispatch/router.ts`](extension/src/dispatch/router.ts) and selected via `planstack.cursor.handoff`. Claude Code dispatches into an integrated terminal so the user stays in their familiar tty flow.

The extension reads Git state through `vscode.git` when available (falling back to `git` via `child_process`) so the sidebar can show "which branch belongs to which plan/phase" and the handoff prompt aligns with the same VC story. Editing, diffs, and merges stay in Git tooling — PlanStack does not reinvent them.

## Repository layout

| Path | Role |
|------|------|
| [`extension/`](extension/) | The VS Code / Cursor extension package (TypeScript, builds to `out/`). See [`extension/README.md`](extension/README.md) for build and run details. |
| [`extension/src/extension.ts`](extension/src/extension.ts) | Activation, command registration, tree wiring |
| [`extension/src/plan/`](extension/src/plan/) | Plan types, schema validation, JSON loader, agent CLI runner, plan creation prompt |
| [`extension/src/ui/`](extension/src/ui/) | Sidebar tree provider and chat / overview webviews |
| [`extension/src/dispatch/`](extension/src/dispatch/) | Native Composer handoff plus optional SDK / CLI / Claude Code routes |
| [`extension/src/git/resolver.ts`](extension/src/git/resolver.ts) | `effectiveWorkBranch` resolution and best-effort Git snapshot |
| [`.planstack/plans/`](.planstack/plans/) | Live plan JSON for the workspace (loaded by the tree) |
| [`seed/`](seed/) | Example plans bundled with the repo for demos |
| [`designUI/`](designUI/) | UI design notes and TypeScript sketches for plan visualisation |
| [`docs/`](docs/) | Product writing — `base_idea.md`, the IDE execution plan, the Cursor agent CLI validation note, repo structure rationale |
| [`scripts/`](scripts/) | `cursor-agent-smoke.sh` — smoke test for the Cursor headless CLI |
| [`tools/cursor-sdk-smoke/`](tools/cursor-sdk-smoke/) | Standalone TypeScript smoke for the optional `@cursor/february` SDK path |
| [`talks/`](talks/) | Sponsor talk notes from the hackathon |

## Try it in Cursor

1. Open this repo as a workspace in **Cursor**.
2. Press **F5** ([launch config](.vscode/launch.json)) to start an Extension Development Host. The pre-launch task runs `tsc -p extension`.
3. In the host window, click the **Planstack** icon in the activity bar. You'll see Overview, Plans, and Chat.
4. The Plans tree loads `.planstack/plans/*.json` plus `seed/*.json` — try the bundled examples ([auth refactor](seed/plan-auth-refactor.json), [CI infra](seed/plan-ci-infra.json), [dashboard feature](seed/plan-dashboard-feature.json)).
5. Right-click any phase → **Planstack: Run phase**. The phase prompt is on your clipboard; configure `planstack.cursor.openComposerCommand` to auto-focus Composer.
6. To create a plan from natural language, switch to the Chat view, type the request, then click **Create plan**. Make sure `CURSOR_API_KEY` is set or stored via `Planstack: Set Cursor API key`, and that `agent` is on the Extension Host's `PATH`.

The full setup details — including Cursor CLI `PATH` caveats on macOS — live in [`extension/README.md`](extension/README.md).

## Build

```bash
cd extension
npm install
npm run compile      # or: npm run watch
```

## Status

Hackathon project — interfaces and command IDs are still moving. The product boundary is fixed: PlanStack does **plans, phases, status, and handoff**; native agent surfaces own the actual editing.

## License

[MIT](LICENSE).
