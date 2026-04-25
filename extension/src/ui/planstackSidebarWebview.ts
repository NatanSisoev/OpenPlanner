import * as vscode from "vscode";
import type { Plan } from "../plan/types";

export const SIDEBAR_WEBVIEW_ID = "hackupc.planstack.ui";

export class PlanstackSidebarWebview implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private plans: Plan[] = [];

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly onRunPhase: (planId: string, phaseId: string) => void,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    const w = webviewView.webview;
    w.options = {
      enableScripts: true,
      localResourceRoots: [this.extUri],
    };

    const scriptUri = w.asWebviewUri(
      vscode.Uri.joinPath(this.extUri, "media", "planstackSidebar.js"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src ${w.cspSource}`,
    ].join("; ");

    w.html = getSidebarHtml(csp, scriptUri);

    const sub = w.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== "object") {
        return;
      }
      const m = msg as { type?: string; planId?: string; phaseId?: string; taskId?: string; status?: string };
      if (m.type === "runPhase" && m.planId && m.phaseId) {
        this.onRunPhase(m.planId, m.phaseId);
      }
    });
    webviewView.onDidDispose(() => sub.dispose());

    const snapshot = this.plans;
    setTimeout(() => {
      try {
        w.postMessage({ type: "setPlans", plans: snapshot });
      } catch {
        // Webview may already be disposed.
      }
    }, 0);
  }

  setPlans(plans: Plan[]): void {
    this.plans = plans;
    try {
      this.view?.webview.postMessage({ type: "setPlans", plans });
    } catch {
      // Webview not ready yet.
    }
  }

  /** Backward-compatible shim. */
  setPlanCount(_count: number): void {}
}

function getSidebarHtml(csp: string, scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow-x: hidden;
    }

    :root {
      --c-done:        #4ec9b0;
      --c-running:     #569cd6;
      --c-failed:      #f44747;
      --c-cancelled:   #858585;
      --c-pending:     #6e6e6e;
      --c-border:      rgba(127,127,127,0.18);
      --c-hover:       var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
      --c-card-bg:     var(--vscode-editor-background, rgba(0,0,0,0.12));
      --c-header-bg:   var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.04));
    }

    #root { padding: 6px 0 16px; }

    /* ── Empty state ── */
    .empty-state {
      display: flex; flex-direction: column; align-items: center;
      padding: 40px 16px; gap: 10px; opacity: 0.55; text-align: center;
    }
    .empty-icon { font-size: 2.2em; }
    .empty-title { font-weight: 600; }
    .empty-hint { font-size: 0.82em; line-height: 1.5; }
    .empty-hint code { font-family: var(--vscode-editor-font-family); opacity: 0.8; }

    /* ── Plan card ── */
    .plan-card {
      margin: 4px 8px;
      border: 1px solid var(--c-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--c-card-bg);
    }

    .plan-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; cursor: pointer;
      background: var(--c-header-bg);
      border-bottom: 1px solid var(--c-border);
      gap: 8px; user-select: none;
    }
    .plan-header:hover { background: var(--c-hover); }

    .plan-header-left {
      display: flex; align-items: center; gap: 6px;
      flex: 1; min-width: 0;
    }
    .plan-title {
      font-weight: 600; font-size: 0.9em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .plan-header-right {
      display: flex; align-items: center; gap: 7px; flex-shrink: 0;
    }
    .plan-progress { font-size: 0.78em; opacity: 0.6; white-space: nowrap; }
    .progress-bar {
      width: 44px; height: 3px;
      background: rgba(127,127,127,0.25); border-radius: 2px; overflow: hidden;
    }
    .progress-fill {
      height: 100%; border-radius: 2px;
      background: var(--vscode-progressBar-background, #0e70c0);
      transition: width 0.3s ease;
    }

    /* ── Chevron ── */
    .chevron {
      font-size: 1em; display: inline-block; line-height: 1;
      transition: transform 0.15s ease; opacity: 0.55; flex-shrink: 0;
    }
    .chevron.expanded { transform: rotate(90deg); opacity: 0.85; }
    .chevron.sm { font-size: 0.85em; }
    .chevron-gap { display: inline-block; width: 13px; flex-shrink: 0; }

    /* ── Phases ── */
    .plan-phases { padding: 3px 0 4px; }

    .phase-row { margin: 1px 5px; border-radius: 4px; }

    .phase-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 7px; gap: 5px; border-radius: 4px;
    }
    .phase-header:hover { background: var(--c-hover); }
    .phase-header:hover .run-btn { opacity: 1; }

    .phase-header-left {
      display: flex; align-items: center; gap: 5px;
      flex: 1; min-width: 0; cursor: pointer; user-select: none;
    }
    .phase-status-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      box-shadow: 0 0 4px currentColor;
    }
    .dot-completed  { background: var(--c-done);      color: var(--c-done); }
    .dot-in_progress{ background: var(--c-running);  color: var(--c-running); }
    .dot-failed     { background: var(--c-failed);   color: var(--c-failed); }
    .dot-pending    { background: var(--c-pending);  color: var(--c-pending); box-shadow: none; }
    .dot-cancelled  { background: var(--c-cancelled);color: var(--c-cancelled); box-shadow: none; }

    .phase-title {
      font-size: 0.86em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .phase-header-right {
      display: flex; align-items: center; gap: 5px; flex-shrink: 0;
    }

    /* ── Status badge ── */
    .badge {
      font-size: 0.68em; padding: 1px 6px; border-radius: 10px;
      text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;
      white-space: nowrap;
    }
    .badge-completed  { background: rgba(78,201,176,0.13);  color: var(--c-done); }
    .badge-in_progress{ background: rgba(86,156,214,0.13);  color: var(--c-running);
                        animation: pulse-badge 2s infinite; }
    .badge-failed     { background: rgba(244,71,71,0.13);   color: var(--c-failed); }
    .badge-pending    { background: rgba(110,110,110,0.13); color: var(--c-pending); }
    .badge-cancelled  { background: rgba(133,133,133,0.1);  color: var(--c-cancelled); }

    @keyframes pulse-badge {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.65; }
    }

    /* ── Run button ── */
    .run-btn {
      font-size: 0.72em; padding: 2px 8px; height: 20px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.3));
      border-radius: 3px;
      background: var(--vscode-button-background, #0e70c0);
      color: var(--vscode-button-foreground, #fff);
      white-space: nowrap; opacity: 0; transition: opacity 0.1s, background 0.1s;
      display: flex; align-items: center; gap: 3px;
    }
    .run-btn:hover { background: var(--vscode-button-hoverBackground); }

    /* ── Tasks ── */
    .phase-tasks {
      padding: 2px 0 4px 14px;
      border-left: 1px solid var(--c-border);
      margin: 0 7px 0 17px;
    }

    .task-row {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 5px; border-radius: 3px; cursor: default;
    }
    .task-row:hover { background: var(--c-hover); }
    .task-row:hover .task-actions { opacity: 1; }

    .task-icon {
      font-size: 0.78em; width: 13px; text-align: center; flex-shrink: 0;
      line-height: 1;
    }
    .icon-completed  { color: var(--c-done); }
    .icon-in_progress{ color: var(--c-running); }
    .icon-failed     { color: var(--c-failed); }
    .icon-cancelled  { color: var(--c-cancelled); }
    .icon-pending    { color: var(--c-pending); }

    .task-title {
      font-size: 0.83em; flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      line-height: 1.4;
    }
    .task-title.strike { text-decoration: line-through; opacity: 0.45; }

    .task-actions {
      display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; flex-shrink: 0;
    }
    .task-btn {
      width: 18px; height: 18px; padding: 0; display: flex;
      align-items: center; justify-content: center; cursor: pointer;
      border-radius: 3px; font-size: 0.75em; border: none;
      background: transparent; line-height: 1;
    }
    .task-btn.done-btn  { color: var(--c-done); }
    .task-btn.done-btn:hover   { background: rgba(78,201,176,0.15); }
    .task-btn.run-task  { color: var(--c-running); }
    .task-btn.run-task:hover   { background: rgba(86,156,214,0.15); }
    .task-btn.cancel-btn{ color: var(--c-failed); }
    .task-btn.cancel-btn:hover { background: rgba(244,71,71,0.15); }
    .task-btn.reset-btn { color: var(--c-cancelled); }
    .task-btn.reset-btn:hover  { background: rgba(133,133,133,0.15); }
  </style>
</head>
<body>
  <div id="root">
    <div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">Loading plans…</div>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
