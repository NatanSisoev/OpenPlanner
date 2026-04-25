import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import type { Plan } from "../plan/types";
import type { ExecutionState } from "../plan/types";

export const SIDEBAR_WEBVIEW_ID = "hackupc.planstack.ui";

interface PlanstackSidebarCallbacks {
  onRunPhase: (planId: string, phaseId: string) => void;
  onUpdatePhase: (
    planId: string,
    phaseId: string,
    patch: { state?: ExecutionState; title?: string; description?: string },
  ) => Promise<boolean>;
  onUpdateTask: (
    planId: string,
    phaseId: string,
    taskId: string,
    patch: { state?: ExecutionState; desc?: string; prompt?: string; commit?: boolean },
  ) => Promise<boolean>;
  onUpdatePlan: (planId: string, patch: { title?: string; description?: string }) => Promise<boolean>;
  onCreatePlan: (input: { title: string; description?: string }) => Promise<void>;
  onCreatePhase: (input: { planId: string; title: string; description?: string }) => Promise<void>;
  onCreateTask: (input: {
    planId: string;
    phaseId: string;
    desc: string;
    prompt?: string;
    commit: boolean;
  }) => Promise<void>;
  onMergePlan: (planId: string) => Promise<void>;
  onReorderPlans: (orderedPlanIds: string[]) => Promise<void>;
}

export class PlanstackSidebarWebview implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private plans: Plan[] = [];
  private taskDetailsPanel?: vscode.WebviewPanel;
  private phaseDetailsPanel?: vscode.WebviewPanel;
  private planDetailsPanel?: vscode.WebviewPanel;
  private readonly onRunPhase: PlanstackSidebarCallbacks["onRunPhase"];
  private readonly onUpdatePhase: PlanstackSidebarCallbacks["onUpdatePhase"];
  private readonly onUpdateTask: PlanstackSidebarCallbacks["onUpdateTask"];
  private readonly onUpdatePlan: PlanstackSidebarCallbacks["onUpdatePlan"];
  private readonly onCreatePlan: PlanstackSidebarCallbacks["onCreatePlan"];
  private readonly onCreatePhase: PlanstackSidebarCallbacks["onCreatePhase"];
  private readonly onCreateTask: PlanstackSidebarCallbacks["onCreateTask"];
  private readonly onMergePlan: PlanstackSidebarCallbacks["onMergePlan"];
  private readonly onReorderPlans: PlanstackSidebarCallbacks["onReorderPlans"];
  private readonly promptEditors = new Map<
    string,
    { kind: "plan" | "phase"; planId: string; phaseId?: string }
  >();

  constructor(private readonly extUri: vscode.Uri, callbacks: PlanstackSidebarCallbacks) {
    this.onRunPhase = callbacks.onRunPhase;
    this.onUpdatePhase = callbacks.onUpdatePhase;
    this.onUpdateTask = callbacks.onUpdateTask;
    this.onUpdatePlan = callbacks.onUpdatePlan;
    this.onCreatePlan = callbacks.onCreatePlan;
    this.onCreatePhase = callbacks.onCreatePhase;
    this.onCreateTask = callbacks.onCreateTask;
    this.onMergePlan = callbacks.onMergePlan;
    this.onReorderPlans = callbacks.onReorderPlans;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.installPromptEditorListeners();
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
      const recvId = newTraceId("sidebarRecv");
      traceEvent(recvId, "sidebar.onDidReceiveMessage", {
        raw:
          typeof msg === "object" && msg !== null
            ? JSON.stringify(msg)
            : String(msg),
      });
      if (!msg || typeof msg !== "object") {
        traceEvent(recvId, "sidebar.onDidReceiveMessage.ignore", { reason: "not_object" });
        return;
      }
      const m = msg as {
        type?: string;
        planId?: string;
        phaseId?: string;
        taskId?: string;
        state?: ExecutionState;
        title?: string;
        description?: string;
        desc?: string;
        prompt?: string;
        commit?: boolean;
        orderedPlanIds?: string[];
      };
      if (m.type === "runPhase" && m.planId && m.phaseId) {
        traceEvent(recvId, "sidebar.runPhase", { planId: m.planId, phaseId: m.phaseId });
        this.onRunPhase(m.planId, m.phaseId);
      }
      if (m.type === "updatePhase" && m.planId && m.phaseId) {
        traceEvent(recvId, "sidebar.updatePhase", {
          planId: m.planId,
          phaseId: m.phaseId,
          state: m.state,
        });
        void this.onUpdatePhase(m.planId, m.phaseId, { state: m.state });
      }
      if (m.type === "reorderPlans" && Array.isArray(m.orderedPlanIds)) {
        traceEvent(recvId, "sidebar.reorderPlans", { orderedPlanIds: m.orderedPlanIds });
        void this.onReorderPlans(m.orderedPlanIds);
      }
      if (m.type === "mergePlan" && m.planId) {
        traceEvent(recvId, "sidebar.mergePlan", { planId: m.planId });
        void this.onMergePlan(m.planId);
      }
      if (m.type === "openTaskDetails" && m.planId && m.phaseId && m.taskId) {
        traceEvent(recvId, "sidebar.openTaskDetails", {
          planId: m.planId,
          phaseId: m.phaseId,
          taskId: m.taskId,
        });
        void this.openTaskDetails(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "openPhaseDetails" && m.planId && m.phaseId) {
        traceEvent(recvId, "sidebar.openPhaseDetails", { planId: m.planId, phaseId: m.phaseId });
        void this.openPhaseDetails(m.planId, m.phaseId);
      }
      if (m.type === "openPlanDetails" && m.planId) {
        void this.openPlanDetails(m.planId);
      }
      if (m.type === "renameTask" && m.planId && m.phaseId && m.taskId) {
        void this.renameTask(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "renamePhase" && m.planId && m.phaseId) {
        void this.renamePhase(m.planId, m.phaseId);
      }
      if (m.type === "renamePlan" && m.planId) {
        void this.renamePlan(m.planId);
      }
      if (m.type === "editPlanPrompt" && m.planId) {
        void this.editPlanPrompt(m.planId);
      }
      if (m.type === "editPhasePrompt" && m.planId && m.phaseId) {
        void this.editPhasePrompt(m.planId, m.phaseId);
      }
      if (m.type === "updateTask" && m.planId && m.phaseId && m.taskId) {
        traceEvent(recvId, "sidebar.updateTask.meta", {
          planId: m.planId,
          phaseId: m.phaseId,
          taskId: m.taskId,
          state: m.state,
          commit: m.commit,
          descChars: typeof m.desc === "string" ? m.desc.length : 0,
          promptChars: typeof m.prompt === "string" ? m.prompt.length : 0,
        });
        if (typeof m.desc === "string") {
          traceMultiline(recvId, "sidebar.updateTask.desc", m.desc);
        }
        if (typeof m.prompt === "string") {
          traceMultiline(recvId, "sidebar.updateTask.prompt", m.prompt);
        }
        void this.onUpdateTask(m.planId, m.phaseId, m.taskId, {
          state: m.state,
          desc: m.desc,
          prompt: m.prompt,
          commit: m.commit,
        });
      }
      if (m.type === "createPlan" && typeof m.title === "string") {
        const title = m.title.trim();
        if (title) {
          void this.onCreatePlan({ title, description: m.description });
        }
      }
      if (m.type === "createPhase" && m.planId && typeof m.title === "string") {
        const title = m.title.trim();
        if (title) {
          void this.onCreatePhase({ planId: m.planId, title, description: m.description });
        }
      }
      if (m.type === "createTask" && m.planId && m.phaseId && typeof m.desc === "string") {
        const desc = m.desc.trim();
        if (desc) {
          void this.onCreateTask({
            planId: m.planId,
            phaseId: m.phaseId,
            desc,
            prompt: m.prompt,
            commit: Boolean(m.commit),
          });
        }
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
      { enableScripts: true },
    );
    panel.webview.html = getTaskDetailsHtml(plan, phase, task);
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { type?: string; planId?: string; phaseId?: string; taskId?: string };
      if (m.type === "renameTask" && m.planId && m.phaseId && m.taskId) {
        void this.renameTask(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "toggleTaskCommit" && m.planId && m.phaseId && m.taskId) {
        const planIdLocal = m.planId;
        const phaseIdLocal = m.phaseId;
        const taskIdLocal = m.taskId;
        void (async () => {
          const currentPlan = this.plans.find((p) => p.id === planIdLocal);
          const currentPhase = currentPlan?.phases?.find((ph) => ph.id === phaseIdLocal);
          const currentTask = currentPhase?.tasks?.find((t) => t.id === taskIdLocal);
          if (!currentTask) {
            return;
          }
          const next = !Boolean(currentTask.commit);
          await this.onUpdateTask(planIdLocal, phaseIdLocal, taskIdLocal, { commit: next });
          const updatedPlan = this.plans.find((p) => p.id === planIdLocal);
          const updatedPhase = updatedPlan?.phases?.find((ph) => ph.id === phaseIdLocal);
          const updatedTask = updatedPhase?.tasks?.find((t) => t.id === taskIdLocal);
          if (updatedPlan && updatedPhase && updatedTask && this.taskDetailsPanel === panel) {
            panel.webview.html = getTaskDetailsHtml(updatedPlan, updatedPhase, updatedTask);
          }
        })();
      }
    });
    panel.onDidDispose(() => {
      if (this.taskDetailsPanel === panel) {
        this.taskDetailsPanel = undefined;
      }
    });
    this.taskDetailsPanel = panel;
  }

  private async renameTask(planId: string, phaseId: string, taskId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    const task = phase?.tasks?.find((t) => t.id === taskId);
    if (!plan || !phase || !task) {
      void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
      return;
    }

    const next = await vscode.window.showInputBox({
      title: "Rename task",
      prompt: "Task title / description",
      value: task.desc ?? "",
      ignoreFocusOut: true,
    });
    if (next === undefined) {
      return;
    }
    const trimmed = next.trim();
    if (!trimmed) {
      return;
    }

    await this.onUpdateTask(planId, phaseId, taskId, { desc: trimmed });
  }

  private async renamePhase(planId: string, phaseId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    if (!plan || !phase) {
      void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
      return;
    }

    const next = await vscode.window.showInputBox({
      title: "Rename phase",
      prompt: "Phase title",
      value: phase.title ?? "",
      ignoreFocusOut: true,
    });
    if (next === undefined) {
      return;
    }
    const trimmed = next.trim();
    if (!trimmed) {
      return;
    }

    await this.onUpdatePhase(planId, phaseId, { title: trimmed });
  }

  private async renamePlan(planId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) {
      void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
      return;
    }

    const next = await vscode.window.showInputBox({
      title: "Rename plan",
      prompt: "Plan title",
      value: plan.title ?? "",
      ignoreFocusOut: true,
    });
    if (next === undefined) {
      return;
    }
    const trimmed = next.trim();
    if (!trimmed) {
      return;
    }

    await this.onUpdatePlan(planId, { title: trimmed });
  }

  private installPromptEditorListeners(): void {
    // Only install once per provider instance.
    if ((this as { _promptEditorListenersInstalled?: boolean })._promptEditorListenersInstalled) {
      return;
    }
    (this as { _promptEditorListenersInstalled?: boolean })._promptEditorListenersInstalled = true;

    vscode.workspace.onDidSaveTextDocument(
      (doc) => {
        const key = doc.uri.toString();
        const ctx = this.promptEditors.get(key);
        if (!ctx) {
          return;
        }
        const text = doc.getText().replace(/\s+$/, "");
        if (ctx.kind === "plan") {
          void this.onUpdatePlan(ctx.planId, { description: text });
        } else {
          void this.onUpdatePhase(ctx.planId, ctx.phaseId ?? "", { description: text });
        }
      },
      undefined,
      undefined,
    );

    vscode.workspace.onDidCloseTextDocument(
      (doc) => {
        const key = doc.uri.toString();
        if (this.promptEditors.has(key)) {
          this.promptEditors.delete(key);
        }
      },
      undefined,
      undefined,
    );
  }

  private async editPlanPrompt(planId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) {
      void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
      return;
    }
    const current = (plan as { description?: unknown }).description;
    const doc = await vscode.workspace.openTextDocument({
      content: current ? String(current) : "",
      language: "markdown",
    });
    this.promptEditors.set(doc.uri.toString(), { kind: "plan", planId });
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    void vscode.window.showInformationMessage("Edit the plan description, then save the tab to apply.");
  }

  private async editPhasePrompt(planId: string, phaseId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    if (!plan || !phase) {
      void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: phase.description ? String(phase.description) : "",
      language: "markdown",
    });
    this.promptEditors.set(doc.uri.toString(), { kind: "phase", planId, phaseId });
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    void vscode.window.showInformationMessage("Edit the phase description, then save the tab to apply.");
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
      { enableScripts: true },
    );
    panel.webview.html = getPhaseDetailsHtml(plan, phase);
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { type?: string; planId?: string; phaseId?: string; description?: string };
      if (m.type === "renamePhase" && m.planId && m.phaseId) {
        void this.renamePhase(m.planId, m.phaseId);
      }
      if (m.type === "setPhaseDescription" && m.planId && m.phaseId) {
        const next = (m.description ?? "").trim();
        void (async () => {
          await this.onUpdatePhase(m.planId!, m.phaseId!, { description: next });
          const updatedPlan = this.plans.find((p) => p.id === m.planId);
          const updatedPhase = updatedPlan?.phases?.find((ph) => ph.id === m.phaseId);
          if (updatedPlan && updatedPhase && this.phaseDetailsPanel === panel) {
            panel.webview.html = getPhaseDetailsHtml(updatedPlan, updatedPhase);
          }
        })();
      }
    });
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
      { enableScripts: true },
    );
    panel.webview.html = getPlanDetailsHtml(plan);
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { type?: string; planId?: string; description?: string };
      if (m.type === "renamePlan" && m.planId) {
        void this.renamePlan(m.planId);
      }
      if (m.type === "setPlanDescription" && m.planId) {
        const next = (m.description ?? "").trim();
        void (async () => {
          await this.onUpdatePlan(m.planId!, { description: next });
          const updatedPlan = this.plans.find((p) => p.id === m.planId);
          if (updatedPlan && this.planDetailsPanel === panel) {
            panel.webview.html = getPlanDetailsHtml(updatedPlan);
          }
        })();
      }
    });
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
      --graph-edge:    color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
      --graph-node-bg: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background));
      --graph-node-border: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
    }

    #root { padding: 6px 0 16px; }

    .top-toolbar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 4px 8px 10px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--c-border);
      margin-bottom: 6px;
    }
    .toolbar-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .toolbar-divider {
      height: 1px;
      background: var(--c-border);
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
    .quick-btn {
      font: inherit;
      font-size: 0.78em;
      border-radius: 999px;
      border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.35));
      background: var(--vscode-button-background, #0e70c0);
      color: var(--vscode-button-foreground, #fff);
      padding: 3px 10px;
      cursor: pointer;
      opacity: 0.95;
    }
    .quick-btn:hover {
      opacity: 1;
      background: var(--vscode-button-hoverBackground, #1177cc);
    }
    .wizard-overlay {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.38);
      z-index: 20;
      padding: 10px;
    }
    .wizard-card {
      width: min(520px, 100%);
      border: 1px solid var(--c-border);
      border-radius: 10px;
      background: var(--vscode-editor-background);
      box-shadow: 0 10px 26px rgba(0,0,0,0.35);
      padding: 12px;
    }
    .wizard-title {
      font-weight: 700;
      margin-bottom: 4px;
    }
    .wizard-step {
      opacity: 0.75;
      font-size: 0.82em;
      margin-bottom: 10px;
    }
    .wizard-field {
      display: grid;
      gap: 5px;
      margin-bottom: 8px;
    }
    .wizard-label { font-size: 0.82em; opacity: 0.85; }
    .wizard-input, .wizard-select, .wizard-textarea {
      width: 100%;
      border-radius: 6px;
      border: 1px solid var(--c-border);
      color: inherit;
      background: var(--vscode-input-background);
      padding: 8px 9px;
      font: inherit;
    }
    .wizard-textarea { min-height: 86px; resize: vertical; }
    .wizard-check {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 0.84em;
      margin-top: 2px;
      margin-bottom: 8px;
    }
    .wizard-error {
      min-height: 1.2em;
      color: var(--vscode-errorForeground, #f48771);
      font-size: 0.8em;
      margin-top: 2px;
      margin-bottom: 6px;
    }
    .wizard-actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
    }
    .wizard-btn {
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.35));
      padding: 5px 10px;
      cursor: pointer;
      background: transparent;
      color: inherit;
    }
    .wizard-btn.primary {
      background: var(--vscode-button-background, #0e70c0);
      color: var(--vscode-button-foreground, #fff);
      border-color: transparent;
    }

    .graph-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      font-size: 0.74em;
      opacity: 0.86;
      padding: 0 8px 8px;
    }
    .graph-legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .graph-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid var(--c-pending);
    }
    .graph-legend-dot.plan {
      border-color: color-mix(in srgb, var(--vscode-button-background, #0e70c0) 65%, transparent);
      background: color-mix(in srgb, var(--vscode-button-background, #0e70c0) 25%, transparent);
      border-radius: 3px;
    }
    .graph-legend-dot.tone-failed { border-color: var(--c-failed); }
    .graph-legend-dot.tone-completed { border-color: var(--c-done); }
    .graph-legend-dot.tone-in_progress { border-color: var(--c-running); }
    .graph-legend-dot.tone-pending { border-color: var(--c-pending); }
    .graph-legend-dot.tone-cancelled { border-color: var(--c-cancelled); }

    .graph-filter-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px;
      padding: 2px 8px 10px;
    }
    .graph-filter-label {
      font-size: 0.72em;
      opacity: 0.72;
      margin-right: 3px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .graph-filter-chip {
      font: inherit;
      font-size: 0.72em;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      border: 1px solid var(--c-border);
      border-radius: 999px;
      padding: 4px 8px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.68;
    }
    .graph-filter-chip.active {
      opacity: 1;
      border-color: var(--vscode-button-background, #0e70c0);
      background: color-mix(in srgb, var(--vscode-button-background, #0e70c0) 18%, transparent);
      color: var(--vscode-foreground);
    }
    .graph-filter-chip:hover {
      opacity: 1;
      background: var(--c-hover);
    }
    .plan-graph-card {
      margin: 2px 8px 12px;
      border: 1px solid var(--c-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--c-card-bg);
    }
    .plan-graph-card.tone-failed { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-failed) 26%, transparent) inset; }
    .plan-graph-card.tone-completed { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-done) 26%, transparent) inset; }
    .plan-graph-card.tone-in_progress { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-running) 26%, transparent) inset; }
    .plan-graph-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--c-border);
      background: var(--c-header-bg);
    }
    .plan-graph-title {
      font-size: 0.88em;
      font-weight: 700;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .plan-graph-meta {
      font-size: 0.75em;
      opacity: 0.72;
      white-space: nowrap;
    }
    .graph-viewport {
      position: relative;
      height: clamp(360px, 52vh, 520px);
      overflow: hidden;
      border-bottom: 1px solid var(--c-border);
      background:
        radial-gradient(circle at 0 0, rgba(255,255,255,0.02), transparent 50%),
        color-mix(in srgb, var(--vscode-sideBar-background) 80%, transparent);
      cursor: grab;
    }
    .plan-graph-card.expanded .graph-viewport {
      height: clamp(560px, 78vh, 920px);
    }
    .graph-viewport.is-panning { cursor: grabbing; }
    .graph-scene {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      will-change: transform;
    }
    .graph-edges {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
    }
    .graph-edges path {
      stroke: var(--graph-edge);
      stroke-width: 1.8;
      fill: none;
      opacity: 0.82;
    }
    .graph-edges marker path { fill: var(--graph-edge); }

    .graph-plan-node {
      position: absolute;
      border: 1px solid var(--graph-node-border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-button-background, #0e70c0) 14%, var(--graph-node-bg));
      box-shadow: 0 5px 12px rgba(0,0,0,0.15);
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 3px;
      padding: 8px 10px;
    }
    .graph-plan-node.tone-failed { border-color: color-mix(in srgb, var(--c-failed) 65%, transparent); }
    .graph-plan-node.tone-completed { border-color: color-mix(in srgb, var(--c-done) 65%, transparent); }
    .graph-plan-node.tone-in_progress { border-color: color-mix(in srgb, var(--c-running) 65%, transparent); }
    .graph-plan-kicker {
      font-size: 0.64em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.72;
      font-weight: 700;
    }
    .graph-plan-title {
      font-size: 0.82em;
      font-weight: 700;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .graph-phase-node {
      position: absolute;
      border: 1px solid var(--graph-node-border);
      border-radius: 9px;
      background: var(--graph-node-bg);
      box-shadow: 0 8px 18px rgba(0,0,0,0.2);
      display: grid;
      grid-template-rows: 1fr auto;
      overflow: hidden;
    }
    .graph-phase-node.tone-failed { border-color: color-mix(in srgb, var(--c-failed) 62%, transparent); }
    .graph-phase-node.tone-completed { border-color: color-mix(in srgb, var(--c-done) 62%, transparent); }
    .graph-phase-node.tone-in_progress { border-color: color-mix(in srgb, var(--c-running) 62%, transparent); }
    .graph-phase-node.expanded { box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 8px 20px rgba(0,0,0,0.24); }
    .graph-phase-main {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      width: 100%;
      height: 100%;
      padding: 8px;
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .graph-phase-main:hover { background: var(--c-hover); }
    .graph-phase-title {
      font-size: 0.79em;
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.3;
    }
    .graph-phase-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      border-top: 1px solid var(--c-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 40%, transparent);
    }
    .graph-phase-plan {
      font-size: 0.68em;
      opacity: 0.74;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .graph-run-btn {
      opacity: 1;
      height: 18px;
      font-size: 0.67em;
      padding: 1px 7px;
    }

    .graph-controls {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      padding: 8px 8px;
      border-bottom: 1px solid var(--c-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 36%, transparent);
    }
    .graph-control-btn {
      font: inherit;
      font-size: 0.75em;
      border-radius: 5px;
      border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.35));
      background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.18));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      min-width: 24px;
      height: 22px;
      padding: 0 8px;
      cursor: pointer;
    }
    .graph-control-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.3));
    }

    .graph-expanded-details {
      padding: 0 8px 8px;
    }
    .graph-expanded-details.empty {
      padding-top: 8px;
    }
    .graph-empty-hint {
      font-size: 0.76em;
      opacity: 0.72;
      border: 1px dashed var(--c-border);
      border-radius: 6px;
      padding: 8px;
      text-align: center;
    }
    .node-phase-block {
      margin-top: 7px;
      padding-top: 7px;
      border-top: 1px solid var(--c-border);
    }
    .node-phase-header {
      padding: 2px 0;
      cursor: default;
    }
    .node-phase-tasks {
      margin: 4px 0 0 8px;
      padding: 0 0 0 10px;
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
      cursor: pointer; outline: none;
    }
    .phase-status-dot:hover { transform: scale(1.4); box-shadow: 0 0 6px currentColor; }
    .phase-status-dot:focus-visible { outline: 2px solid var(--vscode-focusBorder, #0e70c0); outline-offset: 2px; }
    .dot-completed  { background: var(--c-done);      color: var(--c-done); }
    .dot-in_progress{ background: var(--c-running);  color: var(--c-running); }
    .dot-failed     { background: var(--c-failed);   color: var(--c-failed); }
    .dot-pending    { background: var(--c-pending);  color: var(--c-pending); box-shadow: none; }
    .dot-cancelled  {
      background: transparent;
      color: var(--c-cancelled);
      border: 1.5px solid currentColor;
      box-sizing: border-box;
      width: 10px; height: 10px;
      box-shadow: none;
      position: relative;
    }
    .dot-cancelled::after {
      content: "";
      position: absolute;
      top: 50%; left: -1px; right: -1px;
      height: 1.5px;
      background: currentColor;
      border-radius: 1px;
      transform: translateY(-50%) rotate(-45deg);
      pointer-events: none;
    }

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
      line-height: 1; cursor: pointer; border-radius: 3px; padding: 2px;
      margin: -2px; outline: none; user-select: none;
    }
    .task-icon:hover { background: rgba(127,127,127,0.2); }
    .task-icon:focus-visible { box-shadow: 0 0 0 2px var(--vscode-focusBorder, #0e70c0); }
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
  <div id="wizardOverlay" class="wizard-overlay">
    <div class="wizard-card">
      <div id="wizardTitle" class="wizard-title">Create item</div>
      <div id="wizardStep" class="wizard-step"></div>
      <div id="wizardBody"></div>
      <div id="wizardError" class="wizard-error"></div>
      <div class="wizard-actions">
        <button id="wizardSecondary" class="wizard-btn" type="button">Cancel</button>
        <button id="wizardPrimary" class="wizard-btn primary" type="button">Continue</button>
      </div>
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
    .row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .edit-btn {
      font: inherit;
      border: none;
      background: transparent;
      color: inherit;
      opacity: 0.7;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      line-height: 1;
    }
    .edit-btn:hover { opacity: 1; background: rgba(127,127,127,0.15); }
    .toggle-btn {
      font: inherit;
      border: 1px solid rgba(127,127,127,0.35);
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 1px 8px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.4;
    }
    .toggle-btn:hover { background: rgba(127,127,127,0.18); border-color: rgba(127,127,127,0.55); }
    .toggle-btn[data-value="true"] { color: var(--vscode-charts-green, #4ec9b0); }
    .toggle-btn[data-value="false"] { color: var(--vscode-charts-red, #f48771); }
  </style>
</head>
<body>
  <div class="h1">
    <span class="row">
      <span>${htmlEscape(task.desc)}</span>
      <button class="edit-btn" type="button" data-action="renameTask" title="Edit">✎</button>
    </span>
  </div>
  <div class="meta">
    <div class="k">Plan</div><div class="v">${htmlEscape(plan.title)} <span class="subtle">(<code>${htmlEscape(plan.id)}</code>)</span></div>
    <div class="k">Phase</div><div class="v">${htmlEscape(phase.title)} <span class="subtle">(<code>${htmlEscape(phase.id)}</code>)</span></div>
    <div class="k">Task</div><div class="v"><code>${htmlEscape(task.id)}</code></div>
    <div class="k">State</div><div class="v"><code>${htmlEscape(task.state)}</code></div>
    <div class="k">Commit</div><div class="v"><button class="toggle-btn" type="button" data-action="toggleCommit" data-value="${task.commit ? "true" : "false"}" title="Click to toggle">${task.commit ? "true" : "false"}</button></div>
  </div>
  ${promptBlock}
  <script>
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "renameTask") {
        vscode.postMessage({ type: "renameTask", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)}, taskId: ${JSON.stringify(task.id)} });
      }
      if (action === "toggleCommit") {
        vscode.postMessage({ type: "toggleTaskCommit", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)}, taskId: ${JSON.stringify(task.id)} });
      }
    });
  </script>
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
    .row { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .edit-btn {
      font: inherit;
      border: none;
      background: transparent;
      color: inherit;
      opacity: 0.7;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      line-height: 1;
    }
    .edit-btn:hover { opacity: 1; background: rgba(127,127,127,0.15); }
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .modal {
      width: min(720px, calc(100vw - 28px));
      border-radius: 10px;
      border: 1px solid rgba(127,127,127,0.25);
      background: var(--vscode-editor-background);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      padding: 12px;
    }
    .modal-title { font-weight: 700; margin: 0 0 8px; }
    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(127,127,127,0.25);
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      color: var(--vscode-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.45;
      outline: none;
    }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .btn {
      font: inherit;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      border: 1px solid rgba(127,127,127,0.3);
      background: transparent;
      color: inherit;
    }
    .btn.primary {
      background: var(--vscode-button-background, #0e70c0);
      color: var(--vscode-button-foreground, #fff);
      border-color: transparent;
    }
    .btn:hover { background: rgba(127,127,127,0.12); }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="h1">
    <span class="row">
      <span>${htmlEscape(phase.title)}</span>
      <button class="edit-btn" type="button" data-action="renamePhase" title="Edit">✎</button>
    </span>
  </div>
  <div class="meta">
    <div class="k">Plan</div><div class="v">${htmlEscape(plan.title)} <span class="subtle">(<code>${htmlEscape(plan.id)}</code>)</span></div>
    <div class="k">Phase</div><div class="v"><code>${htmlEscape(phase.id)}</code></div>
    <div class="k">State</div><div class="v"><code>${htmlEscape(phase.state)}</code></div>
    <div class="k">Description</div><div class="v"><span class="row"><span>${htmlEscape(phase.description)}</span><button class="edit-btn" type="button" data-action="editPhaseDescription" title="Edit">✎</button></span></div>
    <div class="k">Tasks</div><div class="v"><code>${tasks.length}</code></div>
  </div>
  <div class="section">
    <div><strong>Tasks in this phase</strong></div>
    ${tasksMarkup}
  </div>
  <div class="overlay" id="overlay">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">Edit phase description</div>
      <textarea id="descInput" spellcheck="false"></textarea>
      <div class="modal-actions">
        <button class="btn" type="button" data-action="cancelEdit">Cancel</button>
        <button class="btn primary" type="button" data-action="saveDescription">Save</button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const overlay = document.getElementById("overlay");
    const descInput = document.getElementById("descInput");
    function openDescEditor() {
      overlay.style.display = "flex";
      descInput.value = ${JSON.stringify(phase.description || "")};
      setTimeout(() => descInput.focus(), 0);
    }
    function closeDescEditor() {
      overlay.style.display = "none";
    }
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "renamePhase") {
        vscode.postMessage({ type: "renamePhase", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)} });
      }
      if (action === "editPhaseDescription") {
        openDescEditor();
      }
      if (action === "cancelEdit") {
        closeDescEditor();
      }
      if (action === "saveDescription") {
        vscode.postMessage({
          type: "setPhaseDescription",
          planId: ${JSON.stringify(plan.id)},
          phaseId: ${JSON.stringify(phase.id)},
          description: descInput.value,
        });
        closeDescEditor();
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeDescEditor();
      }
    });
  </script>
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
  const baseBranch = plan.git?.baseBranch;
  const planBranch = plan.git?.planBranch;

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
    .row { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .edit-btn {
      font: inherit;
      border: none;
      background: transparent;
      color: inherit;
      opacity: 0.7;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      line-height: 1;
    }
    .edit-btn:hover { opacity: 1; background: rgba(127,127,127,0.15); }
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .modal {
      width: min(720px, calc(100vw - 28px));
      border-radius: 10px;
      border: 1px solid rgba(127,127,127,0.25);
      background: var(--vscode-editor-background);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      padding: 12px;
    }
    .modal-title { font-weight: 700; margin: 0 0 8px; }
    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(127,127,127,0.25);
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      color: var(--vscode-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.45;
      outline: none;
    }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .btn {
      font: inherit;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      border: 1px solid rgba(127,127,127,0.3);
      background: transparent;
      color: inherit;
    }
    .btn.primary {
      background: var(--vscode-button-background, #0e70c0);
      color: var(--vscode-button-foreground, #fff);
      border-color: transparent;
    }
    .btn:hover { background: rgba(127,127,127,0.12); }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="h1">
    <span class="row">
      <span>${htmlEscape(plan.title)}</span>
      <button class="edit-btn" type="button" data-action="renamePlan" title="Edit">✎</button>
    </span>
  </div>
  <div class="meta">
    <div class="k">Plan</div><div class="v"><code>${htmlEscape(plan.id)}</code></div>
    <div class="k">State</div><div class="v"><code>${htmlEscape(plan.state)}</code></div>
    <div class="k">Description</div><div class="v"><span class="row"><span>${desc ? htmlEscape(desc) : `<span class="subtle">—</span>`}</span><button class="edit-btn" type="button" data-action="editPlanDescription" title="Edit">✎</button></span></div>
    <div class="k">CreatedAt</div><div class="v">${createdAtLabel ? `<code>${htmlEscape(createdAtLabel)}</code>` : `<span class="subtle">—</span>`}</div>
    <div class="k">Base branch</div><div class="v">${baseBranch ? `<code>${htmlEscape(baseBranch)}</code>` : `<span class="subtle">—</span>`}</div>
    <div class="k">Plan branch</div><div class="v">${planBranch ? `<code>${htmlEscape(planBranch)}</code>` : `<span class="subtle">—</span>`}</div>
    <div class="k">Phases</div><div class="v"><code>${phases.length}</code> · completed <code>${donePhases}</code></div>
    <div class="k">Tasks</div><div class="v"><code>${tasks.length}</code> · completed <code>${doneTasks}</code></div>
  </div>
  <div class="overlay" id="overlay">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">Edit plan description</div>
      <textarea id="descInput" spellcheck="false"></textarea>
      <div class="modal-actions">
        <button class="btn" type="button" data-action="cancelEdit">Cancel</button>
        <button class="btn primary" type="button" data-action="saveDescription">Save</button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const overlay = document.getElementById("overlay");
    const descInput = document.getElementById("descInput");
    function openDescEditor() {
      overlay.style.display = "flex";
      descInput.value = ${JSON.stringify(desc ? String(desc) : "")};
      setTimeout(() => descInput.focus(), 0);
    }
    function closeDescEditor() {
      overlay.style.display = "none";
    }
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "renamePlan") {
        vscode.postMessage({ type: "renamePlan", planId: ${JSON.stringify(plan.id)} });
      }
      if (action === "editPlanDescription") {
        openDescEditor();
      }
      if (action === "cancelEdit") {
        closeDescEditor();
      }
      if (action === "saveDescription") {
        vscode.postMessage({ type: "setPlanDescription", planId: ${JSON.stringify(plan.id)}, description: descInput.value });
        closeDescEditor();
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeDescEditor();
      }
    });
  </script>
</body>
</html>`;
}
