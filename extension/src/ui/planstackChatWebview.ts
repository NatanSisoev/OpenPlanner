import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { getOutput } from "../log";
import { AgentCliError, AgentRunBusyError, killAllAgentCliProcesses } from "../plan/agentCliRunner";
import { createPlanFromUserRequest } from "../plan/createPlanFromCli";
import { getPlanningMode } from "../plan/modes";
import {
  postAgentStreamChunk,
  postAgentStreamEnd,
  postAgentStreamStart,
  registerAgentStreamSink,
  type AgentStreamEndReason,
} from "./agentChatStreamBridge";
import { registerChatSystemSink } from "./chatStatusBridge";

export const CHAT_WEBVIEW_ID = "hackupc.planstack.chat";

const MAX_MESSAGE_CHARS = 8000;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type ChatRole = "user" | "system";

type ChatTurn = { role: ChatRole; text: string };

export class PlanstackChatWebview implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly transcript: ChatTurn[] = [];
  private createPlanInFlight = false;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly onPlanSaved: () => Promise<void>,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    const w = webviewView.webview;
    w.options = {
      enableScripts: true,
      localResourceRoots: [this.extUri],
    };

    const scriptUri = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, "media", "planstackChat.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src ${w.cspSource}`,
    ].join("; ");

    w.html = getChatHtml(csp, scriptUri);

    const pushSystem = (text: string): void => {
      this.transcript.push({ role: "system", text });
      try {
        w.postMessage({ type: "append", role: "system", text });
      } catch {
        // Webview disposed.
      }
    };
    registerChatSystemSink(pushSystem);

    registerAgentStreamSink({
      onStart: (runId, meta) => {
        try {
          w.postMessage({
            type: "agentStreamStart",
            runId,
            label: meta.label,
            source: meta.source,
            initialLine: meta.initialLine,
          });
        } catch {
          // Webview disposed.
        }
      },
      onChunk: (runId, stream, text) => {
        try {
          w.postMessage({ type: "agentStreamAppend", runId, stream, text });
        } catch {
          // Webview disposed.
        }
      },
      onEnd: (runId, reason) => {
        try {
          w.postMessage({ type: "agentStreamEnd", runId, reason });
        } catch {
          // Webview disposed.
        }
      },
    });

    const sub = w.onDidReceiveMessage((msg: unknown) => {
      const recvId = newTraceId("chatRecv");
      traceEvent(recvId, "chat.onDidReceiveMessage", { raw: safeJson(msg) });
      if (!msg || typeof msg !== "object") {
        traceEvent(recvId, "chat.onDidReceiveMessage.ignore", { reason: "not_object" });
        return;
      }
      const m = msg as { type?: string; text?: string };
      if (m.type === "send" && typeof m.text === "string") {
        let text = m.text.trim();
        traceEvent(recvId, "chat.send", {
          rawTextChars: m.text.length,
          trimmedEmpty: !text,
          appliedMaxCap: text.length > MAX_MESSAGE_CHARS,
        });
        traceMultiline(recvId, "chat.send.full_text", m.text);
        if (!text) {
          return;
        }
        if (text.length > MAX_MESSAGE_CHARS) {
          text = text.slice(0, MAX_MESSAGE_CHARS);
        }
        this.transcript.push({ role: "user", text });
        w.postMessage({ type: "append", role: "user", text });
        traceEvent(recvId, "chat.send.done", { storedChars: text.length });
        return;
      }
      if (m.type === "createPlan" && typeof m.text === "string") {
        const text = m.text.trim();
        traceEvent(recvId, "chat.createPlan.click", { rawTextChars: m.text.length, trimmedEmpty: !text });
        traceMultiline(recvId, "chat.createPlan.full_input", m.text);
        if (!text) {
          void vscode.window.showWarningMessage("Planstack: enter a request in the box before Create plan.");
          return;
        }
        void this.runCreatePlanFlow(w, text);
      }
      if (m.type === "stopAgents") {
        const n = killAllAgentCliProcesses();
        traceEvent(recvId, "chat.stopAgents", { processesSignaled: n });
        const line =
          n > 0
            ? `Stop agents: sent SIGTERM to ${n} process(es). In-flight runs will abort.`
            : "Stop agents: no Planstack agent process was running.";
        this.transcript.push({ role: "system", text: line });
        try {
          w.postMessage({ type: "append", role: "system", text: line });
        } catch {
          // Webview disposed.
        }
        void vscode.window.showInformationMessage(`Planstack: ${line}`);
        return;
      }
      traceEvent(recvId, "chat.onDidReceiveMessage.unhandled", { type: m.type });
    });
    const disposeChat = webviewView.onDidDispose(() => {
      registerChatSystemSink(undefined);
      registerAgentStreamSink(undefined);
      sub.dispose();
      disposeChat.dispose();
    });

    const snapshot = [...this.transcript];
    setTimeout(() => {
      try {
        w.postMessage({ type: "init", messages: snapshot });
      } catch {
        // Webview may already be disposed.
      }
    }, 0);
  }

  private async runCreatePlanFlow(w: vscode.Webview, userRequest: string): Promise<void> {
    const flowId = newTraceId("createPlanFlow");
    traceEvent(flowId, "createPlanFlow.start", { userRequestChars: userRequest.length });
    traceMultiline(flowId, "createPlanFlow.userRequest", userRequest);

    if (this.createPlanInFlight) {
      traceEvent(flowId, "createPlanFlow.skip", { reason: "already_in_flight" });
      void vscode.window.showWarningMessage("Planstack: a plan is already being generated.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      traceEvent(flowId, "createPlanFlow.skip", { reason: "no_workspace" });
      void vscode.window.showErrorMessage("Planstack: open a workspace folder before creating a plan.");
      return;
    }

    this.createPlanInFlight = true;
    w.postMessage({ type: "busy", busy: true });

    try {
      const planningMode = getPlanningMode();
      traceEvent(flowId, "createPlanFlow.planning_mode", { planningMode });
      if (planningMode !== "cli") {
        traceEvent(flowId, "createPlanFlow.abort", { reason: "unsupported_planning_mode", planningMode });
        void vscode.window.showErrorMessage(
          `Planstack: planning mode "${planningMode}" is not supported. Set planstack.cursor.planningMode to \"cli\" (default).`,
        );
        return;
      }
      const startLine = "Create plan: starting Cursor CLI run (agent -p --trust)…";
      this.transcript.push({ role: "system", text: startLine });
      w.postMessage({ type: "append", role: "system", text: startLine });

      const cfg = vscode.workspace.getConfiguration("planstack.cursor");
      const streamToOutput = cfg.get<boolean>("cliStreamAgentOutput") ?? true;
      const chatThrottleMs = cfg.get<number>("cliStreamChatThrottleMs") ?? 25_000;
      const useLiveChat = cfg.get<boolean>("agentChatLiveStream") ?? true;
      traceEvent(flowId, "createPlanFlow.config_snapshot", {
        streamToOutput,
        chatThrottleMs,
        useLiveChat,
      });
      const out = getOutput();
      out.show(true);
      out.appendLine(`\n=== Create plan: agent run ${new Date().toISOString()} ===\n`);

      const runId = randomUUID();
      traceEvent(flowId, "createPlanFlow.run_context", { runId, streamToOutput, useLiveChat });
      let streamActive = false;
      let endReason: AgentStreamEndReason = "complete";

      let lastChatAt = 0;
      const pushStreamChat = (prefix: string, chunk: string): void => {
        const t = chunk.trim();
        if (!t) {
          return;
        }
        const now = Date.now();
        if (now - lastChatAt < chatThrottleMs) {
          return;
        }
        lastChatAt = now;
        const line = `${prefix}${t.slice(-200)}`;
        this.transcript.push({ role: "system", text: line });
        try {
          w.postMessage({ type: "append", role: "system", text: line });
        } catch {
          // Webview disposed.
        }
      };

      try {
        if (useLiveChat) {
          streamActive = true;
          postAgentStreamStart(runId, {
            label: "Create plan",
            source: "createPlan",
            initialLine:
              "Waiting for agent stdout/stderr…\n\nIf this stays empty for a long time, the Cursor CLI may be buffering until the run completes.\n\n",
          });
        }
        traceEvent(flowId, "createPlanFlow.calling_createPlanFromUserRequest", {
          debugTraceId: flowId,
          workspaceRoot: folder.uri.fsPath,
        });
        const { savedUri } = await createPlanFromUserRequest({
          extensionContext: this.extensionContext,
          workspaceRoot: folder.uri,
          userRequest,
          debugTraceId: flowId,
          onAgentStdoutChunk:
            streamToOutput || useLiveChat
              ? (text) => {
                  if (streamToOutput && text) {
                    out.append(text);
                  }
                  if (!text) {
                    return;
                  }
                  if (useLiveChat) {
                    postAgentStreamChunk(runId, "stdout", text);
                  } else if (streamToOutput) {
                    pushStreamChat("Create plan: ", text);
                  }
                }
              : undefined,
          onAgentStderrChunk:
            streamToOutput || useLiveChat
              ? (text) => {
                  if (streamToOutput && text) {
                    out.append(text);
                  }
                  if (!text) {
                    return;
                  }
                  if (useLiveChat) {
                    postAgentStreamChunk(runId, "stderr", text);
                  } else if (streamToOutput) {
                    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
                    const last = lines.length > 0 ? lines[lines.length - 1]! : text;
                    pushStreamChat("Create plan (stderr): ", last);
                  }
                }
              : undefined,
        });
        const rel = vscode.workspace.asRelativePath(savedUri);
        traceEvent(flowId, "createPlanFlow.success", { savedUri: savedUri.fsPath, rel });
        const line = `Saved plan file: ${rel}`;
        this.transcript.push({ role: "system", text: line });
        w.postMessage({ type: "append", role: "system", text: line });
        await this.onPlanSaved();
        void vscode.window.showInformationMessage(`Planstack: wrote ${rel}`);
        await vscode.window.showTextDocument(savedUri, { preview: true });
      } catch (planErr) {
        const msg = planErr instanceof Error ? planErr.message : String(planErr);
        endReason =
          planErr instanceof AgentCliError && msg.includes("stopped") ? "stopped" : "error";
        throw planErr;
      } finally {
        if (streamActive) {
          postAgentStreamEnd(runId, endReason);
          streamActive = false;
        }
      }
    } catch (e) {
      if (e instanceof AgentRunBusyError) {
        traceEvent(flowId, "createPlanFlow.error", { kind: "AgentRunBusyError", message: e.message });
        const line = `Create plan skipped: ${e.message}`;
        this.transcript.push({ role: "system", text: line });
        w.postMessage({ type: "append", role: "system", text: line });
        void vscode.window.showWarningMessage(e.message);
        return;
      }
      let detail = e instanceof Error ? e.message : String(e);
      if (e instanceof AgentCliError && e.stderr?.trim()) {
        detail = `${detail}\n${e.stderr.trim().slice(0, 800)}`;
      }
      traceEvent(flowId, "createPlanFlow.error", {
        kind: e instanceof AgentCliError ? "AgentCliError" : e instanceof Error ? "Error" : typeof e,
        message: detail.slice(0, 2000),
      });
      if (e instanceof Error && e.stack) {
        traceMultiline(flowId, "createPlanFlow.error.stack", e.stack);
      }
      const stopped = e instanceof AgentCliError && detail.includes("stopped");
      this.transcript.push({ role: "system", text: `Create plan failed: ${detail.slice(0, 500)}` });
      w.postMessage({ type: "append", role: "system", text: `Create plan failed: ${detail.slice(0, 500)}` });
      if (stopped) {
        void vscode.window.showWarningMessage(`Planstack: ${detail.slice(0, 2000)}`);
      } else {
        void vscode.window.showErrorMessage(`Planstack: ${detail.slice(0, 2000)}`);
      }
    } finally {
      traceEvent(flowId, "createPlanFlow.finally", { createPlanInFlight_cleared: true });
      this.createPlanInFlight = false;
      w.postMessage({ type: "busy", busy: false });
    }
  }
}

function getChatHtml(csp: string, scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      display: flex; flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .hint {
      font-size: 0.8em; opacity: 0.55; padding: 8px 10px 6px; line-height: 1.5;
      border-bottom: 1px solid rgba(127,127,127,0.15);
    }
    .hint strong { opacity: 0.85; }
    .hint code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
    #messages {
      flex: 1; overflow-y: auto;
      padding: 10px 10px 10px;
      display: flex; flex-direction: column; gap: 7px;
    }
    .row { display: flex; justify-content: flex-end; }
    .row.system { justify-content: flex-start; }
    .bubble {
      max-width: 90%;
      padding: 7px 10px;
      border-radius: 8px;
      white-space: pre-wrap; word-break: break-word;
      line-height: 1.4; font-size: 0.9em;
    }
    .bubble.user {
      background: var(--vscode-input-background);
      border: 1px solid rgba(127,127,127,0.2);
      border-bottom-right-radius: 2px;
    }
    .bubble.system {
      background: var(--vscode-editor-background, rgba(0,0,0,0.15));
      border: 1px solid rgba(127,127,127,0.15);
      border-bottom-left-radius: 2px;
      opacity: 0.85;
    }
    #composer {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px 10px;
      border-top: 1px solid rgba(127,127,127,0.18);
    }
    #input {
      width: 100%; min-height: 36px; max-height: 120px; resize: vertical;
      padding: 7px 9px;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid rgba(127,127,127,0.25);
      border-radius: 5px; outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder, #007acc); }
    #composerActions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
    #send, #createPlan, #stopAgents {
      flex-shrink: 0; padding: 0 12px; height: 28px;
      cursor: pointer; font-size: 0.85em;
      border: none; border-radius: 4px; white-space: nowrap;
    }
    #createPlan {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    #createPlan:hover { background: var(--vscode-button-hoverBackground); }
    #send {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2));
    }
    #send:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.3)); }
    #stopAgents {
      color: var(--vscode-foreground);
      background: var(--vscode-inputValidation-warningBackground, rgba(200, 140, 0, 0.25));
      border: 1px solid rgba(127,127,127,0.25);
    }
    #stopAgents:hover { background: var(--vscode-inputValidation-warningBackground, rgba(200, 140, 0, 0.35)); }
    #send:disabled, #createPlan:disabled, #stopAgents:disabled, #input:disabled {
      opacity: 0.45; cursor: not-allowed;
    }
    .agent-stream-row {
      max-width: 98%;
      align-self: stretch;
    }
    .agent-stream-header {
      font-size: 0.75em;
      opacity: 0.78;
      padding: 4px 0 2px;
    }
    .agent-stream {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.82em;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: min(40vh, 320px);
      overflow-y: auto;
      padding: 8px 10px;
      margin: 0;
      background: var(--vscode-editor-background, rgba(0,0,0,0.2));
      border: 1px solid rgba(127,127,127,0.25);
      border-radius: 6px;
    }
    .agent-stream-ended .agent-stream {
      max-height: min(22vh, 180px);
    }
    .agent-stream-footer {
      font-size: 0.72em;
      opacity: 0.65;
      padding: 3px 0 6px;
    }
  </style>
</head>
<body>
  <div class="hint">Use <strong>Create plan</strong> for <code>.planstack/plans/&lt;id&gt;.json</code>. Agent stdout/stderr can appear in a <strong>live block</strong> below (and in <strong>Output → Planstack</strong>). Toggle <code>planstack.cursor.agentChatLiveStream</code> off for throttled bubbles only. One agent at a time; <strong>Stop agents</strong> sends SIGTERM. <strong>Send</strong> stays local.</div>
  <div id="messages" aria-live="polite"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Describe the plan you want…" aria-label="Message"></textarea>
    <div id="composerActions">
      <button type="button" id="stopAgents">Stop agents</button>
      <button type="button" id="createPlan">Create plan</button>
      <button type="button" id="send">Send</button>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
