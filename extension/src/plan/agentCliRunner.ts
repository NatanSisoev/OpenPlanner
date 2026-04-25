import { spawn } from "child_process";

export interface RunAgentPrintOptions {
  agentPath: string;
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutChars: number;
  /** When true, passes `--force` so print mode may modify files (see Cursor headless CLI docs). */
  applyEdits?: boolean;
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

/** Windows `.cmd`/`.bat` shims cannot be started with `shell: false` (spawn EINVAL). */
function win32SpawnNeedsShell(agentPath: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(agentPath.trim());
}

/**
 * Runs `agent -p --trust <prompt>` (print mode, same spirit as scripts/cursor-agent-smoke.sh).
 */
export function runAgentPrint(opts: RunAgentPrintOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const baseArgs = opts.applyEdits ? ["-p", "--trust", "--force", opts.prompt] : ["-p", "--trust", opts.prompt];
    // Windows installs commonly expose `cursor` with an `agent` subcommand,
    // not a standalone `agent` executable.
    const looksLikeCursorCli = /(^|[\\/])cursor(\.cmd|\.exe)?$/i.test(opts.agentPath.trim());
    const args = looksLikeCursorCli ? ["agent", ...baseArgs] : baseArgs;
    const useShell = win32SpawnNeedsShell(opts.agentPath);
    const child = spawn(opts.agentPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: useShell,
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout?.on("data", (d: Buffer) => {
      outChunks.push(d);
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
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));

    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new AgentCliError(`agent timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);

    child.on("error", (e) => {
      clearTimeout(killTimer);
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
      if (settled) {
        return;
      }
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
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
