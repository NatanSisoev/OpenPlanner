import * as vscode from "vscode";

/** Chat → Create plan: how structured plan JSON is produced. */
export type PlanningMode = "cli";

/** Plans tree → Run phase: how phase work is handed off or executed. */
export type ExecutionMode = "native-first" | "sdk-local" | "sdk-cloud" | "cli";

const PLANNING_MODES = new Set<PlanningMode>(["cli"]);

const EXECUTION_MODES = new Set<ExecutionMode>(["native-first", "sdk-local", "sdk-cloud", "cli"]);

export function getPlanningMode(): PlanningMode {
  const raw = vscode.workspace.getConfiguration("planstack.cursor").get<string>("planningMode")?.trim();
  if (raw && PLANNING_MODES.has(raw as PlanningMode)) {
    return raw as PlanningMode;
  }
  return "cli";
}

/**
 * Resolves execution mode: `planstack.cursor.executionMode` when set to a known value;
 * otherwise falls back to legacy `planstack.cursor.handoff`, then **`cli`** (headless agent with --force).
 */
export function getExecutionMode(): ExecutionMode {
  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const primary = cfg.get<string>("executionMode")?.trim();
  if (primary && EXECUTION_MODES.has(primary as ExecutionMode)) {
    return primary as ExecutionMode;
  }
  const legacy = cfg.get<string>("handoff")?.trim();
  if (legacy && EXECUTION_MODES.has(legacy as ExecutionMode)) {
    return legacy as ExecutionMode;
  }
  return "cli";
}
