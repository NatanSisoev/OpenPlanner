import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { AgentCliError, runAgentPrint } from "./agentCliRunner";
import { buildAgentEnv as buildEnvForAgent, resolveCursorApiKey as resolveKey } from "./cursorApiKey";
import { resolveDefaultAgentExecutable } from "./agentPath";
import { buildPlanCreationPrompt } from "./planCreationPrompt";
import { extractJsonObject } from "./extractJsonFromAgentOutput";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";
import { saveValidatedPlan } from "./writePlan";

// Re-exported here for backward compat with callers that imported from this module.
export { CURSOR_API_KEY_SECRET, buildAgentEnv, resolveCursorApiKey } from "./cursorApiKey";

export interface CreatePlanFromCliOptions {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot: vscode.Uri;
  userRequest: string;
  /** Live agent stdout (e.g. append to Output + Chat); optional. */
  onAgentStdoutChunk?: (text: string) => void;
  /** Live agent stderr; optional. */
  onAgentStderrChunk?: (text: string) => void;
  /** Correlates create-plan + `runAgentPrint` logs. */
  debugTraceId?: string;
}

/**
 * Run Cursor CLI in print mode, parse JSON plan from stdout, validate, write `.planstack/plans/<id>.json`.
 */
export async function createPlanFromUserRequest(opts: CreatePlanFromCliOptions): Promise<{ plan: Plan; savedUri: vscode.Uri }> {
  const tid = opts.debugTraceId ?? newTraceId("createPlan");
  traceEvent(tid, "createPlan.enter", {
    workspaceRoot: opts.workspaceRoot.fsPath,
    userRequestChars: opts.userRequest.length,
  });
  traceMultiline(tid, "createPlan.userRequest", opts.userRequest);

  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const agentPath = cfg.get<string>("agentPath")?.trim() || "agent";
  const timeoutMs = cfg.get<number>("agentTimeoutMs") ?? 180_000;
  const maxStdoutChars = cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000;
  const useWsl = cfg.get<boolean>("useWsl") ?? false;
  const wslDistro = cfg.get<string>("wslDistro")?.trim() || "Ubuntu";

  const apiKey = await resolveKey(opts.extensionContext);
  if (!apiKey) {
    traceEvent(tid, "createPlan.fail", { reason: "no_api_key" });
    throw new AgentCliError(
      "CURSOR_API_KEY is not set. Export it in the environment that launches Cursor, or run command \"Planstack: Set Cursor API key\".",
    );
  }

  const cwd = opts.workspaceRoot.fsPath;
  const env = await buildEnvForAgent(opts.extensionContext);
  // In WSL mode the agent path is a Linux path -- skip Windows-specific executable resolution.
  const resolvedAgent = useWsl ? agentPath : resolveDefaultAgentExecutable(agentPath);
  const prompt = buildPlanCreationPrompt(opts.userRequest);
  traceEvent(tid, "createPlan.config", { agentPath, resolvedAgent, cwd, timeoutMs, maxStdoutChars, useWsl, wslDistro: useWsl ? wslDistro : undefined });
  traceMultiline(tid, "createPlan.planCreationPrompt", prompt);

  const { stdout, stderr, exitCode } = await runAgentPrint({
    agentPath: resolvedAgent,
    cwd,
    prompt,
    env,
    timeoutMs,
    maxStdoutChars,
    onStdoutChunk: opts.onAgentStdoutChunk,
    onStderrChunk: opts.onAgentStderrChunk,
    debugTraceId: tid,
    useWsl,
    wslDistro,
  });

  traceEvent(tid, "createPlan.agent_exit", {
    exitCode,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
  });

  if (exitCode !== 0) {
    const tail = stderr.trim() || stdout.slice(-500);
    traceEvent(tid, "createPlan.parse_skipped", { reason: "nonzero_exit", tailHead: tail.slice(0, 400) });
    throw new AgentCliError(
      `agent exited with code ${exitCode}. ${tail ? `Details: ${tail}` : ""}`.trim(),
      exitCode,
      stderr,
    );
  }

  let parsed: unknown;
  try {
    const jsonText = extractJsonObject(stdout);
    traceEvent(tid, "createPlan.extract_json", { jsonTextChars: jsonText.length });
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    traceEvent(tid, "createPlan.parse_json_fail", { message: msg, stdoutHead: stdout.slice(0, 400) });
    throw new AgentCliError(
      `Could not parse plan JSON from agent output: ${msg}. First 400 chars: ${stdout.slice(0, 400)}`,
      exitCode,
      stderr,
    );
  }

  let plan: Plan;
  try {
    plan = validatePlanJson(parsed);
    traceEvent(tid, "createPlan.validate_ok", { planId: plan.id, title: plan.title });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    traceEvent(tid, "createPlan.validate_fail", { message: msg });
    throw new AgentCliError(`Plan JSON failed validation: ${msg}`, exitCode, stderr);
  }

  const savedUri = await saveValidatedPlan(plan, opts.workspaceRoot);
  traceEvent(tid, "createPlan.success", { savedPath: savedUri.fsPath, planId: plan.id });
  return { plan, savedUri };
}
