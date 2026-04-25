import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Same convention as Cursor CLI docs / README: `~/.local/bin`. */
export function userLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

/**
 * Prepend `~/.local/bin` to `PATH` for the child process when that directory exists,
 * so the Extension Host can find `agent` without matching the interactive shell PATH.
 */
export function prependUserLocalBinToPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const localBin = userLocalBinDir();
  if (!fs.existsSync(localBin)) {
    return env;
  }
  const sep = path.delimiter;
  const cur = env.PATH ?? "";
  const normLocal = path.normalize(localBin);
  const parts = cur.split(sep).filter(Boolean);
  if (parts.some((p) => path.normalize(p) === normLocal)) {
    return env;
  }
  const prefix = cur.length > 0 ? `${localBin}${sep}${cur}` : localBin;
  return { ...env, PATH: prefix };
}

/**
 * If settings use the bare command `agent`, use `~/.local/bin/agent` when that file exists
 * (macOS/Linux). Windows: try `agent.cmd` / `agent.exe` under the same directory.
 */
export function resolveDefaultAgentExecutable(configured: string): string {
  const c = configured.trim() || "agent";
  if (path.isAbsolute(c)) {
    return c;
  }
  if (c.includes("/") || c.includes("\\")) {
    return c;
  }
  if (path.basename(c) !== "agent") {
    return c;
  }

  const localBin = userLocalBinDir();
  if (!fs.existsSync(localBin)) {
    return c;
  }

  if (process.platform === "win32") {
    for (const name of ["agent.cmd", "agent.exe", "agent"]) {
      const full = path.join(localBin, name);
      if (fs.existsSync(full)) {
        return full;
      }
    }
    return c;
  }

  const unixAgent = path.join(localBin, "agent");
  return fs.existsSync(unixAgent) ? unixAgent : c;
}
