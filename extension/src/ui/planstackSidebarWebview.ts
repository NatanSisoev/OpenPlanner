import * as vscode from "vscode";
import type { Plan } from "../plan/types";
import type { ExecutionState } from "../plan/types";

export const SIDEBAR_WEBVIEW_ID = "hackupc.planstack.ui";

export class PlanstackSidebarWebview implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private plans: Plan[] = [];
  private taskDetailsPanel?: vscode.WebviewPanel;
  private phaseDetailsPanel?: vscode.WebviewPanel;
  private planDetailsPanel?: vscode.WebviewPanel;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly onRunPhase: (planId: string, phaseId: string) => void,
    private readonly onUpdatePhase: (planId: string, phaseId: string, patch: { state?: ExecutionState }) => Promise<boolean>,
    private readonly onUpdateTask: (
      planId: string,
      phaseId: string,
      taskId: string,
      patch: { state?: ExecutionState; desc?: string; prompt?: string; commit?: boolean },
    ) => Promise<boolean>,
    private readonly onReorderPlans: (orderedPlanIds: string[]) => Promise<void>,
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
      const m = msg as {
        type?: string;
        planId?: string;
        phaseId?: string;
        taskId?: string;
        state?: ExecutionState;
        desc?: string;
        prompt?: string;
        commit?: boolean;
        orderedPlanIds?: string[];
      };
      if (m.type === "runPhase" && m.planId && m.phaseId) {
        this.onRunPhase(m.planId, m.phaseId);
      }
      if (m.type === "updatePhase" && m.planId && m.phaseId) {
        void this.onUpdatePhase(m.planId, m.phaseId, { state: m.state });
      }
      if (m.type === "reorderPlans" && Array.isArray(m.orderedPlanIds)) {
        void this.onReorderPlans(m.orderedPlanIds);
      }
      if (m.type === "openTaskDetails" && m.planId && m.phaseId && m.taskId) {
        void this.openTaskDetails(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "openPhaseDetails" && m.planId && m.phaseId) {
        void this.openPhaseDetails(m.planId, m.phaseId);
      }
      if (m.type === "openPlanDetails" && m.planId) {
        void this.openPlanDetails(m.planId);
      }
      if (m.type === "updateTask" && m.planId && m.phaseId && m.taskId) {
        void this.onUpdateTask(m.planId, m.phaseId, m.taskId, {
          state: m.state,
          desc: m.desc,
          prompt: m.prompt,
          commit: m.commit,
        });
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

  private async openTaskDetails(planId: string, phaseId: string, taskId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    const task = phase?.tasks?.find((t) => t.id === taskId);

    if (!plan || !phase || !task) {
      void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
      return;
    }

    const title = `Task: ${task.desc}`;
    if (this.taskDetailsPanel) {
      this.taskDetailsPanel.title = title;
      this.taskDetailsPanel.webview.html = getTaskDetailsHtml(plan, phase, task);
      this.taskDetailsPanel.reveal(vscode.ViewColumn.Active, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "hackupc.planstack.taskDetails",
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: false },
    );
    panel.webview.html = getTaskDetailsHtml(plan, phase, task);
    panel.onDidDispose(() => {
      if (this.taskDetailsPanel === panel) {
        this.taskDetailsPanel = undefined;
      }
    });
    this.taskDetailsPanel = panel;
  }

  private async openPhaseDetails(planId: string, phaseId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);

    if (!plan || !phase) {
      void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
      return;
    }

    const title = `Phase: ${phase.title}`;
    if (this.phaseDetailsPanel) {
      this.phaseDetailsPanel.title = title;
      this.phaseDetailsPanel.webview.html = getPhaseDetailsHtml(plan, phase);
      this.phaseDetailsPanel.reveal(vscode.ViewColumn.Active, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "hackupc.planstack.phaseDetails",
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: false },
    );
    panel.webview.html = getPhaseDetailsHtml(plan, phase);
    panel.onDidDispose(() => {
      if (this.phaseDetailsPanel === panel) {
        this.phaseDetailsPanel = undefined;
      }
    });
    this.phaseDetailsPanel = panel;
  }

  private async openPlanDetails(planId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) {
      void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
      return;
    }

    const title = `Plan: ${plan.title}`;
    if (this.planDetailsPanel) {
      this.planDetailsPanel.title = title;
      this.planDetailsPanel.webview.html = getPlanDetailsHtml(plan);
      this.planDetailsPanel.reveal(vscode.ViewColumn.Active, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "hackupc.planstack.planDetails",
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: false },
    );
    panel.webview.html = getPlanDetailsHtml(plan);
    panel.onDidDispose(() => {
      if (this.planDetailsPanel === panel) {
        this.planDetailsPanel = undefined;
      }
    });
    this.planDetailsPanel = panel;
  }
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

    .view-switcher {
      display: flex;
      gap: 6px;
      padding: 4px 8px 8px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-sideBar-background);
    }
    .view-btn {
      font: inherit;
      font-size: 0.78em;
      border-radius: 999px;
      border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.35));
      background: transparent;
      color: var(--vscode-foreground);
      padding: 3px 10px;
      cursor: pointer;
      opacity: 0.8;
    }
    .view-btn:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.15));
    }
    .view-btn.active {
      opacity: 1;
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0e70c0);
      border-color: transparent;
    }

    .nodes-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      padding: 4px 8px 8px;
    }
    .plan-node {
      min-height: 62px;
      border-radius: 999px;
      border: 2px solid var(--c-pending);
      background: var(--c-card-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 8px 12px;
    }
    .plan-node.tone-failed { border-color: var(--c-failed); box-shadow: 0 0 0 1px rgba(244,71,71,0.2) inset; }
    .plan-node.tone-completed { border-color: var(--c-done); box-shadow: 0 0 0 1px rgba(78,201,176,0.2) inset; }
    .plan-node.tone-in_progress { border-color: var(--c-running); box-shadow: 0 0 0 1px rgba(86,156,214,0.2) inset; }
    .plan-node.tone-pending { border-color: var(--c-pending); }
    .node-name {
      font-size: 0.88em;
      font-weight: 600;
      line-height: 1.35;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

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
    .plan-header:hover .run-btn { opacity: 1; }
    .plan-header.drag-over { outline: 1px dashed rgba(86,156,214,0.6); outline-offset: -2px; }
    .plan-header.dragging { opacity: 0.65; }

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

function htmlEscape(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getTaskDetailsHtml(plan: Plan, phase: Plan["phases"][number], task: Plan["phases"][number]["tasks"][number]): string {
  const prompt = task.prompt?.trim() ?? "";
  const promptBlock = prompt
    ? `<div class="section">
         <div class="label">Prompt</div>
         <pre>${htmlEscape(prompt)}</pre>
       </div>`
    : `<div class="section subtle">No prompt provided for this task.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 14px 16px 18px;
    }
    .h1 { font-size: 1.1em; font-weight: 700; margin: 0 0 10px; }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 10px;
      padding: 10px 12px;
      border: 1px solid rgba(127,127,127,0.25);
      border-radius: 8px;
      background: rgba(127,127,127,0.08);
    }
    .k { opacity: 0.7; }
    .v { word-break: break-word; }
    .section { margin-top: 12px; }
    .label { font-weight: 700; margin-bottom: 6px; opacity: 0.9; }
    pre {
      margin: 0;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(127,127,127,0.25);
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.45;
    }
    .subtle { opacity: 0.7; }
    code { font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <div class="h1">${htmlEscape(task.desc)}</div>
  <div class="meta">
    <div class="k">Plan</div><div class="v">${htmlEscape(plan.title)} <span class="subtle">(<code>${htmlEscape(plan.id)}</code>)</span></div>
    <div class="k">Phase</div><div class="v">${htmlEscape(phase.title)} <span class="subtle">(<code>${htmlEscape(phase.id)}</code>)</span></div>
    <div class="k">Task</div><div class="v"><code>${htmlEscape(task.id)}</code></div>
    <div class="k">State</div><div class="v"><code>${htmlEscape(task.state)}</code></div>
    <div class="k">Commit</div><div class="v"><code>${task.commit ? "true" : "false"}</code></div>
  </div>
  ${promptBlock}
</body>
</html>`;
}

function getPhaseDetailsHtml(plan: Plan, phase: Plan["phases"][number]): string {
  const tasks = phase.tasks ?? [];
  const tasksMarkup = tasks.length
    ? `<ul>${tasks
        .map(
          (task) =>
            `<li>
              <div><strong>${htmlEscape(task.desc)}</strong></div>
              <div class="subtle"><code>${htmlEscape(task.id)}</code> · <code>${htmlEscape(task.state)}</code> · commit=<code>${task.commit ? "true" : "false"}</code></div>
            </li>`,
        )
        .join("")}</ul>`
    : `<div class="subtle">This phase has no tasks.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 14px 16px 18px;
    }
    .h1 { font-size: 1.1em; font-weight: 700; margin: 0 0 10px; }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 10px;
      padding: 10px 12px;
      border: 1px solid rgba(127,127,127,0.25);
      border-radius: 8px;
      background: rgba(127,127,127,0.08);
    }
    .k { opacity: 0.7; }
    .v { word-break: break-word; }
    .section { margin-top: 12px; }
    ul { margin: 8px 0 0; padding-left: 18px; }
    li { margin-bottom: 8px; }
    .subtle { opacity: 0.75; }
    code { font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <div class="h1">${htmlEscape(phase.title)}</div>
  <div class="meta">
    <div class="k">Plan</div><div class="v">${htmlEscape(plan.title)} <span class="subtle">(<code>${htmlEscape(plan.id)}</code>)</span></div>
    <div class="k">Phase</div><div class="v"><code>${htmlEscape(phase.id)}</code></div>
    <div class="k">State</div><div class="v"><code>${htmlEscape(phase.state)}</code></div>
    <div class="k">Description</div><div class="v">${htmlEscape(phase.description)}</div>
    <div class="k">Tasks</div><div class="v"><code>${tasks.length}</code></div>
  </div>
  <div class="section">
    <div><strong>Tasks in this phase</strong></div>
    ${tasksMarkup}
  </div>
</body>
</html>`;
}

function getPlanDetailsHtml(plan: Plan): string {
  const phases = plan.phases ?? [];
  const tasks = phases.flatMap((ph) => ph.tasks ?? []);
  const donePhases = phases.filter((p) => p.state === "completed").length;
  const doneTasks = tasks.filter((t) => t.state === "completed").length;
  const desc = (plan as { description?: unknown }).description;
  const createdAt = (plan as { createdAt?: unknown }).createdAt;
  const createdAtLabel = createdAt ? new Date(String(createdAt)).toISOString() : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 14px 16px 18px;
    }
    .h1 { font-size: 1.1em; font-weight: 700; margin: 0 0 10px; }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 10px;
      padding: 10px 12px;
      border: 1px solid rgba(127,127,127,0.25);
      border-radius: 8px;
      background: rgba(127,127,127,0.08);
    }
    .k { opacity: 0.7; }
    .v { word-break: break-word; }
    .section { margin-top: 12px; }
    ul { margin: 8px 0 0; padding-left: 18px; }
    li { margin-bottom: 8px; }
    .subtle { opacity: 0.75; }
    code { font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <div class="h1">${htmlEscape(plan.title)}</div>
  <div class="meta">
    <div class="k">Plan</div><div class="v"><code>${htmlEscape(plan.id)}</code></div>
    <div class="k">State</div><div class="v"><code>${htmlEscape(plan.state)}</code></div>
    <div class="k">Description</div><div class="v">${desc ? htmlEscape(desc) : `<span class="subtle">—</span>`}</div>
    <div class="k">CreatedAt</div><div class="v">${createdAtLabel ? `<code>${htmlEscape(createdAtLabel)}</code>` : `<span class="subtle">—</span>`}</div>
    <div class="k">Phases</div><div class="v"><code>${phases.length}</code> · completed <code>${donePhases}</code></div>
    <div class="k">Tasks</div><div class="v"><code>${tasks.length}</code> · completed <code>${doneTasks}</code></div>
  </div>
</body>
</html>`;
}
