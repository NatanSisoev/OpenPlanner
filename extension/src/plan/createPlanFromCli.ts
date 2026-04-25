import * as vscode from "vscode";
import { AgentCliError, runAgentPrint } from "./agentCliRunner";
import { prependUserLocalBinToPath, resolveDefaultAgentExecutable } from "./agentPath";
import { buildPlanCreationPrompt } from "./planCreationPrompt";
import { extractJsonObject } from "./extractJsonFromAgentOutput";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";
import { saveValidatedPlan } from "./writePlan";

export const CURSOR_API_KEY_SECRET = "planstack.cursor.apiKey";

export async function resolveCursorApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromSecret = await context.secrets.get(CURSOR_API_KEY_SECRET);
  if (fromSecret?.trim()) {
    return fromSecret.trim();
  }
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  return fromEnv || undefined;
}

export async function buildAgentEnv(context: vscode.ExtensionContext): Promise<NodeJS.ProcessEnv> {
  let env = { ...process.env } as NodeJS.ProcessEnv;
  const key = await resolveCursorApiKey(context);
  if (key) {
    env.CURSOR_API_KEY = key;
  }
  env = prependUserLocalBinToPath(env);
  return env;
}

export interface CreatePlanFromCliOptions {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot: vscode.Uri;
  userRequest: string;
}

/**
 * Run Cursor CLI in print mode, parse JSON plan from stdout, validate, write `.planstack/plans/<id>.json`.
 */
export async function createPlanFromUserRequest(opts: CreatePlanFromCliOptions): Promise<{ plan: Plan; savedUri: vscode.Uri }> {
  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const agentPath = cfg.get<string>("agentPath")?.trim() || "agent";
  const timeoutMs = cfg.get<number>("agentTimeoutMs") ?? 180_000;
  const maxStdoutChars = cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000;

  const apiKey = await resolveCursorApiKey(opts.extensionContext);
  if (!apiKey) {
    throw new AgentCliError(
      "CURSOR_API_KEY is not set. Export it in the environment that launches Cursor, or run command “Planstack: Set Cursor API key”.",
    );
  }

  const cwd = opts.workspaceRoot.fsPath;
  const env = await buildAgentEnv(opts.extensionContext);
  const resolvedAgent = resolveDefaultAgentExecutable(agentPath);
  const prompt = buildPlanCreationPrompt(opts.userRequest);

  const { stdout, stderr, exitCode } = await runAgentPrint({
    agentPath: resolvedAgent,
    cwd,
    prompt,
    env,
    timeoutMs,
    maxStdoutChars,
  });

  if (exitCode !== 0) {
    const tail = stderr.trim() || stdout.slice(-500);
    throw new AgentCliError(
      `agent exited with code ${exitCode}. ${tail ? `Details: ${tail}` : ""}`.trim(),
      exitCode,
      stderr,
    );
  }

  let parsed: unknown;
  try {
    const jsonText = extractJsonObject(stdout);
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AgentCliError(
      `Could not parse plan JSON from agent output: ${msg}. First 400 chars: ${stdout.slice(0, 400)}`,
      exitCode,
      stderr,
    );
  }

  let plan: Plan;
  try {
    plan = validatePlanJson(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AgentCliError(`Plan JSON failed validation: ${msg}`, exitCode, stderr);
  }

  const savedUri = await saveValidatedPlan(plan, opts.workspaceRoot);
  return { plan, savedUri };
}
