import * as vscode from "vscode";
import { AgentCliError } from "../plan/agentCliRunner";
import { createPlanFromUserRequest } from "../plan/createPlanFromCli";

export const CHAT_WEBVIEW_ID = "hackupc.planstack.chat";

const MAX_MESSAGE_CHARS = 8000;

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

    const sub = w.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== "object") {
        return;
      }
      const m = msg as { type?: string; text?: string };
      if (m.type === "send" && typeof m.text === "string") {
        let text = m.text.trim();
        if (!text) {
          return;
        }
        if (text.length > MAX_MESSAGE_CHARS) {
          text = text.slice(0, MAX_MESSAGE_CHARS);
        }
        this.transcript.push({ role: "user", text });
        w.postMessage({ type: "append", role: "user", text });
        return;
      }
      if (m.type === "createPlan" && typeof m.text === "string") {
        const text = m.text.trim();
        if (!text) {
          void vscode.window.showWarningMessage("Planstack: enter a request in the box before Create plan.");
          return;
        }
        void this.runCreatePlanFlow(w, text);
      }
    });
    webviewView.onDidDispose(() => sub.dispose());

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
    if (this.createPlanInFlight) {
      void vscode.window.showWarningMessage("Planstack: a plan is already being generated.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage("Planstack: open a workspace folder before creating a plan.");
      return;
    }

    this.createPlanInFlight = true;
    w.postMessage({ type: "busy", busy: true });

    try {
      const { savedUri } = await createPlanFromUserRequest({
        extensionContext: this.extensionContext,
        workspaceRoot: folder.uri,
        userRequest,
      });
      const rel = vscode.workspace.asRelativePath(savedUri);
      const line = `Saved plan file: ${rel}`;
      this.transcript.push({ role: "system", text: line });
      w.postMessage({ type: "append", role: "system", text: line });
      await this.onPlanSaved();
      void vscode.window.showInformationMessage(`Planstack: wrote ${rel}`);
      await vscode.window.showTextDocument(savedUri, { preview: true });
    } catch (e) {
      let detail = e instanceof Error ? e.message : String(e);
      if (e instanceof AgentCliError && e.stderr?.trim()) {
        detail = `${detail}\n${e.stderr.trim().slice(0, 800)}`;
      }
      void vscode.window.showErrorMessage(`Planstack: ${detail.slice(0, 2000)}`);
    } finally {
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
    #composerActions { display: flex; gap: 6px; justify-content: flex-end; }
    #send, #createPlan {
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
    #send:disabled, #createPlan:disabled, #input:disabled {
      opacity: 0.45; cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="hint">Use <strong>Create plan</strong> to run the Cursor CLI and write <code>.planstack/plans/&lt;id&gt;.json</code> (same schema as <code>seed/</code>). Ordinary Send stays local.</div>
  <div id="messages" aria-live="polite"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Describe the plan you want…" aria-label="Message"></textarea>
    <div id="composerActions">
      <button type="button" id="createPlan">Create plan</button>
      <button type="button" id="send">Send</button>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
