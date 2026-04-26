import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import * as path from "path";
import { traceEvent, traceMultiline } from "../debug/trace";
import { startRevealAgentEditedFilesSession } from "./agentEditReveal";

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
  /** When set, verbose spawn/chunk/close logs go to Output → Planstack. */
  debugTraceId?: string;
  /** Windows only: spawn via `wsl.exe -d <wslDistro>` instead of native Windows. */
  useWsl?: boolean;
  wslDistro?: string;
  /** Fired once when the child has produced no output for `stallWarnAfterMs` (default 60s). */
  onStallWarning?: (idleMs: number) => void;
  stallWarnAfterMs?: number;
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

type ActiveRunCtl = {
  killed: boolean;
  terminating: boolean;
  child: ChildProcess;
  killTimer?: ReturnType<typeof setTimeout>;
  terminalError?: AgentCliError;
};
let activeRunCtl: ActiveRunCtl | undefined;
const FORCE_KILL_GRACE_MS = 5_000;

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
      if (ctl.killTimer) {
        clearTimeout(ctl.killTimer);
      }
      ctl.killTimer = setTimeout(() => {
        try {
          ctl.child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }, FORCE_KILL_GRACE_MS);
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

/** Convert a Windows absolute path to its WSL /mnt/<drive>/... equivalent. */
function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[/\\]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, "/");
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
function envSummary(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw = env.PATH ?? "";
  const pathHead = raw ? raw.split(path.delimiter).filter(Boolean).slice(0, 6).join(" | ") : "(empty)";
  return {
    PATH_head: pathHead,
    CURSOR_API_KEY_set: Boolean(env.CURSOR_API_KEY && String(env.CURSOR_API_KEY).length > 0),
    JUNIE_API_KEY_set: Boolean(env.JUNIE_API_KEY && String(env.JUNIE_API_KEY).length > 0),
  };
}

export function buildCursorAgentArgv(agentPath: string, prompt: string, applyEdits: boolean): string[] {
  const baseArgs = applyEdits ? ["-p", "--trust", "--force", prompt] : ["-p", "--trust", prompt];
  const looksLikeCursorCli = /(^|[\\/])cursor(\.cmd|\.exe)?$/i.test(agentPath.trim());
  return looksLikeCursorCli ? ["agent", ...baseArgs] : baseArgs;
}

export interface RunExternalCliOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutChars: number;
  maxStreamChunkChars?: number;
  onStdoutChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
  debugTraceId?: string;
  useWsl?: boolean;
  wslDistro?: string;
  /**
   * Windows WSL: append to WSLENV so these keys pass from Windows env into the WSL session.
   * Defaults to CURSOR_API_KEY for backward compatibility. Use ["JUNIE_API_KEY"] for Junie CLI.
   */
  wslPassThroughKeys?: string[];
  /** Fired once when the child has produced no output for `stallWarnAfterMs` (default 60s). */
  onStallWarning?: (idleMs: number) => void;
  stallWarnAfterMs?: number;
}

function wslEnvSuffix(keys: string[]): string {
  return keys.map((k) => `${k}/u`).join(":");
}

/**
 * Spawn an arbitrary CLI with streamed stdout/stderr (single-flight lock; same lifecycle as Cursor `agent`).
 */
export function runExternalCli(opts: RunExternalCliOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const tid = opts.debugTraceId ?? "externalCli";
  if (agentRunLocked) {
    traceEvent(tid, "runExternalCli.busy_reject", { executable: opts.executable, cwd: opts.cwd });
    return Promise.reject(new AgentRunBusyError());
  }
  agentRunLocked = true;

  const streamCap = Math.max(256, opts.maxStreamChunkChars ?? 8192);
  const wslKeys =
    opts.wslPassThroughKeys && opts.wslPassThroughKeys.length > 0 ? opts.wslPassThroughKeys : ["CURSOR_API_KEY"];

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      agentRunLocked = false;
      const ctl = activeRunCtl;
      if (ctl?.killTimer) {
        clearTimeout(ctl.killTimer);
      }
      activeRunCtl = undefined;
      fn();
    };

    const requestTermination = (message: string): void => {
      const ctl = activeRunCtl;
      if (!ctl) {
        return;
      }
      if (!ctl.terminalError) {
        ctl.terminalError = new AgentCliError(message);
      }
      if (ctl.terminating) {
        return;
      }
      ctl.terminating = true;
      try {
        ctl.child.kill("SIGTERM");
      } catch {
        // Child may have already exited.
      }
      ctl.killTimer = setTimeout(() => {
        try {
          ctl.child.kill("SIGKILL");
        } catch {
          // Child may have already exited.
        }
      }, FORCE_KILL_GRACE_MS);
    };

    const useWsl = opts.useWsl === true && process.platform === "win32";
    let spawnExe: string;
    let spawnArgs: string[];
    let spawnCwd: string;
    let spawnShell: boolean;
    let spawnEnv: NodeJS.ProcessEnv;

    if (useWsl) {
      const distro = opts.wslDistro?.trim() || "Ubuntu";
      const wslCwd = toWslPath(opts.cwd);
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      spawnExe = path.join(systemRoot, "System32", "wsl.exe");
      spawnArgs = ["-d", distro, "--cd", wslCwd, "--exec", opts.executable, ...opts.args];
      spawnCwd = opts.cwd;
      spawnShell = false;
      const existingWslEnv = opts.env.WSLENV;
      const suffix = wslEnvSuffix(wslKeys);
      spawnEnv = {
        ...opts.env,
        WSLENV: existingWslEnv ? `${existingWslEnv}:${suffix}` : suffix,
      };
    } else {
      spawnExe = opts.executable;
      spawnArgs = opts.args;
      spawnCwd = opts.cwd;
      spawnShell = win32SpawnNeedsShell(opts.executable);
      spawnEnv = opts.env;
    }

    const t0 = Date.now();
    traceEvent(tid, "runExternalCli.spawn", {
      executable: opts.executable,
      cwd: opts.cwd,
      shell: spawnShell,
      timeoutMs: opts.timeoutMs,
      maxStdoutChars: opts.maxStdoutChars,
      argvLength: spawnArgs.length,
      useWsl,
      wslExe: useWsl ? spawnExe : undefined,
      wslDistro: useWsl ? (opts.wslDistro?.trim() || "Ubuntu") : undefined,
      env: envSummary(opts.env),
    });
    traceEvent(tid, "runExternalCli.spawnArgs", {
      args: spawnArgs.map((a, i) => ({ index: i, length: a.length, head: a.slice(0, 120) })),
    });
    traceMultiline(
      tid,
      "runExternalCli.argv_full",
      spawnArgs.map((a, i) => `--- argv[${i}] len=${a.length} ---\n${a}`).join("\n"),
    );

    const child = spawn(spawnExe, spawnArgs, {
      cwd: spawnCwd,
      env: spawnEnv,
      shell: spawnShell,
    });

    traceEvent(tid, "runExternalCli.spawned", { pid: child.pid ?? null });

    activeRunCtl = { killed: false, child, terminating: false };
    registerChild(child);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let stdoutChunkCount = 0;
    let stderrChunkCount = 0;

    const stallMs = Math.max(5_000, opts.stallWarnAfterMs ?? 60_000);
    let lastOutputAt = Date.now();
    let stallWarned = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      if (!opts.onStallWarning || stallWarned) {
        return;
      }
      const remaining = Math.max(1_000, stallMs - (Date.now() - lastOutputAt));
      stallTimer = setTimeout(() => {
        const idleMs = Date.now() - lastOutputAt;
        if (idleMs >= stallMs) {
          stallWarned = true;
          traceEvent(tid, "runExternalCli.stall_warning", { idleMs });
          try {
            opts.onStallWarning?.(idleMs);
          } catch {
            // best-effort notification
          }
        } else {
          armStallTimer();
        }
      }, remaining);
    };
    armStallTimer();
    const noteOutput = (): void => {
      lastOutputAt = Date.now();
      if (stallWarned) {
        stallWarned = false;
      }
      armStallTimer();
    };

    const emitOut = (raw: string): void => {
      opts.onStdoutChunk?.(clampChunk(raw, streamCap));
    };
    const emitErr = (raw: string): void => {
      opts.onStderrChunk?.(clampChunk(raw, streamCap));
    };

    child.stdout?.on("data", (d: Buffer) => {
      noteOutput();
      outChunks.push(d);
      const str = d.toString("utf8");
      stdoutChunkCount++;
      traceEvent(tid, "runExternalCli.stdoutChunk", {
        n: stdoutChunkCount,
        bytes: d.length,
        chars: str.length,
        sample: str.slice(0, 200),
      });
      emitOut(str);
      const byteLen = Buffer.concat(outChunks).length;
      if (byteLen > opts.maxStdoutChars * 4) {
        traceEvent(tid, "runExternalCli.stdout_budget_kill", {
          byteLen,
          budgetBytes: opts.maxStdoutChars * 4,
        });
        requestTermination(
          `CLI stdout exceeded byte budget (>${opts.maxStdoutChars * 4} bytes). Raise planstack.cursor.agentMaxStdoutChars or narrow the request.`,
        );
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      noteOutput();
      errChunks.push(d);
      const str = d.toString("utf8");
      stderrChunkCount++;
      traceEvent(tid, "runExternalCli.stderrChunk", {
        n: stderrChunkCount,
        bytes: d.length,
        chars: str.length,
        sample: str.slice(0, 200),
      });
      emitErr(str);
    });

    const killTimer = setTimeout(() => {
      traceEvent(tid, "runExternalCli.timeout_kill", { afterMs: opts.timeoutMs });
      requestTermination(`CLI timed out after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);

    child.on("error", (e) => {
      clearTimeout(killTimer);
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      unregisterChild(child);
      const err = e as NodeJS.ErrnoException;
      let msg = `Failed to spawn CLI: ${e.message}`;
      if (err.code === "ENOENT") {
        msg += ` Cannot find "${opts.executable}". For Cursor agent set **planstack.cursor.agentPath**; for Junie set **planstack.executor.juniePath** (absolute path if the binary is not on PATH).`;
      } else if (process.platform === "win32" && err.code === "EINVAL") {
        msg +=
          ` On Windows, **EINVAL** often means a **.cmd/.bat** shim could not be spawned. ` +
          `Try pointing the path setting at a **.exe** (full path from \`where.exe\`).`;
      }
      traceEvent(tid, "runExternalCli.spawn_error", { message: msg, code: (e as NodeJS.ErrnoException).code });
      finish(() => reject(new AgentCliError(msg)));
    });

    child.on("close", (exitCode) => {
      clearTimeout(killTimer);
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      unregisterChild(child);
      if (settled) {
        return;
      }
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      traceEvent(tid, "runExternalCli.close", {
        exitCode,
        elapsedMs: Date.now() - t0,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        stdoutChunks: stdoutChunkCount,
        stderrChunks: stderrChunkCount,
      });
      const ctl = activeRunCtl;
      const terminalError = ctl?.terminalError;
      if (terminalError) {
        finish(() =>
          reject(
            new AgentCliError(
              terminalError.message,
              exitCode,
              stderr || terminalError.stderr,
            ),
          ),
        );
        return;
      }
      const wasKilled = ctl?.killed === true;
      if (wasKilled) {
        traceEvent(tid, "runExternalCli.killed_exit", {});
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
        traceEvent(tid, "runExternalCli.stdout_char_budget_reject", {
          stdoutChars: stdout.length,
          maxStdoutChars: opts.maxStdoutChars,
        });
        finish(() =>
          reject(
            new AgentCliError(
              `CLI stdout exceeded ${opts.maxStdoutChars} characters. Raise planstack.cursor.agentMaxStdoutChars or narrow the request.`,
              exitCode,
              stderr,
            ),
          ),
        );
        return;
      }
      traceEvent(tid, "runExternalCli.resolve_ok", { exitCode });
      finish(() => resolve({ stdout, stderr, exitCode }));
    });
  });
}

/** Cursor `agent` print mode; delegates to {@link runExternalCli}. */
export function runAgentPrint(opts: RunAgentPrintOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const revealSession =
    opts.applyEdits === true ? startRevealAgentEditedFilesSession(opts.cwd, opts.debugTraceId) : undefined;
  const args = buildCursorAgentArgv(opts.agentPath, opts.prompt, !!opts.applyEdits);
  const run = runExternalCli({
    executable: opts.agentPath,
    args,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    maxStdoutChars: opts.maxStdoutChars,
    maxStreamChunkChars: opts.maxStreamChunkChars,
    onStdoutChunk: opts.onStdoutChunk,
    onStderrChunk: opts.onStderrChunk,
    debugTraceId: opts.debugTraceId,
    useWsl: opts.useWsl,
    wslDistro: opts.wslDistro,
    wslPassThroughKeys: ["CURSOR_API_KEY"],
    onStallWarning: opts.onStallWarning,
    stallWarnAfterMs: opts.stallWarnAfterMs,
  });
  return run.finally(() => {
    revealSession?.dispose();
  });
}
