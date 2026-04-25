import * as vscode from "vscode";

export const SIDEBAR_WEBVIEW_ID = "hackupc.planstack.ui";

export class PlanstackSidebarWebview implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastPlanCount = 0;

  constructor(private readonly extUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: false,
      localResourceRoots: [this.extUri],
    };
    this.render(this.lastPlanCount);
  }

  /** Update the simple summary when plans are refreshed (optional). */
  setPlanCount(count: number): void {
    this.lastPlanCount = count;
    this.render(count);
  }

  private render(planCount: number): void {
    if (!this.view) {
      return;
    }
    const w = this.view.webview;
    w.html = getHtml(planCount);
  }
}

function getHtml(planCount: number): string {
  const plansLine =
    planCount === 0
      ? "No plan files loaded yet. Add <code>.planstack/plans/*.json</code> to the workspace."
      : `${planCount} plan file(s) in <code>.planstack/plans/</code>.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 0 12px 12px;
      line-height: 1.45;
    }
    h1 { font-size: 1.1em; font-weight: 600; margin: 10px 0 8px; }
    p { margin: 0 0 8px; }
    code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  </style>
</head>
<body>
  <h1>Planstack</h1>
  <p>Simple orchestration sidebar (more UI later).</p>
  <p>${plansLine}</p>
  <p>Use <strong>Plans</strong> (above <strong>Chat</strong>) to browse phases and run handoff.</p>
</body>
</html>`;
}
