import * as vscode from "vscode";
import { prependUserLocalBinToPath } from "./agentPath";

/** Secret storage key for Junie CLI token. */
export const JUNIE_API_KEY_SECRET = "planstack.executor.junieApiKey";

export async function resolveJunieApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromSecret = (await context.secrets.get(JUNIE_API_KEY_SECRET))?.trim();
  if (fromSecret) {
    return fromSecret;
  }
  return process.env.JUNIE_API_KEY?.trim() || undefined;
}

/** Child env for Junie CLI: host env + optional JUNIE_API_KEY + ~/.local/bin on PATH. */
export async function buildJunieCliEnv(context: vscode.ExtensionContext): Promise<NodeJS.ProcessEnv> {
  let env: NodeJS.ProcessEnv = { ...process.env };
  const key = await resolveJunieApiKey(context);
  if (key) {
    env.JUNIE_API_KEY = key;
  }
  env = prependUserLocalBinToPath(env);
  return env;
}
