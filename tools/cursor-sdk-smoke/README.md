# Cursor SDK smoke test

Minimal [`@cursor/february`](https://cursor.com/docs/api/sdk/typescript) check: one `Agent.prompt` against the **HackUPC repo root** as `local.cwd`.

## Prerequisites

- Node 20+
- `CURSOR_API_KEY` in the environment (same as the CLI; do not commit it)

## Run

```bash
cd tools/cursor-sdk-smoke
npm install
export CURSOR_API_KEY="…"
npm run smoke
```

Exit codes: `0` success, `1` run finished with non-success status, `3` missing API key.

See also [docs/cursor_agent_cli_validation.md](../../docs/cursor_agent_cli_validation.md).
