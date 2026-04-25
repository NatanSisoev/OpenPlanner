import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { AgentCliError, runAgentPrint } from "./agentCliRunner";
import { buildAgentEnv as buildEnvForAgent, resolveCursorApiKey as resolveKey } from "./cursorApiKey";
import { resolveDefaultAgentExecutable } from "./agentPath";
import { buildPlanCreationPrompt, buildPlanResyncPrompt } from "./planCreationPrompt";
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

export interface ResyncPlanFromCliOptions {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot: vscode.Uri;
  existingPlan: Plan;
  extraInstructions?: string;
  onAgentStdoutChunk?: (text: string) => void;
  onAgentStderrChunk?: (text: string) => void;
  debugTraceId?: string;
}

interface AgentPlanJsonRunOptions {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot: vscode.Uri;
  prompt: string;
  onAgentStdoutChunk?: (text: string) => void;
  onAgentStderrChunk?: (text: string) => void;
  debugTraceId?: string;
}

export interface RunAgentPromptEditsOptions {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot: vscode.Uri;
  prompt: string;
  onAgentStdoutChunk?: (text: string) => void;
  onAgentStderrChunk?: (text: string) => void;
  debugTraceId?: string;
}

export interface RunAgentPromptEditsResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runAgentForPlanJson(opts: AgentPlanJsonRunOptions): Promise<Plan> {
  const tid = opts.debugTraceId ?? newTraceId("agentPlanJson");

  traceEvent(tid, "agentPlanJson.enter", {
    workspaceRoot: opts.workspaceRoot.fsPath,
    promptChars: opts.prompt.length,
  });
  traceMultiline(tid, "agentPlanJson.prompt", opts.prompt);

  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const agentPath = cfg.get<string>("agentPath")?.trim() || "agent";
  const timeoutMs = cfg.get<number>("agentTimeoutMs") ?? 180_000;
  const maxStdoutChars = cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000;
  const useWsl = cfg.get<boolean>("useWsl") ?? false;
  const wslDistro = cfg.get<string>("wslDistro")?.trim() || "Ubuntu";

  const apiKey = await resolveKey(opts.extensionContext);
  if (!apiKey) {
    traceEvent(tid, "agentPlanJson.fail", { reason: "no_api_key" });
    throw new AgentCliError(
      "CURSOR_API_KEY is not set. Export it in the environment that launches Cursor, or run command “Planstack: Set Cursor API key”.",
    );
  }

  const cwd = opts.workspaceRoot.fsPath;
  const env = await buildEnvForAgent(opts.extensionContext);

  // In WSL mode the agent path is a Linux path/name, so skip Windows-specific executable resolution.
  const resolvedAgent = useWsl ? agentPath : resolveDefaultAgentExecutable(agentPath);

  traceEvent(tid, "agentPlanJson.config", {
    agentPath,
    resolvedAgent,
    cwd,
    timeoutMs,
    maxStdoutChars,
    useWsl,
    wslDistro: useWsl ? wslDistro : undefined,
  });

  const { stdout, stderr, exitCode } = await runAgentPrint({
    agentPath: resolvedAgent,
    cwd,
    prompt: opts.prompt,
    env,
    timeoutMs,
    maxStdoutChars,
    onStdoutChunk: opts.onAgentStdoutChunk,
    onStderrChunk: opts.onAgentStderrChunk,
    debugTraceId: tid,
    useWsl,
    wslDistro,
  });

  traceEvent(tid, "agentPlanJson.agent_exit", {
    exitCode,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
  });

  if (exitCode !== 0) {
    const tail = stderr.trim() || stdout.slice(-500);
    traceEvent(tid, "agentPlanJson.parse_skipped", {
      reason: "nonzero_exit",
      tailHead: tail.slice(0, 400),
    });
    throw new AgentCliError(
      `agent exited with code ${exitCode}. ${tail ? `Details: ${tail}` : ""}`.trim(),
      exitCode,
      stderr,
    );
  }

  let parsed: unknown;

  try {
    const jsonText = extractJsonObject(stdout);
    traceEvent(tid, "agentPlanJson.extract_json", {
      jsonTextChars: jsonText.length,
    });
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    traceEvent(tid, "agentPlanJson.parse_json_fail", {
      message: msg,
      stdoutHead: stdout.slice(0, 400),
    });
    throw new AgentCliError(
      `Could not parse plan JSON from agent output: ${msg}. First 400 chars: ${stdout.slice(0, 400)}`,
      exitCode,
      stderr,
    );
  }

  try {
    const plan = validatePlanJson(parsed);
    traceEvent(tid, "agentPlanJson.validate_ok", {
      planId: plan.id,
      title: plan.title,
    });
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    traceEvent(tid, "agentPlanJson.validate_fail", { message: msg });
    throw new AgentCliError(`Plan JSON failed validation: ${msg}`, exitCode, stderr);
  }
}

export async function runAgentPromptEdits(
  opts: RunAgentPromptEditsOptions,
): Promise<RunAgentPromptEditsResult> {
  const tid = opts.debugTraceId ?? newTraceId("agentPromptEdits");

  traceEvent(tid, "agentPromptEdits.enter", {
    workspaceRoot: opts.workspaceRoot.fsPath,
    promptChars: opts.prompt.length,
  });
  traceMultiline(tid, "agentPromptEdits.prompt", opts.prompt);

  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const agentPath = cfg.get<string>("agentPath")?.trim() || "agent";
  const timeoutMs = cfg.get<number>("agentTimeoutMs") ?? 180_000;
  const maxStdoutChars = cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000;
  const useWsl = cfg.get<boolean>("useWsl") ?? false;
  const wslDistro = cfg.get<string>("wslDistro")?.trim() || "Ubuntu";

  const apiKey = await resolveKey(opts.extensionContext);
  if (!apiKey) {
    traceEvent(tid, "agentPromptEdits.fail", { reason: "no_api_key" });
    throw new AgentCliError(
      "CURSOR_API_KEY is not set. Export it in the environment that launches Cursor, or run command “Planstack: Set Cursor API key”.",
    );
  }

  const cwd = opts.workspaceRoot.fsPath;
  const env = await buildEnvForAgent(opts.extensionContext);
  const resolvedAgent = useWsl ? agentPath : resolveDefaultAgentExecutable(agentPath);

  traceEvent(tid, "agentPromptEdits.config", {
    agentPath,
    resolvedAgent,
    cwd,
    timeoutMs,
    maxStdoutChars,
    useWsl,
    wslDistro: useWsl ? wslDistro : undefined,
  });

  const result = await runAgentPrint({
    agentPath: resolvedAgent,
    cwd,
    prompt: opts.prompt,
    env,
    timeoutMs,
    maxStdoutChars,
    applyEdits: true,
    onStdoutChunk: opts.onAgentStdoutChunk,
    onStderrChunk: opts.onAgentStderrChunk,
    debugTraceId: tid,
    useWsl,
    wslDistro,
  });

  traceEvent(tid, "agentPromptEdits.exit", {
    exitCode: result.exitCode,
    stdoutChars: result.stdout.length,
    stderrChars: result.stderr.length,
  });

  return result;
}

/**
 * Run Cursor CLI in print mode, parse JSON plan from stdout, validate, write `.planstack/plans/<id>.json`.
 */
export async function createPlanFromUserRequest(
  opts: CreatePlanFromCliOptions,
): Promise<{ plan: Plan; savedUri: vscode.Uri }> {
  const tid = opts.debugTraceId ?? newTraceId("createPlan");

  traceEvent(tid, "createPlan.enter", {
    workspaceRoot: opts.workspaceRoot.fsPath,
    userRequestChars: opts.userRequest.length,
  });
  traceMultiline(tid, "createPlan.userRequest", opts.userRequest);

  const prompt = buildPlanCreationPrompt(opts.userRequest);

  const plan = await runAgentForPlanJson({
    extensionContext: opts.extensionContext,
    workspaceRoot: opts.workspaceRoot,
    prompt,
    onAgentStdoutChunk: opts.onAgentStdoutChunk,
    onAgentStderrChunk: opts.onAgentStderrChunk,
    debugTraceId: tid,
  });

  const savedUri = await saveValidatedPlan(plan, opts.workspaceRoot);

  traceEvent(tid, "createPlan.success", {
    savedPath: savedUri.fsPath,
    planId: plan.id,
  });

  return { plan, savedUri };
}

export async function resyncPlanFromCurrentWorkspace(opts: ResyncPlanFromCliOptions): Promise<Plan> {
  const tid = opts.debugTraceId ?? newTraceId("resyncPlan");

  traceEvent(tid, "resyncPlan.enter", {
    workspaceRoot: opts.workspaceRoot.fsPath,
    planId: opts.existingPlan.id,
    phaseCount: opts.existingPlan.phases.length,
  });

  const prompt = buildPlanResyncPrompt(opts.existingPlan, opts.extraInstructions);

  const plan = await runAgentForPlanJson({
    extensionContext: opts.extensionContext,
    workspaceRoot: opts.workspaceRoot,
    prompt,
    onAgentStdoutChunk: opts.onAgentStdoutChunk,
    onAgentStderrChunk: opts.onAgentStderrChunk,
    debugTraceId: tid,
  });

  traceEvent(tid, "resyncPlan.exit", {
    returnedPlanId: plan.id,
    returnedPhases: plan.phases.length,
  });

  return plan;
}