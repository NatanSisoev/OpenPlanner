import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { getOutput, logLine } from "../log";
import { AgentCliError, AgentRunBusyError, killAllAgentCliProcesses } from "../plan/agentCliRunner";
import { createPlanFromUserRequest, runAgentPromptEdits } from "../plan/createPlanFromCli";
import { getPlanningMode } from "../plan/modes";
import {
  postAgentStreamChunk,
  postAgentStreamEnd,
  postAgentStreamStart,
  registerAgentStreamSink,
  type AgentStreamEndReason,
} from "./agentChatStreamBridge";
import { registerChatSystemSink, registerChatUserSink } from "./chatStatusBridge";
import { postAnimatedStatus, postRunFailure, registerRichChatSink } from "./richChatBridge";

export const CHAT_WEBVIEW_ID = "hackupc.planstack.chat";

const MAX_MESSAGE_CHARS = 8000;
const execFileAsync = promisify(execFile);

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function fileNameFromPath(filePath: string): string {
  const parts = normalizeRelPath(filePath).split("/");
  return parts[parts.length - 1] || filePath;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function getHeadFileContent(cwd: string, relPath: string): Promise<string | undefined> {
  const git = process.platform === "win32" ? "git.exe" : "git";
  try {
    const { stdout } = await execFileAsync(git, ["show", `HEAD:${normalizeRelPath(relPath)}`], {
      cwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout);
  } catch {
    return undefined;
  }
}

type ChatRole = "user" | "system";

type ChatTurn = { role: ChatRole; text: string };

export class PlanstackChatWebview implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly transcript: ChatTurn[] = [];
  private activeFlowCount = 0;
  private activeFlowSource: "createPlan" | "sendPrompt" | "" = "";

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
    const pushUser = (text: string): void => {
      this.transcript.push({ role: "user", text });
      try {
        w.postMessage({ type: "append", role: "user", text });
      } catch {
        // Webview disposed.
      }
    };
    registerChatSystemSink(pushSystem);
    registerChatUserSink(pushUser);

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

    registerRichChatSink((msg) => {
      try {
        w.postMessage(msg);
      } catch {
        // Webview disposed.
      }
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
        void this.runSendPromptFlow(w, text);
        traceEvent(recvId, "chat.send.done", { storedChars: text.length, handled: true });
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
      if (m.type === "openScm") {
        void vscode.commands.executeCommand("workbench.view.scm");
        return;
      }
      if (m.type === "openOutput") {
        getOutput().show(true);
        return;
      }
      if (m.type === "debugCliConnection") {
        void vscode.commands.executeCommand("hackupc.planstack.debugCliConnection");
        return;
      }
      if (m.type === "retryPrompt" && typeof (m as { prompt?: unknown }).prompt === "string") {
        const text = (m as { prompt: string }).prompt.trim();
        if (text) {
          this.transcript.push({ role: "user", text });
          w.postMessage({ type: "append", role: "user", text });
          void this.runSendPromptFlow(w, text);
        }
        return;
      }
      if (m.type === "copyText" && typeof (m as { text?: unknown }).text === "string") {
        void vscode.env.clipboard.writeText((m as { text: string }).text);
        return;
      }
      if (m.type === "openFileDiff" && typeof (m as { filePath?: unknown }).filePath === "string") {
        const filePath = normalizeRelPath((m as { filePath: string }).filePath);
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          return;
        }
        const absUri = vscode.Uri.joinPath(folder.uri, ...filePath.split("/"));
        void (async () => {
          try {
            // Primary path: show exactly what summary reports (HEAD -> working tree).
            const relFromWorkspace = normalizeRelPath(vscode.workspace.asRelativePath(absUri, false));
            const [headContent, workingTreeExists] = await Promise.all([
              getHeadFileContent(folder.uri.fsPath, relFromWorkspace),
              exists(absUri),
            ]);
            if (headContent !== undefined || workingTreeExists) {
              const leftDoc = await vscode.workspace.openTextDocument({ content: headContent ?? "" });
              const rightDoc = workingTreeExists
                ? undefined
                : await vscode.workspace.openTextDocument({ content: "" });
              await vscode.commands.executeCommand(
                "vscode.diff",
                leftDoc.uri,
                rightDoc?.uri ?? absUri,
                `${fileNameFromPath(filePath)} (HEAD ↔ Working Tree)`,
              );
              return;
            }
            logLine(`openFileDiff: could not resolve HEAD or working-tree content for ${filePath}`);
          } catch {
            // fall through to simple open
          }

          // Fallback: use SCM change resource if available.
          try {
            const gitExt = vscode.extensions.getExtension("vscode.git");
            if (gitExt) {
              if (!gitExt.isActive) {
                await gitExt.activate();
              }
              const api = (gitExt.exports as {
                getAPI(v: 1):
                  | {
                      getRepository(uri: vscode.Uri):
                        | {
                            state: {
                              workingTreeChanges: Array<{ uri: vscode.Uri; originalUri: vscode.Uri }>;
                              indexChanges: Array<{ uri: vscode.Uri; originalUri: vscode.Uri }>;
                            };
                          }
                        | null;
                    }
                  | null;
              }).getAPI(1);
              const repo = api?.getRepository(folder.uri);
              if (repo) {
                const changes = [...repo.state.workingTreeChanges, ...repo.state.indexChanges];
                const change = changes.find(
                  (c) => normalizeRelPath(vscode.workspace.asRelativePath(c.uri, false)) === filePath,
                );
                if (change?.originalUri) {
                  await vscode.commands.executeCommand(
                    "vscode.diff",
                    change.originalUri,
                    change.uri,
                    `${fileNameFromPath(filePath)} (HEAD ↔ Working Tree)`,
                  );
                  return;
                }
              }
            }
          } catch {
            // fall through to simple open
          }

          await vscode.window.showTextDocument(absUri, { preview: true });
          await vscode.commands.executeCommand("workbench.view.scm");
        })();
        return;
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
      registerChatUserSink(undefined);
      registerAgentStreamSink(undefined);
      registerRichChatSink(undefined);
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

    if (this.activeFlowCount > 0) {
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

    this.activeFlowCount += 1;
    this.activeFlowSource = "createPlan";
    w.postMessage({ type: "busy", busy: true, source: this.activeFlowSource });

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

      postAnimatedStatus(runId);

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
        postAgentStreamEnd(runId, endReason);
        streamActive = false;
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
      postRunFailure(runIdFromFlow(flowId), {
        phaseLabel: "Create plan",
        durationSec: 0,
        summary: stopped ? "Run stopped by user" : "Create plan failed",
        details: detail.slice(0, 2000),
        retryPrompt: userRequest,
      });
      this.transcript.push({ role: "system", text: `Create plan failed: ${detail.slice(0, 500)}` });
      w.postMessage({ type: "append", role: "system", text: `Create plan failed: ${detail.slice(0, 500)}` });
      if (stopped) {
        void vscode.window.showWarningMessage(`Planstack: ${detail.slice(0, 2000)}`);
      } else {
        void vscode.window.showErrorMessage(`Planstack: ${detail.slice(0, 2000)}`);
      }
    } finally {
      traceEvent(flowId, "createPlanFlow.finally", { createPlanInFlight_cleared: true });
      this.activeFlowCount = Math.max(0, this.activeFlowCount - 1);
      if (this.activeFlowCount === 0) {
        this.activeFlowSource = "";
      }
      w.postMessage({ type: "busy", busy: this.activeFlowCount > 0, source: this.activeFlowSource });
    }
  }

  private pushSystem(w: vscode.Webview, text: string): void {
    this.transcript.push({ role: "system", text });
    try {
      w.postMessage({ type: "append", role: "system", text });
    } catch {
      // Webview disposed.
    }
  }

  private async runSendPromptFlow(w: vscode.Webview, userPrompt: string): Promise<void> {
    const flowId = newTraceId("sendPromptFlow");
    traceEvent(flowId, "sendPromptFlow.start", { promptChars: userPrompt.length });
    traceMultiline(flowId, "sendPromptFlow.userPrompt", userPrompt);
    if (this.activeFlowCount > 0) {
      this.pushSystem(w, "Send is busy with another request. Please wait.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.pushSystem(w, "Send failed: open a workspace folder first.");
      return;
    }

    this.activeFlowCount += 1;
    this.activeFlowSource = "sendPrompt";
    w.postMessage({ type: "busy", busy: true, source: this.activeFlowSource });

    const cfg = vscode.workspace.getConfiguration("planstack.cursor");
    const streamToOutput = cfg.get<boolean>("cliStreamAgentOutput") ?? true;
    const chatThrottleMs = cfg.get<number>("cliStreamChatThrottleMs") ?? 25_000;
    const useLiveChat = cfg.get<boolean>("agentChatLiveStream") ?? true;
    const out = getOutput();
    out.show(true);
    out.appendLine(`\n=== Send prompt: agent run ${new Date().toISOString()} ===\n`);

    const runId = randomUUID();
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
      this.pushSystem(w, `${prefix}${t.slice(-220)}`);
    };

    try {
      this.pushSystem(w, "Send: starting Cursor CLI run (agent -p --trust --force)…");
      if (useLiveChat) {
        streamActive = true;
        postAgentStreamStart(runId, {
          label: "Send prompt",
          source: "sendPrompt",
        });
      }

      const result = await runAgentPromptEdits({
        extensionContext: this.extensionContext,
        workspaceRoot: folder.uri,
        prompt: userPrompt,
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
                  pushStreamChat("Send: ", text);
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
                  pushStreamChat("Send (stderr): ", last);
                }
              }
            : undefined,
      });

      if (result.exitCode !== 0) {
        const tail = result.stderr.trim() || result.stdout.slice(-400);
        throw new AgentCliError(
          `agent exited with code ${result.exitCode}. ${tail ? `Details: ${tail}` : ""}`.trim(),
          result.exitCode,
          result.stderr,
        );
      }

      const saidNoChanges = /no changes|no files? (were )?modified|nothing to (edit|change)/i.test(
        result.stdout,
      );
      this.pushSystem(
        w,
        saidNoChanges
          ? "Send completed: Cursor reported no changes."
          : "Send completed: Cursor applied edits (check git diff / workspace changes).",
      );
      await this.onPlanSaved();
    } catch (e) {
      let detail = e instanceof Error ? e.message : String(e);
      if (e instanceof AgentCliError && e.stderr?.trim()) {
        detail = `${detail}\n${e.stderr.trim().slice(0, 800)}`;
      }
      const stopped = e instanceof AgentCliError && detail.includes("stopped");
      endReason = stopped ? "stopped" : "error";
      postRunFailure(runId, {
        phaseLabel: "Send prompt",
        durationSec: 0,
        summary: stopped ? "Run stopped by user" : "Send failed",
        details: detail.slice(0, 2000),
        retryPrompt: userPrompt,
      });
      this.pushSystem(w, `Send failed: ${detail.slice(0, 500)}`);
      if (e instanceof AgentRunBusyError) {
        void vscode.window.showWarningMessage(e.message);
      } else if (stopped) {
        void vscode.window.showWarningMessage(`Planstack: ${detail.slice(0, 2000)}`);
      } else {
        void vscode.window.showErrorMessage(`Planstack: ${detail.slice(0, 2000)}`);
      }
    } finally {
      if (streamActive) {
        postAgentStreamEnd(runId, endReason);
      }
      this.activeFlowCount = Math.max(0, this.activeFlowCount - 1);
      if (this.activeFlowCount === 0) {
        this.activeFlowSource = "";
      }
      w.postMessage({ type: "busy", busy: this.activeFlowCount > 0, source: this.activeFlowSource });
    }
  }
}

function runIdFromFlow(flowId: string): string {
  return `flow-${flowId}`;
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
      width: 100%;
      max-width: 100%;
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
      border: 1px solid rgba(127,127,127,0.22);
      border-radius: 8px;
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
    }
    .agent-stream-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.75em;
      opacity: 0.9;
      padding: 6px 8px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 55%, transparent);
      border-bottom: 1px solid rgba(127,127,127,0.18);
    }
    .agent-stream-header-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-stream-title {
      font-weight: 600;
      opacity: 0.95;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-stream-source {
      opacity: 0.72;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      font-size: 0.92em;
    }
    .agent-stream-status {
      font-size: 0.9em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-radius: 999px;
      padding: 2px 7px;
      border: 1px solid rgba(127,127,127,0.35);
      opacity: 0.95;
      flex-shrink: 0;
    }
    .agent-stream-status.live {
      color: var(--vscode-terminal-ansiBlue, var(--vscode-foreground));
      background: color-mix(in srgb, var(--vscode-terminal-ansiBlue) 22%, transparent);
    }
    .agent-stream-status.finished {
      color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground));
      background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 22%, transparent);
    }
    .agent-stream-status.error {
      color: var(--vscode-terminal-ansiRed, var(--vscode-foreground));
      background: color-mix(in srgb, var(--vscode-terminal-ansiRed) 22%, transparent);
    }
    .agent-stream-status.stopped {
      color: var(--vscode-terminal-ansiYellow, var(--vscode-foreground));
      background: color-mix(in srgb, var(--vscode-terminal-ansiYellow) 22%, transparent);
    }
    .agent-stream-toggle {
      border: 1px solid rgba(127,127,127,0.28);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.15));
      color: var(--vscode-foreground);
      font-size: 0.9em;
      line-height: 1;
      padding: 2px 6px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .agent-stream-toggle:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.24));
    }
    .agent-stream {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.82em;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: min(38vh, 300px);
      overflow-y: auto;
      padding: 8px 10px;
      margin: 0;
      background: var(--vscode-editor-background, rgba(0,0,0,0.2));
      border: 0;
    }
    .agent-stream-collapsed .agent-stream {
      display: none;
    }
    .agent-stream-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.72em;
      opacity: 0.76;
      padding: 5px 8px;
      border-top: 1px solid rgba(127,127,127,0.14);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent);
    }
    /* Animated status (cooking phrases) */
    .animated-status-bubble {
      display: flex; align-items: center; gap: 6px;
      font-style: italic; opacity: 0.8;
    }
    .animated-spinner {
      font-family: var(--vscode-editor-font-family);
      font-size: 1em; min-width: 1ch; display: inline-block;
    }
    .animated-phrase { transition: opacity 0.25s ease; }
    /* Run summary card */
    .run-summary-row { width: 100%; max-width: 100%; align-self: stretch; }
    .run-summary-card {
      background: var(--vscode-editor-background, rgba(0,0,0,0.15));
      border: 1px solid rgba(127,127,127,0.25);
      border-radius: 8px; padding: 10px 12px; font-size: 0.88em;
      width: 100%;
    }
    .run-summary-header { font-weight: 600; margin-bottom: 3px; }
    .run-summary-stats { opacity: 0.7; font-size: 0.9em; margin-bottom: 8px; }
    .run-summary-files {
      display: flex; flex-direction: column; gap: 3px;
      border-top: 1px solid rgba(127,127,127,0.15);
      padding-top: 6px; margin-bottom: 8px;
    }
    .run-summary-file-row {
      display: flex; align-items: center; gap: 6px; font-size: 0.88em;
    }
    .run-summary-file-path {
      flex: 1; font-family: var(--vscode-editor-font-family);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .run-summary-file-diff {
      white-space: nowrap; font-size: 0.85em; flex-shrink: 0;
    }
    .run-summary-file-diff-add {
      color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
    }
    .run-summary-file-diff-del {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
    }
    .run-summary-file-diff-sep { opacity: 0.7; }
    .run-summary-diff-btn {
      flex-shrink: 0; padding: 1px 6px; cursor: pointer; font-size: 0.78em;
      border: 1px solid rgba(127,127,127,0.3); border-radius: 3px;
      background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.15));
      color: var(--vscode-foreground); white-space: nowrap;
    }
    .run-summary-diff-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.25));
    }
    .run-summary-scm-btn {
      display: block; width: 100%; padding: 5px 0; cursor: pointer;
      font-size: 0.82em; text-align: center;
      border: 1px solid rgba(127,127,127,0.25); border-radius: 4px;
      background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.15));
      color: var(--vscode-foreground);
    }
    .run-summary-scm-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.25));
    }
    .run-failure-card {
      border-color: color-mix(in srgb, var(--vscode-terminal-ansiRed, #f14c4c) 45%, rgba(127,127,127,0.25));
    }
    .run-failure-details {
      margin: 8px 0 10px;
      max-height: min(24vh, 200px);
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.82em;
      line-height: 1.35;
      border: 1px solid rgba(127,127,127,0.2);
      border-radius: 6px;
      background: var(--vscode-editor-background, rgba(0,0,0,0.2));
      padding: 8px 9px;
    }
    .run-failure-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .run-separator-row {
      width: 100%;
      margin-top: 10px;
      margin-bottom: 4px;
    }
    .run-separator {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      opacity: 0.78;
      font-size: 0.74em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .run-separator-line {
      flex: 1;
      height: 1px;
      background: rgba(127,127,127,0.24);
    }
    .run-separator-label {
      white-space: nowrap;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="hint">Use <strong>Create plan</strong> for new <code>.planstack/plans/&lt;id&gt;.json</code> files. Use <strong>Send</strong> for freeform edits via headless Cursor CLI. Live output appears below and in <strong>Output → Planstack</strong>. One run at a time; <strong>Stop agents</strong> sends SIGTERM.</div>
  <div id="messages" aria-live="polite"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Ask Cursor to edit the codebase..." aria-label="Message"></textarea>
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
