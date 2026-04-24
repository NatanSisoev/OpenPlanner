# Cursor agent CLI and SDK validation

This matches the optional **headless** path in [ide_plan_execution_1.plan.md](ide_plan_execution_1.plan.md) (SDK / CLI), not the in-IDE **native handoff** (clipboard + `executeCommand`). For the latter, use the spike under [`extension/`](../extension/) (F5 from repo root; see [extension/README.md](../extension/README.md)).

## Prerequisites

1. **Cursor CLI** — `agent` must be on your `PATH`. Install: [Cursor CLI installation](https://cursor.com/docs/cli/installation.md).
2. **`CURSOR_API_KEY`** — Required for non-interactive runs. Create a key from the [Cloud Agents dashboard](https://cursor.com/dashboard/cloud-agents) or team service accounts. **Do not commit keys**; use shell exports or CI secret stores only. A repo-root `.env` with `CURSOR_API_KEY=…` is gitignored and is sourced automatically by `./scripts/cursor-agent-smoke.sh` when present.

## Shell smoke test (CLI)

From the repository root:

```bash
export CURSOR_API_KEY="…"   # or put it in .env (gitignored)
./scripts/cursor-agent-smoke.sh
```

The script passes **`--trust`** to `agent` so headless runs are not blocked by the “Workspace Trust Required” prompt. That only means you have decided this checkout is trusted for the agent to read (and potentially modify if you add `--force` elsewhere); it is not a substitute for reviewing untrusted repos before using stronger flags like `--yolo`.

### Optional: agent creates a demo file on disk

To run the read-only line above **and** a second step where the agent **writes** `demo/cursor-agent-smoke-demo.md` (gitignored):

```bash
./scripts/cursor-agent-smoke.sh --write-demo
```

That second call uses **`--force`** so print mode can modify files ([headless CLI](https://cursor.com/docs/cli/headless)). Use only on branches you trust; do not enable blindly in CI unless you intend to mutate the workspace.

The script exits with:

| Code | Meaning |
|------|---------|
| `0` | `agent -p` completed successfully. |
| `2` | `agent` not found on `PATH`. |
| `3` | `CURSOR_API_KEY` unset or empty. |

### One-liner (equivalent)

```bash
agent -p --trust "In one sentence, what is this repository about? Base your answer only on README or docs visible in the workspace."
```

Without `--force`, the agent should **not** apply file changes in print mode ([headless CLI](https://cursor.com/docs/cli/headless)).

### Failure modes observed in automation

- **Workspace trust:** If you call `agent -p` without `--trust` (or related flags), the CLI may stop with “Workspace Trust Required” in non-interactive contexts. The smoke script passes `--trust` for the repo root it `cd`s into.
- **Missing CLI:** Install step never ran, or shell does not load the same `PATH` as your interactive terminal (common in CI); fix `PATH` or use the full path to `agent` if documented by your install method. `./scripts/cursor-agent-smoke.sh` exits `2` when `agent` is not found.
- **Missing or invalid key:** `CURSOR_API_KEY` unset → exit `3`; invalid key → non-zero exit from `agent` with an auth error from Cursor.
- **Network:** Headless runs need reachability to Cursor services; CI must allow outbound HTTPS.

For the TypeScript SDK smoke (`npm run smoke` under `tools/cursor-sdk-smoke`), invalid or expired keys exit `1` with `Agent.prompt failed: …`. The smoke script also listens for `unhandledRejection`, because some SDK init failures surface that way instead of rejecting the `Agent.prompt` promise.

## CI

Add `CURSOR_API_KEY` as a **secret** variable. Ensure the job installs the Cursor CLI or uses an image where `agent` exists, then run `./scripts/cursor-agent-smoke.sh` from the checkout root.

## TypeScript SDK smoke (`tools/cursor-sdk-smoke`)

Optional second check using `@cursor/february` ([TypeScript SDK](https://cursor.com/docs/api/sdk/typescript)):

```bash
cd tools/cursor-sdk-smoke
npm install
export CURSOR_API_KEY="…"
npm run smoke
```

See [tools/cursor-sdk-smoke/README.md](../tools/cursor-sdk-smoke/README.md).
