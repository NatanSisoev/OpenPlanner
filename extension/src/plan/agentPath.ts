import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Same convention as Cursor CLI docs / README: `~/.local/bin`. */
export function userLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

function windowsCursorBinCandidates(): string[] {
  const out: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    out.push(path.join(localAppData, "Programs", "cursor", "resources", "app", "bin"));
  }
  // Fallback for nonstandard installs where only APPDATA is present.
  const appData = process.env.APPDATA;
  if (appData) {
    out.push(path.join(appData, "..", "Local", "Programs", "cursor", "resources", "app", "bin"));
  }
  return out;
}

function existingExecutableFromDir(dir: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return undefined;
}

/**
 * Prepend `~/.local/bin` to `PATH` for the child process when that directory exists,
 * so the Extension Host can find `agent` without matching the interactive shell PATH.
 */
export function prependUserLocalBinToPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sep = path.delimiter;
  const cur = env.PATH ?? "";
  const parts = cur.split(sep).filter(Boolean);
  const normalize = (p: string) => path.normalize(path.resolve(p));
  const seen = new Set(parts.map(normalize));
  const prependDirs: string[] = [];

  const localBin = userLocalBinDir();
  if (fs.existsSync(localBin) && !seen.has(normalize(localBin))) {
    prependDirs.push(localBin);
  }

  if (process.platform === "win32") {
    for (const dir of windowsCursorBinCandidates()) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      const norm = normalize(dir);
      if (!seen.has(norm)) {
        prependDirs.push(dir);
        seen.add(norm);
      }
    }
  }

  if (prependDirs.length === 0) {
    return env;
  }
  const prefix = cur.length > 0 ? `${prependDirs.join(sep)}${sep}${cur}` : prependDirs.join(sep);
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

  if (process.platform === "win32") {
    const exeNames = ["agent.exe", "agent.cmd", "agent"] as const;
    const cursorNames = ["cursor.exe", "cursor.cmd", "cursor"] as const;
    const localBin = userLocalBinDir();
    if (fs.existsSync(localBin)) {
      const fromLocalBin = existingExecutableFromDir(localBin, exeNames);
      if (fromLocalBin) {
        return fromLocalBin;
      }
      const fromLocalCursor = existingExecutableFromDir(localBin, cursorNames);
      if (fromLocalCursor) {
        return fromLocalCursor;
      }
    }
    for (const dir of windowsCursorBinCandidates()) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      const fromCursorInstall = existingExecutableFromDir(dir, exeNames);
      if (fromCursorInstall) {
        return fromCursorInstall;
      }
      const fromCursorCli = existingExecutableFromDir(dir, cursorNames);
      if (fromCursorCli) {
        return fromCursorCli;
      }
    }
    return c;
  }

  const localBin = userLocalBinDir();
  if (!fs.existsSync(localBin)) {
    return c;
  }
  const unixAgent = path.join(localBin, "agent");
  return fs.existsSync(unixAgent) ? unixAgent : c;
}
