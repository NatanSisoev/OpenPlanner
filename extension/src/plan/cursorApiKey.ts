import * as vscode from "vscode";
import { prependUserLocalBinToPath } from "./agentPath";

/** Secret storage key. Stable across versions; do not rename. */
export const CURSOR_API_KEY_SECRET = "planstack.cursor.apiKey";

/** Look up the Cursor API key — secret storage first, then environment. */
export async function resolveCursorApiKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const fromSecret = (await context.secrets.get(CURSOR_API_KEY_SECRET))?.trim();
  if (fromSecret) {
    return fromSecret;
  }
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  return fromEnv || undefined;
}

/**
 * Build a child-process env that:
 *  - inherits the Extension Host env
 *  - injects `CURSOR_API_KEY` when we know it
 *  - prepends `~/.local/bin` to PATH so the bundled `agent` is reachable
 */
export async function buildAgentEnv(
  context: vscode.ExtensionContext,
): Promise<NodeJS.ProcessEnv> {
  let env: NodeJS.ProcessEnv = { ...process.env };
  const key = await resolveCursorApiKey(context);
  if (key) {
    env.CURSOR_API_KEY = key;
  }
  env = prependUserLocalBinToPath(env);
  return env;
}
