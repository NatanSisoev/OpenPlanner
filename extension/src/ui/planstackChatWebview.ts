import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { getOutput, logLine } from "../log";
import { AgentCliError, AgentRunBusyError, killAllAgentCliProcesses } from "../plan/agentCliRunner";
import { createPlanFromUserRequest, runAgentPromptEdits } from "../plan/createPlanFromCli";
import { getActiveExecutorProfileId } from "../plan/executorConfig";
import type { ExecutorProfileId } from "../plan/executorProfiles";
import { getPlanningMode } from "../plan/modes";
import { buildPromptWithMentions, findChatMentionSuggestions } from "./chatFileMentions";
import {
  postAgentStreamChunk,
  postAgentStreamEnd,
  postAgentStreamStart,
  registerAgentStreamSink,
  type AgentStreamEndReason,
} from "./agentChatStreamBridge";
import { registerChatSystemSink, registerChatUserSink } from "./chatStatusBridge";
import { PS_TOKENS_CSS } from "./planstackSidebarWebview";
import { postAnimatedStatus, postRunFailure, registerRichChatSink } from "./richChatBridge";
import { PS_RUN_UI } from "./runUiStrings";

export const CHAT_WEBVIEW_ID = "hackupc.planstack.chat";
const CHAT_TRANSCRIPT_KEY = "planstack.chatTranscript";
const MAX_PERSISTED_TURNS = 200;

function executorCreatePlanStartChatLine(): string {
  const head = PS_RUN_UI.chatStreamCreatePlan;
  return getActiveExecutorProfileId() === "junie-cli"
    ? `${head}: starting Junie CLI…`
    : `${head}: starting Cursor agent CLI (read-only print mode)…`;
}

function executorSendStartChatLine(): string {
  const head = PS_RUN_UI.chatStreamSendPrompt;
  return getActiveExecutorProfileId() === "junie-cli"
    ? `${head}: starting Junie CLI…`
    : `${head}: starting Cursor agent CLI (may edit workspace)…`;
}

function executorProfileLogSuffix(): string {
  return getActiveExecutorProfileId() === "junie-cli" ? "junie-cli" : "cursor-agent-cli";
}

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

type ChatTurn = { role: ChatRole; text: string; timestampIso: string };

function nowIso(): string {
  return new Date().toISOString();
}

export class PlanstackChatWebview implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly transcript: ChatTurn[];
  private persistTimer?: ReturnType<typeof setTimeout>;
  private activeFlowCount = 0;
  private activeFlowSource: "createPlan" | "sendPrompt" | "" = "";
  private configSubscription?: vscode.Disposable;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly onPlanSaved: () => Promise<void>,
  ) {
    const stored = this.extensionContext.workspaceState.get<ChatTurn[]>(CHAT_TRANSCRIPT_KEY);
    this.transcript = Array.isArray(stored) ? stored.slice(-MAX_PERSISTED_TURNS) : [];
  }

  private schedulePersistTranscript(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const tail = this.transcript.slice(-MAX_PERSISTED_TURNS);
      void this.extensionContext.workspaceState.update(CHAT_TRANSCRIPT_KEY, tail);
    }, 500);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this.configSubscription?.dispose();
    this.configSubscription = undefined;
    const w = webviewView.webview;
    w.options = {
      enableScripts: true,
      localResourceRoots: [this.extUri],
    };

    const labelsUri = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, "media", "planstackRunLabels.js"));
    const scriptUri = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, "media", "planstackChat.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src ${w.cspSource}`,
    ].join("; ");

    w.html = getChatHtml(csp, labelsUri, scriptUri);

    // Send init synchronously BEFORE registering sinks. The webview queue is
    // FIFO, so any sink-driven `append` messages enqueued during the rest of
    // this function arrive after init and won't be wiped by its history reset.
    try {
      w.postMessage({
        type: "init",
        messages: [...this.transcript],
        executorProfile: getActiveExecutorProfileId(),
      });
    } catch {
      // Webview may already be disposed.
    }

    const pushSystem = (text: string): void => {
      const timestampIso = nowIso();
      this.transcript.push({ role: "system", text, timestampIso });
      this.schedulePersistTranscript();
      try {
        w.postMessage({ type: "append", role: "system", text, timestampIso });
      } catch {
        // Webview disposed.
      }
    };
    const pushUser = (text: string): void => {
      const timestampIso = nowIso();
      this.transcript.push({ role: "user", text, timestampIso });
      this.schedulePersistTranscript();
      try {
        w.postMessage({ type: "append", role: "user", text, timestampIso });
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
      const m = msg as { type?: string; text?: string; requestId?: string; query?: string };
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
        pushUser(text);
        void (async () => {
          try {
            const mentionCtx = await this.resolveMentionContext(w, text, "send");
            await this.runSendPromptFlow(w, text, mentionCtx.promptForAgent);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logLine(`chat.send.flow_error: ${msg}`);
            pushSystem(`Send failed: ${msg.slice(0, 400)}`);
          }
        })();
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
        pushUser(text);
        void (async () => {
          try {
            const mentionCtx = await this.resolveMentionContext(w, text, "createPlan");
            await this.runCreatePlanFlow(w, text, mentionCtx.promptForAgent);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logLine(`chat.createPlan.flow_error: ${msg}`);
            pushSystem(`Create plan failed: ${msg.slice(0, 400)}`);
          }
        })();
        return;
      }
      if (m.type === "mentionSuggest" && typeof m.requestId === "string" && typeof m.query === "string") {
        const requestId = m.requestId;
        const rawQuery = m.query;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          w.postMessage({ type: "mentionSuggestResult", requestId, suggestions: [] });
          return;
        }
        void (async () => {
          let suggestions: Awaited<ReturnType<typeof findChatMentionSuggestions>> = [];
          try {
            suggestions = await findChatMentionSuggestions(folder.uri, { rawQuery, limit: 12 });
          } catch {
            suggestions = [];
          }
          try {
            w.postMessage({ type: "mentionSuggestResult", requestId, suggestions });
          } catch {
            // Webview disposed.
          }
        })();
        return;
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
          pushUser(text);
          void (async () => {
            try {
              const mentionCtx = await this.resolveMentionContext(w, text, "send");
              await this.runSendPromptFlow(w, text, mentionCtx.promptForAgent);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logLine(`chat.retryPrompt.flow_error: ${msg}`);
              pushSystem(`Retry failed: ${msg.slice(0, 400)}`);
            }
          })();
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
        pushSystem(line);
        void vscode.window.showInformationMessage(`Planstack: ${line}`);
        return;
      }
      if (m.type === "setExecutorProfile" && typeof (m as { profile?: unknown }).profile === "string") {
        const profile = (m as { profile: string }).profile.trim() as ExecutorProfileId;
        if (profile === "cursor-agent-cli" || profile === "junie-cli") {
          void vscode.workspace
            .getConfiguration("planstack.executor")
            .update("activeProfile", profile, vscode.ConfigurationTarget.Workspace);
          traceEvent(recvId, "chat.setExecutorProfile", { profile });
        }
        return;
      }
      traceEvent(recvId, "chat.onDidReceiveMessage.unhandled", { type: m.type });
    });
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration("planstack.executor.activeProfile") &&
        !e.affectsConfiguration("planstack.cursor.activeProfile")
      ) {
        return;
      }
      try {
        w.postMessage({ type: "executorProfile", profile: getActiveExecutorProfileId() });
      } catch {
        /* webview disposed */
      }
    });
    const disposeChat = webviewView.onDidDispose(() => {
      registerChatSystemSink(undefined);
      registerChatUserSink(undefined);
      registerAgentStreamSink(undefined);
      registerRichChatSink(undefined);
      this.configSubscription?.dispose();
      this.configSubscription = undefined;
      sub.dispose();
      disposeChat.dispose();
    });

  }

  private async resolveMentionContext(
    w: vscode.Webview,
    userPrompt: string,
    flowKind: "send" | "createPlan",
  ): Promise<{ promptForAgent: string }> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return { promptForAgent: userPrompt };
    }
    const flowLabel = flowKind === "createPlan" ? PS_RUN_UI.chatStreamCreatePlan : PS_RUN_UI.chatStreamSendPrompt;
    const ctx = await buildPromptWithMentions(folder.uri, userPrompt);
    const attachedParts: string[] = [];
    if (ctx.files.length > 0) {
      attachedParts.push(
        `${ctx.files.length} file(s): ${ctx.files.map((f) => f.displayPath).join(", ")}`,
      );
    }
    if (ctx.folders.length > 0) {
      attachedParts.push(
        `${ctx.folders.length} folder(s): ${ctx.folders.map((f) => `${f.displayPath}/`).join(", ")}`,
      );
    }
    if (ctx.plans.length > 0) {
      attachedParts.push(
        `${ctx.plans.length} plan(s): ${ctx.plans.map((p) => p.title).join(", ")}`,
      );
    }
    if (ctx.phases.length > 0) {
      attachedParts.push(
        `${ctx.phases.length} phase(s): ${ctx.phases.map((p) => `@${p.raw}`).join(", ")}`,
      );
    }
    if (ctx.tasks.length > 0) {
      attachedParts.push(
        `${ctx.tasks.length} task(s): ${ctx.tasks.map((t) => `@${t.raw}`).join(", ")}`,
      );
    }
    if (ctx.symbols.length > 0) {
      attachedParts.push(
        `${ctx.symbols.length} symbol(s): ${ctx.symbols
          .map((s) => `${s.name} [${s.kindLabel}] @ ${s.filePath}:${s.startLine}`)
          .join(", ")}`,
      );
    }
    if (attachedParts.length > 0) {
      this.pushSystem(w, `${flowLabel}: attached ${attachedParts.join("; ")}`);
    }
    if (ctx.errors.length > 0) {
      const detail = ctx.errors
        .slice(0, 8)
        .map((e) => `@${e.mention}: ${e.reason}`)
        .join(" | ");
      this.pushSystem(w, `${flowLabel}: skipped some @ mentions - ${detail}`);
    }
    return { promptForAgent: ctx.promptForAgent };
  }

  private async runCreatePlanFlow(
    w: vscode.Webview,
    userRequest: string,
    promptForAgent: string = userRequest,
  ): Promise<void> {
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
      this.pushSystem(w, executorCreatePlanStartChatLine());

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
      out.appendLine(
        `\n=== ${PS_RUN_UI.chatStreamCreatePlan}: CLI run (${executorProfileLogSuffix()}) ${new Date().toISOString()} ===\n`,
      );

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
        this.pushSystem(w, line);
      };

      try {
        if (useLiveChat) {
          streamActive = true;
          postAgentStreamStart(runId, {
            label: PS_RUN_UI.chatStreamCreatePlan,
            source: "createPlan",
          });
        }
        traceEvent(flowId, "createPlanFlow.calling_createPlanFromUserRequest", {
          debugTraceId: flowId,
          workspaceRoot: folder.uri.fsPath,
          promptForAgentChars: promptForAgent.length,
        });
        const { savedUri } = await createPlanFromUserRequest({
          extensionContext: this.extensionContext,
          workspaceRoot: folder.uri,
          userRequest: promptForAgent,
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
                    pushStreamChat(`${PS_RUN_UI.chatStreamCreatePlan}: `, text);
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
                    pushStreamChat(`${PS_RUN_UI.chatStreamCreatePlan} (stderr): `, last);
                  }
                }
              : undefined,
        });
        const rel = vscode.workspace.asRelativePath(savedUri);
        traceEvent(flowId, "createPlanFlow.success", { savedUri: savedUri.fsPath, rel });
        const line = `Saved plan file: ${rel}`;
        this.pushSystem(w, line);
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
        const line = `${PS_RUN_UI.chatStreamCreatePlan} skipped: ${e.message}`;
        this.pushSystem(w, line);
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
        phaseLabel: PS_RUN_UI.chatStreamCreatePlan,
        durationSec: 0,
        summary: stopped ? "Run stopped by user" : `${PS_RUN_UI.chatStreamCreatePlan} failed`,
        details: detail.slice(0, 2000),
        retryPrompt: userRequest,
      });
      this.pushSystem(w, `${PS_RUN_UI.chatStreamCreatePlan} failed: ${detail.slice(0, 500)}`);
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
    const timestampIso = nowIso();
    this.transcript.push({ role: "system", text, timestampIso });
    try {
      w.postMessage({ type: "append", role: "system", text, timestampIso });
    } catch {
      // Webview disposed.
    }
  }

  private async runSendPromptFlow(
    w: vscode.Webview,
    userPrompt: string,
    promptForAgent: string = userPrompt,
  ): Promise<void> {
    const flowId = newTraceId("sendPromptFlow");
    traceEvent(flowId, "sendPromptFlow.start", { promptChars: userPrompt.length });
    traceMultiline(flowId, "sendPromptFlow.userPrompt", userPrompt);
    if (this.activeFlowCount > 0) {
      this.pushSystem(w, `${PS_RUN_UI.chatStreamSendPrompt} is busy with another request. Please wait.`);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.pushSystem(w, `${PS_RUN_UI.chatStreamSendPrompt} failed: open a workspace folder first.`);
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
    out.appendLine(
      `\n=== ${PS_RUN_UI.chatStreamSendPrompt}: CLI run (${executorProfileLogSuffix()}) ${new Date().toISOString()} ===\n`,
    );

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
      this.pushSystem(w, executorSendStartChatLine());
      if (useLiveChat) {
        streamActive = true;
        postAgentStreamStart(runId, {
          label: PS_RUN_UI.chatStreamSendPrompt,
          source: "sendPrompt",
        });
      }

      const result = await runAgentPromptEdits({
        extensionContext: this.extensionContext,
        workspaceRoot: folder.uri,
        prompt: promptForAgent,
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
                  pushStreamChat(`${PS_RUN_UI.chatStreamSendPrompt}: `, text);
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
                  pushStreamChat(`${PS_RUN_UI.chatStreamSendPrompt} (stderr): `, last);
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
        phaseLabel: PS_RUN_UI.chatStreamSendPrompt,
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

function getChatHtml(csp: string, labelsUri: vscode.Uri, scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    ${PS_TOKENS_CSS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      display: flex; flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--ps-fg);
      background: var(--ps-bg);
    }
    .hint {
      font-size: var(--ps-t-sm); opacity: 0.55; padding: 8px 10px 6px; line-height: 1.5;
      border-bottom: 1px solid var(--ps-border);
    }
    .hint strong { opacity: 0.9; }
    .hint code { font-family: var(--vscode-editor-font-family); font-size: var(--ps-t-md); }
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
      border-radius: var(--ps-r-2);
      white-space: pre-wrap; word-break: break-word;
      line-height: 1.4; font-size: var(--ps-t-md);
    }
    .bubble-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble-meta {
      margin-top: 4px;
      font-size: var(--ps-t-xs);
      opacity: 0.55;
      text-align: right;
    }
    .row.system .bubble-meta {
      text-align: left;
    }
    .bubble.user {
      background: color-mix(
        in srgb,
        var(--vscode-input-background) 78%,
        var(--vscode-button-secondaryBackground, var(--ps-border-strong)) 22%
      );
      border: 1px solid color-mix(
        in srgb,
        var(--vscode-button-background, var(--vscode-focusBorder, var(--ps-c-accent))) 34%,
        var(--ps-border-strong)
      );
      border-bottom-right-radius: 2px;
    }
    .bubble.system {
      background: color-mix(
        in srgb,
        var(--vscode-editor-background) 84%,
        var(--vscode-textLink-foreground, var(--ps-c-accent)) 16%
      );
      border: 1px solid color-mix(
        in srgb,
        var(--vscode-textLink-foreground, var(--ps-c-accent)) 32%,
        var(--ps-border-strong)
      );
      border-bottom-left-radius: 2px;
      opacity: 0.9;
      width: 100%;
      max-width: 100%;
    }
    #composer {
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px 10px;
      border-top: 1px solid var(--ps-border);
    }
    #inputWrap { position: relative; }
    #input {
      width: 100%; min-height: 36px; max-height: 120px; resize: vertical;
      padding: 7px 9px;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--ps-border-strong);
      border-radius: var(--ps-r-1); outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder, var(--ps-c-accent)); }
    #mentionChips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      min-height: 2px;
    }
    .mention-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 7px;
      border-radius: var(--ps-r-pill);
      border: 1px solid var(--ps-border-strong);
      background: var(--vscode-button-secondaryBackground, var(--ps-bg-hover));
      font-size: var(--ps-t-xs);
      line-height: 1.5;
      font-family: var(--vscode-editor-font-family);
    }
    .mention-chip-kind {
      font-size: var(--ps-t-xs);
      padding: 0 5px;
      border-radius: var(--ps-r-2);
      background: var(--ps-border-strong);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mention-chip-plan .mention-chip-kind { background: var(--ps-fill-running); }
    .mention-chip-phase .mention-chip-kind { background: var(--ps-fill-running); }
    .mention-chip-task .mention-chip-kind { background: var(--ps-fill-done); }
    .mention-chip-symbol .mention-chip-kind { background: color-mix(in srgb, var(--ps-c-accent) 28%, transparent); }
    .mention-chip-folder .mention-chip-kind { background: color-mix(in srgb, var(--vscode-charts-yellow, var(--ps-c-accent)) 32%, transparent); }
    .mention-chip-label { white-space: nowrap; }
    .mention-chip-remove {
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      line-height: 1;
      font-size: var(--ps-t-md);
      opacity: 0.75;
      padding: 0;
    }
    .mention-chip-remove:hover { opacity: 1; }
    #mentionSuggest {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 4px);
      border: 1px solid var(--ps-border-strong);
      border-radius: var(--ps-r-2);
      overflow: hidden;
      background: var(--vscode-quickInput-background, var(--vscode-editor-background));
      z-index: 5;
      max-height: 180px;
      overflow-y: auto;
      display: none;
    }
    #mentionSuggest.show { display: block; }
    .mention-suggest-item {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      border: none;
      border-bottom: 1px solid var(--ps-border);
      background: transparent;
      color: var(--vscode-foreground);
      text-align: left;
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-sm);
      cursor: pointer;
    }
    .mention-suggest-item:last-child { border-bottom: none; }
    .mention-suggest-item:hover,
    .mention-suggest-item.active {
      background: var(--vscode-list-activeSelectionBackground, var(--ps-bg-hover));
    }
    .mention-suggest-kind {
      flex-shrink: 0;
      font-size: var(--ps-t-xs);
      padding: 1px 6px;
      border-radius: var(--ps-r-2);
      background: var(--ps-border-strong);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mention-suggest-plan .mention-suggest-kind { background: var(--ps-fill-running); }
    .mention-suggest-phase .mention-suggest-kind { background: var(--ps-fill-running); }
    .mention-suggest-task .mention-suggest-kind { background: var(--ps-fill-done); }
    .mention-suggest-symbol .mention-suggest-kind { background: color-mix(in srgb, var(--ps-c-accent) 28%, transparent); }
    .mention-suggest-folder .mention-suggest-kind { background: color-mix(in srgb, var(--vscode-charts-yellow, var(--ps-c-accent)) 32%, transparent); }
    .mention-suggest-label {
      flex-shrink: 0;
      font-family: var(--vscode-editor-font-family);
    }
    .mention-suggest-detail {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.75;
      font-size: var(--ps-t-md);
    }
    #composerActions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      margin-top: 6px;
    }
    .composerExecutor {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 0 1 auto;
      max-width: min(52%, 320px);
      font-size: var(--ps-t-md);
    }
    .composerExecutor label {
      color: var(--vscode-descriptionForeground, rgba(200, 200, 200, 0.85));
      white-space: nowrap;
      flex-shrink: 0;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .composerExecutor select {
      appearance: none;
      -webkit-appearance: none;
      min-width: 128px;
      max-width: min(220px, 40vw);
      height: 28px;
      padding: 0 30px 0 10px;
      font-size: var(--ps-t-md);
      font-family: var(--vscode-font-family);
      line-height: 26px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background-color: var(--vscode-dropdown-background, var(--vscode-input-background, rgba(255, 255, 255, 0.06)));
      border: 1px solid var(--vscode-dropdown-border, var(--ps-border-strong));
      border-radius: var(--ps-r-1);
      cursor: pointer;
      box-sizing: border-box;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23999' d='M2.5 4L6 7.5 9.5 4'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 9px center;
      background-size: 11px 11px;
    }
    .composerExecutor select:hover {
      border-color: var(--vscode-focusBorder, var(--ps-border-strong));
      background-color: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
    }
    .composerExecutor select:focus {
      outline: 1px solid var(--vscode-focusBorder, var(--ps-c-accent));
      outline-offset: -1px;
    }
    .composerActionButtons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      flex: 0 0 auto;
    }
    #send, #createPlan, #stopAgents {
      flex-shrink: 0; padding: 0 12px; height: 28px;
      cursor: pointer; font-size: var(--ps-t-md);
      border: none; border-radius: var(--ps-r-1); white-space: nowrap;
    }
    #createPlan {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    #createPlan:hover { background: var(--vscode-button-hoverBackground); }
    #send {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, var(--ps-bg-hover));
    }
    #send:hover { background: var(--vscode-button-secondaryHoverBackground, var(--ps-border-strong)); }
    #stopAgents {
      color: var(--vscode-foreground);
      background: var(--vscode-inputValidation-warningBackground, rgba(200, 140, 0, 0.25));
      border: 1px solid var(--ps-border-strong);
    }
    #stopAgents:hover { background: var(--vscode-inputValidation-warningBackground, rgba(200, 140, 0, 0.35)); }
    #send:disabled, #createPlan:disabled, #stopAgents:disabled, #input:disabled {
      opacity: 0.55; cursor: not-allowed;
    }
    .agent-stream-row {
      display: flex;
      flex-direction: column;
      max-width: 98%;
      width: 100%;
      align-self: stretch;
      border: 1px solid var(--ps-border-strong);
      border-radius: var(--ps-r-2);
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
    }
    .agent-stream-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: var(--ps-t-xs);
      opacity: 0.9;
      padding: 6px 8px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 55%, transparent);
      border-bottom: 1px solid var(--ps-border);
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
      opacity: 0.9;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-stream-source {
      opacity: 0.75;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      font-size: var(--ps-t-md);
    }
    .agent-stream-status {
      font-size: var(--ps-t-md);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-radius: var(--ps-r-pill);
      padding: 2px 7px;
      border: 1px solid var(--ps-border-strong);
      opacity: 0.9;
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
      border: 1px solid var(--ps-border-strong);
      border-radius: var(--ps-r-1);
      background: var(--vscode-button-secondaryBackground, var(--ps-border));
      color: var(--vscode-foreground);
      font-size: var(--ps-t-md);
      line-height: 1;
      padding: 2px 6px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .agent-stream-toggle:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--ps-border-strong));
    }
    .agent-stream {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-sm);
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: min(72vh, 760px);
      overflow-y: auto;
      padding: 8px 10px;
      margin: 0;
      background: var(--vscode-editor-background);
      border: 0;
    }
    .agent-stream strong { font-weight: 700; }
    .agent-stream code {
      font-family: var(--vscode-editor-font-family);
      background: color-mix(in srgb, var(--vscode-editor-background) 65%, var(--ps-border-strong));
      border: 1px solid var(--ps-border);
      border-radius: var(--ps-r-1);
      padding: 0 4px;
      font-size: var(--ps-t-md);
    }
    .agent-stream .agent-md-fence {
      display: block;
      white-space: pre-wrap;
      margin: 6px 0;
      padding: 8px;
      border-radius: var(--ps-r-2);
      border: 1px solid var(--ps-bg-hover);
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, rgba(0,0,0,0.18));
      font-family: var(--vscode-editor-font-family);
    }
    .agent-stream-collapsed .agent-stream {
      display: none;
    }
    .agent-stream-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: var(--ps-t-xs);
      opacity: 0.76;
      padding: 5px 8px;
      border-top: 1px solid var(--ps-border);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent);
    }
    /* Animated status (cooking phrases) */
    .animated-status-bubble {
      display: flex; align-items: center; gap: 6px;
      font-style: italic; opacity: 0.75;
    }
    .animated-spinner {
      font-family: var(--vscode-editor-font-family);
      font-size: 1em; min-width: 1ch; display: inline-block;
    }
    .animated-phrase { transition: opacity 0.25s ease; }
    /* Run summary card */
    .run-summary-row { width: 100%; max-width: 100%; align-self: stretch; }
    .run-summary-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--ps-border-strong);
      border-radius: var(--ps-r-2); padding: 10px 12px; font-size: var(--ps-t-md);
      width: 100%;
    }
    .run-summary-header {
      font-weight: 600; margin-bottom: 3px;
      display: inline-flex; align-items: center; gap: var(--ps-s-3);
    }
    .run-summary-header.is-ok { color: var(--ps-c-done); }
    .run-summary-header.is-failed { color: var(--ps-c-failed); }
    .run-summary-header-text { color: var(--ps-fg); }
    .ps-i { display: inline-flex; vertical-align: -2px; flex-shrink: 0; }
    .run-summary-stats {
      display: flex; align-items: baseline; flex-wrap: wrap; gap: 0;
      font-size: var(--ps-t-md); margin-bottom: 8px;
    }
    .run-summary-stats-prefix { opacity: 0.75; }
    .run-summary-files {
      display: flex; flex-direction: column; gap: 3px;
      border-top: 1px solid var(--ps-border);
      padding-top: 6px; margin-bottom: 8px;
    }
    .run-summary-file-row {
      display: flex; align-items: center; gap: 6px; font-size: var(--ps-t-md);
    }
    .run-summary-file-path {
      flex: 1; font-family: var(--vscode-editor-font-family);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .run-summary-file-diff {
      white-space: nowrap; font-size: var(--ps-t-md); flex-shrink: 0;
    }
    .run-summary-file-diff-add {
      color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
    }
    .run-summary-file-diff-del {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
    }
    .run-summary-file-diff-sep { opacity: 0.75; }
    .run-summary-diff-btn {
      flex-shrink: 0; padding: 1px 6px; cursor: pointer; font-size: var(--ps-t-xs);
      border: 1px solid var(--ps-border-strong); border-radius: var(--ps-r-1);
      background: var(--vscode-button-secondaryBackground, var(--ps-border));
      color: var(--vscode-foreground); white-space: nowrap;
    }
    .run-summary-diff-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--ps-border-strong));
    }
    .run-summary-scm-btn {
      display: block; width: 100%; padding: 5px 0; cursor: pointer;
      font-size: var(--ps-t-sm); text-align: center;
      border: 1px solid var(--ps-border-strong); border-radius: var(--ps-r-1);
      background: var(--vscode-button-secondaryBackground, var(--ps-border));
      color: var(--vscode-foreground);
    }
    .run-summary-scm-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--ps-border-strong));
    }
    .run-failure-card {
      border-color: color-mix(in srgb, var(--vscode-terminal-ansiRed, #f14c4c) 45%, var(--ps-border-strong));
    }
    .run-failure-details {
      margin: 8px 0 10px;
      max-height: min(24vh, 200px);
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-sm);
      line-height: 1.35;
      border: 1px solid var(--ps-bg-hover);
      border-radius: var(--ps-r-2);
      background: var(--vscode-editor-background);
      padding: 8px 9px;
    }
    .run-failure-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .run-separator-row {
      width: 100%;
      margin-top: 12px;
      margin-bottom: 8px;
    }
    .run-separator {
      width: 100%;
      min-height: 36px;
      padding: 8px 0;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      opacity: 0.75;
      font-size: var(--ps-t-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .run-separator-line {
      flex: 1;
      height: 1px;
      min-height: 1px;
      align-self: center;
      background: var(--ps-border-strong);
    }
    .run-separator-label {
      white-space: nowrap;
      font-weight: 600;
      line-height: 1.4;
      padding: 0 2px;
    }
  </style>
</head>
<body>
  <div class="hint"><strong>Create plan</strong> writes plan files, <strong>Send</strong> applies edits. Choose the <strong>CLI executor</strong> on the bottom row (left) for Create plan / Send / Run phase (<code>cli</code> mode). Tag with <strong>@file</strong>, <strong>@folder:path/to/dir</strong>, <strong>@plan:planId</strong>, <strong>@phase:planId/phaseId</strong>, <strong>@task:planId/phaseId/taskId</strong>, or <strong>@symbol:Name</strong>.</div>
  <div id="messages" aria-live="polite"></div>
  <div id="composer">
    <div id="inputWrap">
      <div id="mentionSuggest" aria-label="@file suggestions"></div>
      <textarea id="input" rows="2" placeholder="Ask the configured CLI agent to edit the codebase…" aria-label="Message"></textarea>
    </div>
    <div id="mentionChips" aria-label="@file mentions"></div>
    <div id="composerActions" role="toolbar" aria-label="Chat actions and executor">
      <div class="composerExecutor">
        <label for="executorProfile">Executor</label>
        <select id="executorProfile" aria-label="Headless CLI executor for Create plan and Send">
          <option value="cursor-agent-cli">Cursor CLI (agent)</option>
          <option value="junie-cli">Junie CLI</option>
        </select>
      </div>
      <div class="composerActionButtons">
        <button type="button" id="stopAgents">Stop agents</button>
        <button type="button" id="createPlan">Create plan</button>
        <button type="button" id="send">Send</button>
      </div>
    </div>
  </div>
  <script src="${labelsUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
