import type { ChildProcess } from "child_process";
import { spawn } from "child_process";

/** Reject second `runAgentPrint` while another is active (no queue). */
export const AGENT_RUN_BUSY_MESSAGE =
  "An agent run is already in progress. Wait for it to finish, or use “Planstack: Stop agent CLI processes” / the Chat “Stop agents” button, then retry.";

export interface RunAgentPrintOptions {
  agentPath: string;
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutChars: number;
  /** When true, passes `--force` so print mode may modify files (see Cursor headless CLI docs). */
  applyEdits?: boolean;
  /** Max UTF-8 characters forwarded per chunk to stream callbacks (avoids huge postMessage / append bursts). */
  maxStreamChunkChars?: number;
  onStdoutChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
}

export class AgentCliError extends Error {
  constructor(
    message: string,
    readonly code?: number | null,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "AgentCliError";
  }
}

export class AgentRunBusyError extends AgentCliError {
  constructor() {
    super(AGENT_RUN_BUSY_MESSAGE);
    this.name = "AgentRunBusyError";
  }
}

let agentRunLocked = false;

type ActiveRunCtl = { killed: boolean; child: ChildProcess };
let activeRunCtl: ActiveRunCtl | undefined;

const registeredChildren = new Set<ChildProcess>();

function registerChild(child: ChildProcess): void {
  registeredChildren.add(child);
}

function unregisterChild(child: ChildProcess): void {
  registeredChildren.delete(child);
}

/**
 * Send SIGTERM to every agent child spawned by this module that is still registered.
 * The in-flight promise rejects with a “stopped” message when the process exits.
 */
export function killAllAgentCliProcesses(): number {
  const list = [...registeredChildren];
  for (const c of list) {
    const ctl = activeRunCtl;
    if (ctl?.child === c) {
      ctl.killed = true;
    }
    c.kill("SIGTERM");
  }
  return list.length;
}

export function isAgentRunBusy(): boolean {
  return agentRunLocked;
}

/** Windows `.cmd`/`.bat` shims cannot be started with `shell: false` (spawn EINVAL). */
function win32SpawnNeedsShell(agentPath: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(agentPath.trim());
}

function clampChunk(s: string, maxChars: number): string {
  if (s.length <= maxChars) {
    return s;
  }
  return `…${s.slice(-maxChars)}`;
}

/**
 * Runs `agent -p --trust <prompt>` (print mode, same spirit as scripts/cursor-agent-smoke.sh).
 * Only one run may be active at a time across the extension host.
 */
export function runAgentPrint(opts: RunAgentPrintOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (agentRunLocked) {
    return Promise.reject(new AgentRunBusyError());
  }
  agentRunLocked = true;

  const streamCap = Math.max(256, opts.maxStreamChunkChars ?? 8192);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      agentRunLocked = false;
      activeRunCtl = undefined;
      fn();
    };

    const baseArgs = opts.applyEdits ? ["-p", "--trust", "--force", opts.prompt] : ["-p", "--trust", opts.prompt];
    const looksLikeCursorCli = /(^|[\\/])cursor(\.cmd|\.exe)?$/i.test(opts.agentPath.trim());
    const args = looksLikeCursorCli ? ["agent", ...baseArgs] : baseArgs;
    const useShell = win32SpawnNeedsShell(opts.agentPath);
    const child = spawn(opts.agentPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: useShell,
    });

    activeRunCtl = { killed: false, child };
    registerChild(child);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const emitOut = (raw: string): void => {
      opts.onStdoutChunk?.(clampChunk(raw, streamCap));
    };
    const emitErr = (raw: string): void => {
      opts.onStderrChunk?.(clampChunk(raw, streamCap));
    };

    child.stdout?.on("data", (d: Buffer) => {
      outChunks.push(d);
      emitOut(d.toString("utf8"));
      const byteLen = Buffer.concat(outChunks).length;
      if (byteLen > opts.maxStdoutChars * 4) {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new AgentCliError(
              `agent stdout exceeded byte budget (>${opts.maxStdoutChars * 4} bytes). Raise planstack.cursor.agentMaxStdoutChars or narrow the request.`,
            ),
          ),
        );
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      errChunks.push(d);
      emitErr(d.toString("utf8"));
    });

    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new AgentCliError(`agent timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);

    child.on("error", (e) => {
      clearTimeout(killTimer);
      unregisterChild(child);
      const err = e as NodeJS.ErrnoException;
      let msg = `Failed to spawn agent: ${e.message}`;
      if (err.code === "ENOENT") {
        msg +=
          ` Cannot find "${opts.agentPath}". The extension prepends ~/.local/bin when present and also resolves common Cursor install locations. ` +
          `If needed, set **planstack.cursor.agentPath** to an absolute executable path (Windows: output of \`where cursor\` or \`where agent\`; macOS/Linux: \`which cursor\` or \`which agent\`).`;
      } else if (process.platform === "win32" && err.code === "EINVAL") {
        msg +=
          ` On Windows, **EINVAL** often means the resolved file is a **.cmd/.bat** shim and could not be spawned. ` +
          `The extension uses a shell for those; if it still fails, set **planstack.cursor.agentPath** to **cursor.exe** or **agent.exe** (full path from \`where.exe\`).`;
      }
      finish(() => reject(new AgentCliError(msg)));
    });

    child.on("close", (exitCode) => {
      clearTimeout(killTimer);
      unregisterChild(child);
      if (settled) {
        return;
      }
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      const wasKilled = activeRunCtl?.killed === true;
      if (wasKilled) {
        finish(() =>
          reject(
            new AgentCliError(
              "Agent run was stopped (process terminated).",
              exitCode,
              stderr,
            ),
          ),
        );
        return;
      }
      if (stdout.length > opts.maxStdoutChars) {
        finish(() =>
          reject(
            new AgentCliError(
              `agent stdout exceeded ${opts.maxStdoutChars} characters. Raise planstack.cursor.agentMaxStdoutChars or narrow the request.`,
              exitCode,
              stderr,
            ),
          ),
        );
        return;
      }
      finish(() => resolve({ stdout, stderr, exitCode }));
    });
  });
}
