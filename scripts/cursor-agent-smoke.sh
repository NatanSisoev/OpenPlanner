#!/usr/bin/env bash
# Smoke test for Cursor headless CLI (see docs/cursor_agent_cli_validation.md).
# Default: read-only. Pass --write-demo for a second step that uses --force so the agent creates demo/cursor-agent-smoke-demo.md.
set -euo pipefail

WRITE_DEMO=0
for arg in "$@"; do
  if [ "$arg" = "--write-demo" ]; then
    WRITE_DEMO=1
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if ! command -v agent >/dev/null 2>&1; then
  echo "error: 'agent' not found on PATH. Install Cursor CLI: https://cursor.com/docs/cli/installation.md" >&2
  exit 2
fi

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "error: CURSOR_API_KEY is not set. Export it for non-interactive runs (never commit keys)." >&2
  exit 3
fi

PROMPT='In one sentence, what is this repository about? Base your answer only on README or docs visible in the workspace.'

# --trust: non-interactive runs otherwise stop on "Workspace Trust Required".
# No --force: print mode should not apply file edits (see https://cursor.com/docs/cli/headless).
agent -p --trust "$PROMPT"

if [ "$WRITE_DEMO" = "1" ]; then
  mkdir -p "$ROOT/demo"
  WRITE_PROMPT='You are running as a non-interactive smoke test. Create or overwrite ONLY the file demo/cursor-agent-smoke-demo.md at the repository root. The file must contain:
- a markdown level-1 heading: Cursor agent smoke demo
- a blank line
- one sentence stating this file was written by the Cursor CLI in print mode with --force for demonstration.

Do not modify, create, or delete any other path.'
  # --force required for the agent to apply file changes in print mode.
  agent -p --trust --force "$WRITE_PROMPT"
fi
