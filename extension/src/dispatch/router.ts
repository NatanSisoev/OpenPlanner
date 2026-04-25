import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { getActiveExecutorProfileId } from "../plan/executorConfig";
import { getExecutionMode, type ExecutionMode } from "../plan/modes";
import { handoffClaudeTerminal } from "./claudeCode";
import { handoffViaAgentCli, type CliPhaseRunFinishedKind } from "./cursorCli";
import { handoffToNativeComposer } from "./cursorNativeHandoff";
import { handoffViaCursorSdk } from "./cursorSdk";
import { handoffViaJunieCli } from "./junieCli";

/** @deprecated Use ExecutionMode from plan/modes.ts; kept for callers that imported HandoffMode. */
export type HandoffMode = ExecutionMode;

/** @deprecated Use getExecutionMode from plan/modes.ts. */
export function getConfiguredHandoffMode(): ExecutionMode {
  return getExecutionMode();
}

export type DispatchPhaseOptions = {
  /** Shown in Chat status lines (e.g. plan title › phase title). */
  statusLabel?: string;
  /** Correlates dispatch + CLI logs; generated if omitted. */
  traceId?: string;
  /**
   * Called when CLI execution ends (`cli` mode only). Not used for native-first / SDK.
   * `success` = exit 0; `error` = non-zero exit or spawn/runtime failure or preflight skip (no workspace / no API key); `stopped` = user-killed agent. `AgentRunBusyError` does not invoke this callback.
   */
  onCliRunFinished?: (kind: CliPhaseRunFinishedKind) => void | Promise<void>;
};

export type { CliPhaseRunFinishedKind } from "./cursorCli";

/**
 * Routes phase execution per `planstack.cursor.executionMode` (legacy: `planstack.cursor.handoff`).
 */
export async function dispatchPhaseHandoff(
  prompt: string,
  extensionContext: vscode.ExtensionContext,
  options?: DispatchPhaseOptions,
): Promise<void> {
  const traceId = options?.traceId ?? newTraceId("dispatch");
  const mode = getExecutionMode();
  traceEvent(traceId, "dispatch.enter", {
    mode,
    statusLabel: options?.statusLabel,
    promptLength: prompt.length,
  });
  traceMultiline(traceId, "dispatch.prompt", prompt);
  switch (mode) {
    case "native-first":
      traceEvent(traceId, "dispatch.target", { handoff: "handoffToNativeComposer" });
      return handoffToNativeComposer(prompt);
    case "sdk-local":
      traceEvent(traceId, "dispatch.target", { handoff: "handoffViaCursorSdk", sdkMode: "local" });
      return handoffViaCursorSdk(prompt, "local");
    case "sdk-cloud":
      traceEvent(traceId, "dispatch.target", { handoff: "handoffViaCursorSdk", sdkMode: "cloud" });
      return handoffViaCursorSdk(prompt, "cloud");
    case "cli": {
      const profile = getActiveExecutorProfileId();
      traceEvent(traceId, "dispatch.target", { handoff: profile === "junie-cli" ? "handoffViaJunieCli" : "handoffViaAgentCli", profile });
      if (profile === "junie-cli") {
        return handoffViaJunieCli(
          prompt,
          extensionContext,
          options?.statusLabel,
          traceId,
          options?.onCliRunFinished,
        );
      }
      return handoffViaAgentCli(
        prompt,
        extensionContext,
        options?.statusLabel,
        traceId,
        options?.onCliRunFinished,
      );
    }
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Optional path: integrated terminal + `claude` (product doc). */
export async function dispatchClaudeHandoff(prompt: string): Promise<void> {
  return handoffClaudeTerminal(prompt);
}
