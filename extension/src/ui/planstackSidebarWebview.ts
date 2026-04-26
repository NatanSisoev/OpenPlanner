import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import type { Plan } from "../plan/types";
import type { ExecutionState } from "../plan/types";

export const SIDEBAR_WEBVIEW_ID = "hackupc.planstack.ui";

interface PlanstackSidebarCallbacks {
  onRunPhase: (planId: string, phaseId: string) => void;
  onRunTask: (planId: string, phaseId: string, taskId: string) => void;
  onUpdatePhase: (
    planId: string,
    phaseId: string,
    patch: {
      state?: ExecutionState;
      title?: string;
      description?: string;
      assignee?: string;
    },
  ) => Promise<boolean>;
  onUpdateTask: (
    planId: string,
    phaseId: string,
    taskId: string,
    patch: {
      state?: ExecutionState;
      desc?: string;
      prompt?: string;
      commit?: boolean;
      assignee?: string;
    },
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
  onDeletePlan: (planId: string) => Promise<void>;
  onDeletePhase: (planId: string, phaseId: string) => Promise<void>;
  onDeleteTask: (planId: string, phaseId: string, taskId: string) => Promise<void>;
  onRunPlanFully: (planId: string) => Promise<void>;
  onSyncPushAll: () => Promise<void>;
  onSyncPullAll: () => Promise<void>;
  onSyncPullPushAll: () => Promise<void>;
}

export class PlanstackSidebarWebview implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private plans: Plan[] = [];
  private plansVersion = 0;
  private taskDetailsPanel?: vscode.WebviewPanel;
  private phaseDetailsPanel?: vscode.WebviewPanel;
  private planDetailsPanel?: vscode.WebviewPanel;
  private readonly onRunPhase: PlanstackSidebarCallbacks["onRunPhase"];
  private readonly onRunTask: PlanstackSidebarCallbacks["onRunTask"];
  private readonly onUpdatePhase: PlanstackSidebarCallbacks["onUpdatePhase"];
  private readonly onUpdateTask: PlanstackSidebarCallbacks["onUpdateTask"];
  private readonly onUpdatePlan: PlanstackSidebarCallbacks["onUpdatePlan"];
  private readonly onCreatePlan: PlanstackSidebarCallbacks["onCreatePlan"];
  private readonly onCreatePhase: PlanstackSidebarCallbacks["onCreatePhase"];
  private readonly onCreateTask: PlanstackSidebarCallbacks["onCreateTask"];
  private readonly onMergePlan: PlanstackSidebarCallbacks["onMergePlan"];
  private readonly onReorderPlans: PlanstackSidebarCallbacks["onReorderPlans"];
  private readonly onDeletePlan: PlanstackSidebarCallbacks["onDeletePlan"];
  private readonly onDeletePhase: PlanstackSidebarCallbacks["onDeletePhase"];
  private readonly onDeleteTask: PlanstackSidebarCallbacks["onDeleteTask"];
  private readonly onRunPlanFully: PlanstackSidebarCallbacks["onRunPlanFully"];
  private readonly onSyncPushAll: PlanstackSidebarCallbacks["onSyncPushAll"];
  private readonly onSyncPullAll: PlanstackSidebarCallbacks["onSyncPullAll"];
  private readonly onSyncPullPushAll: PlanstackSidebarCallbacks["onSyncPullPushAll"];
  private readonly promptEditors = new Map<
    string,
    { kind: "plan" | "phase" | "task"; planId: string; phaseId?: string; taskId?: string }
  >();

  constructor(private readonly extUri: vscode.Uri, callbacks: PlanstackSidebarCallbacks) {
    this.onRunPhase = callbacks.onRunPhase;
    this.onRunTask = callbacks.onRunTask;
    this.onUpdatePhase = callbacks.onUpdatePhase;
    this.onUpdateTask = callbacks.onUpdateTask;
    this.onUpdatePlan = callbacks.onUpdatePlan;
    this.onCreatePlan = callbacks.onCreatePlan;
    this.onCreatePhase = callbacks.onCreatePhase;
    this.onCreateTask = callbacks.onCreateTask;
    this.onMergePlan = callbacks.onMergePlan;
    this.onReorderPlans = callbacks.onReorderPlans;
    this.onDeletePlan = callbacks.onDeletePlan;
    this.onDeletePhase = callbacks.onDeletePhase;
    this.onDeleteTask = callbacks.onDeleteTask;
    this.onRunPlanFully = callbacks.onRunPlanFully;
    this.onSyncPushAll = callbacks.onSyncPushAll;
    this.onSyncPullAll = callbacks.onSyncPullAll;
    this.onSyncPullPushAll = callbacks.onSyncPullPushAll;
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

    const labelsUri = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, "media", "planstackRunLabels.js"));
    const scriptUri = w.asWebviewUri(
      vscode.Uri.joinPath(this.extUri, "media", "planstackSidebar.js"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `script-src ${w.cspSource}`,
    ].join("; ");

    w.html = getSidebarHtml(csp, labelsUri, scriptUri);

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
        requestId?: string;
        planId?: string;
        phaseId?: string;
        taskId?: string;
        state?: ExecutionState;
        title?: string;
        description?: string;
        desc?: string;
        prompt?: string;
        commit?: boolean;
        assignee?: string;
        orderedPlanIds?: string[];
      };
      if (m.type === "runPhase" && m.planId && m.phaseId) {
        traceEvent(recvId, "sidebar.runPhase", { planId: m.planId, phaseId: m.phaseId });
        this.onRunPhase(m.planId, m.phaseId);
      }
      if (m.type === "runTask" && m.planId && m.phaseId && m.taskId) {
        traceEvent(recvId, "sidebar.runTask", { planId: m.planId, phaseId: m.phaseId, taskId: m.taskId });
        this.onRunTask(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "updatePhase" && m.planId && m.phaseId) {
        traceEvent(recvId, "sidebar.updatePhase", {
          planId: m.planId,
          phaseId: m.phaseId,
          state: m.state,
        });
        void this.onUpdatePhase(m.planId, m.phaseId, { state: m.state }).then((ok) => {
          if (!m.requestId) {
            return;
          }
          this.view?.webview.postMessage({ type: "mutationAck", requestId: m.requestId, ok });
        });
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
      if (m.type === "editTaskAssignee" && m.planId && m.phaseId && m.taskId) {
        void this.editTaskAssignee(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "editPhaseAssignee" && m.planId && m.phaseId) {
        void this.editPhaseAssignee(m.planId, m.phaseId);
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
          assignee: m.assignee,
        }).then((ok) => {
          if (!m.requestId) {
            return;
          }
          this.view?.webview.postMessage({ type: "mutationAck", requestId: m.requestId, ok });
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
      if (m.type === "deletePlan" && m.planId) {
        void this.onDeletePlan(m.planId);
      }
      if (m.type === "deletePhase" && m.planId && m.phaseId) {
        void this.onDeletePhase(m.planId, m.phaseId);
      }
      if (m.type === "deleteTask" && m.planId && m.phaseId && m.taskId) {
        void this.onDeleteTask(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "runPlanFully" && m.planId) {
        void this.onRunPlanFully(m.planId);
      }
      if (m.type === "runTask" && m.planId && m.phaseId && m.taskId) {
        void this.onRunTask(m.planId, m.phaseId, m.taskId);
      }
      if (m.type === "syncPushAll") {
        void this.onSyncPushAll();
      }
      if (m.type === "syncPullAll") {
        void this.onSyncPullAll();
      }
      if (m.type === "syncPullPushAll") {
        void this.onSyncPullPushAll();
      }
    });
    webviewView.onDidDispose(() => sub.dispose());

    const sentVersion = this.plansVersion;
    setTimeout(() => {
      try {
        if (sentVersion === this.plansVersion) {
          this.postPlansToWebview();
        }
      } catch {
        // Webview may already be disposed.
      }
    }, 0);
  }

  private postPlansToWebview(): void {
    const w = this.view?.webview;
    if (!w) {
      return;
    }
    const requireTaskPrompt =
      vscode.workspace.getConfiguration("planstack").get<boolean>("requireTaskPrompt") ?? true;
    try {
      w.postMessage({ type: "setPlans", plans: this.plans, requireTaskPrompt });
    } catch {
      // Webview not ready yet.
    }
  }

  setPlans(plans: Plan[]): void {
    this.plans = plans;
    this.plansVersion += 1;
    this.postPlansToWebview();
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
      if (m.type === "editTaskAssignee" && m.planId && m.phaseId && m.taskId) {
        void this.editTaskAssignee(m.planId, m.phaseId, m.taskId);
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
      if (m.type === "editTaskPrompt" && m.planId && m.phaseId && m.taskId) {
        void this.editTaskPrompt(m.planId, m.phaseId, m.taskId);
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

  private async editTaskAssignee(planId: string, phaseId: string, taskId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    const task = phase?.tasks?.find((t) => t.id === taskId);
    if (!plan || !phase || !task) {
      void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
      return;
    }

    const next = await vscode.window.showInputBox({
      title: "Task assignee",
      prompt: "Owner label (free text). Leave empty to clear.",
      value: task.assignee ?? "",
      ignoreFocusOut: true,
    });
    if (next === undefined) {
      return;
    }

    await this.onUpdateTask(planId, phaseId, taskId, { assignee: next });
    const updatedPlan = this.plans.find((p) => p.id === planId);
    const updatedPhase = updatedPlan?.phases?.find((ph) => ph.id === phaseId);
    const updatedTask = updatedPhase?.tasks?.find((t) => t.id === taskId);
    if (updatedPlan && updatedPhase && updatedTask && this.taskDetailsPanel) {
      this.taskDetailsPanel.webview.html = getTaskDetailsHtml(updatedPlan, updatedPhase, updatedTask);
    }
    if (updatedPlan && updatedPhase && this.phaseDetailsPanel) {
      this.phaseDetailsPanel.webview.html = getPhaseDetailsHtml(updatedPlan, updatedPhase);
    }
  }

  private async editPhaseAssignee(planId: string, phaseId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    if (!plan || !phase) {
      void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
      return;
    }

    const next = await vscode.window.showInputBox({
      title: "Phase assignee",
      prompt: "Owner label (free text). Leave empty to clear.",
      value: phase.assignee ?? "",
      ignoreFocusOut: true,
    });
    if (next === undefined) {
      return;
    }

    await this.onUpdatePhase(planId, phaseId, { assignee: next });
    const updatedPlan = this.plans.find((p) => p.id === planId);
    const updatedPhase = updatedPlan?.phases?.find((ph) => ph.id === phaseId);
    if (updatedPlan && updatedPhase && this.phaseDetailsPanel) {
      this.phaseDetailsPanel.webview.html = getPhaseDetailsHtml(updatedPlan, updatedPhase);
    }
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
        } else if (ctx.kind === "phase") {
          void this.onUpdatePhase(ctx.planId, ctx.phaseId ?? "", { description: text });
        } else {
          const planId = ctx.planId;
          const phaseId = ctx.phaseId ?? "";
          const taskId = ctx.taskId ?? "";
          void (async () => {
            const ok = await this.onUpdateTask(planId, phaseId, taskId, { prompt: text });
            if (!ok || !this.taskDetailsPanel) {
              return;
            }
            const updatedPlan = this.plans.find((p) => p.id === planId);
            const updatedPhase = updatedPlan?.phases?.find((ph) => ph.id === phaseId);
            const updatedTask = updatedPhase?.tasks?.find((t) => t.id === taskId);
            if (updatedPlan && updatedPhase && updatedTask) {
              this.taskDetailsPanel.webview.html = getTaskDetailsHtml(updatedPlan, updatedPhase, updatedTask);
              this.taskDetailsPanel.title = `Task: ${updatedTask.desc}`;
            }
          })();
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

  private async editTaskPrompt(planId: string, phaseId: string, taskId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    const task = phase?.tasks?.find((t) => t.id === taskId);
    if (!plan || !phase || !task) {
      void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: task.prompt ? String(task.prompt) : "",
      language: "markdown",
    });
    this.promptEditors.set(doc.uri.toString(), { kind: "task", planId, phaseId, taskId });
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    void vscode.window.showInformationMessage("Edit the task prompt, then save the tab to apply.");
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
      if (m.type === "editPhaseAssignee" && m.planId && m.phaseId) {
        void this.editPhaseAssignee(m.planId, m.phaseId);
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

const PS_TOKENS_CSS = `
:root {
  /* Spacing — 4px base */
  --ps-s-1: 2px;  --ps-s-2: 4px;  --ps-s-3: 8px;
  --ps-s-4: 12px; --ps-s-5: 16px; --ps-s-6: 24px;

  /* Radius — 3 stops + pill */
  --ps-r-1: 3px; --ps-r-2: 6px; --ps-r-3: 10px; --ps-r-pill: 999px;

  /* Type — 4 stops, em-relative */
  --ps-t-xs: 0.75em; --ps-t-sm: 0.85em;
  --ps-t-md: 1em;    --ps-t-lg: 1.1em;

  /* Surfaces & text — anchor to theme */
  --ps-bg:          var(--vscode-sideBar-background);
  --ps-bg-elevated: var(--vscode-editor-background);
  --ps-bg-header:   var(--vscode-sideBarSectionHeader-background);
  --ps-bg-hover:    var(--vscode-list-hoverBackground);
  --ps-bg-active:   var(--vscode-list-activeSelectionBackground);
  --ps-fg:          var(--vscode-foreground);
  --ps-fg-muted:    var(--vscode-descriptionForeground);

  /* Borders — exactly 2 tokens */
  --ps-border:        color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  --ps-border-strong: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);

  /* Shadows — VS Code-native */
  --ps-shadow-1: 0 1px 2px var(--vscode-widget-shadow, transparent);
  --ps-shadow-2: 0 2px 8px var(--vscode-widget-shadow, transparent);

  /* Status — anchor to charts.* (theme-aware) */
  --ps-c-done:      var(--vscode-charts-green);
  --ps-c-running:   var(--vscode-charts-blue);
  --ps-c-failed:    var(--vscode-charts-red);
  --ps-c-cancelled: var(--vscode-charts-foreground);
  --ps-c-pending:   var(--vscode-descriptionForeground);
  --ps-c-accent:    var(--vscode-focusBorder);

  /* Status fills — derived once */
  --ps-fill-done:    color-mix(in srgb, var(--ps-c-done)    18%, transparent);
  --ps-fill-running: color-mix(in srgb, var(--ps-c-running) 18%, transparent);
  --ps-fill-failed:  color-mix(in srgb, var(--ps-c-failed)  18%, transparent);
  --ps-fill-pending: color-mix(in srgb, var(--ps-c-pending) 12%, transparent);

  /* Aliases — keep until post-demo refactor */
  --c-done:      var(--ps-c-done);
  --c-running:   var(--ps-c-running);
  --c-failed:    var(--ps-c-failed);
  --c-cancelled: var(--ps-c-cancelled);
  --c-pending:   var(--ps-c-pending);
  --c-border:    var(--ps-border);
  --c-hover:     var(--ps-bg-hover);
  --c-card-bg:   var(--ps-bg-elevated);
  --c-header-bg: var(--ps-bg-header);
}
`;

export { PS_TOKENS_CSS };

function getSidebarHtml(csp: string, labelsUri: vscode.Uri, scriptUri: vscode.Uri): string {
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

    ${PS_TOKENS_CSS}

    :root {
      /* Graph (untouched, normalized prefix) */
      --graph-edge:           color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
      --graph-edge-dimmed:    color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      --graph-edge-highlight: var(--ps-c-accent);
      --graph-node-bg:        color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background));
      --graph-node-border:    color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
    }

    #root { padding: 6px 0 16px; box-sizing: border-box; }
    #root.view-nodes {
      min-height: 100%;
      display: flex;
      flex-direction: column;
    }
    #root.view-nodes > .top-toolbar {
      flex-shrink: 0;
    }
    #root.view-nodes > .graph-legend,
    #root.view-nodes > .graph-filter-row {
      flex-shrink: 0;
    }
    #root.view-nodes > .plan-graph-card {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

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
    .toolbar-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toolbar-group-right {
      margin-left: auto;
    }
    .toolbar-create-row {
      width: 100%;
      flex-wrap: wrap;
    }
    .toolbar-create-group {
      flex: 1 1 auto;
      min-width: 0;
    }
    .toolbar-divider {
      height: 1px;
      background: var(--c-border);
    }
    .view-btn {
      font: inherit;
      font-size: var(--ps-t-xs);
      border-radius: var(--ps-r-pill);
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      background: transparent;
      color: var(--vscode-foreground);
      padding: 3px 10px;
      cursor: pointer;
      opacity: 0.75;
    }
    .view-btn:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground, var(--ps-border));
    }
    .view-btn.active {
      opacity: 1;
      color: var(--vscode-button-foreground, white);
      background: var(--vscode-button-background, var(--ps-c-accent));
      border-color: transparent;
    }
    .sync-split {
      display: inline-flex;
      align-items: stretch;
      border-radius: var(--ps-r-pill);
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      overflow: visible;
    }
    .sync-split .sync-main {
      border-radius: 0;
      border: none;
      border-right: 1px solid var(--c-border);
    }
    .sync-more {
      position: relative;
      display: flex;
      align-items: stretch;
    }
    .sync-more > summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 26px;
      padding: 3px 6px;
      margin: 0;
      cursor: pointer;
      border: none;
      border-radius: 0;
      font: inherit;
      font-size: var(--ps-t-xs);
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.9;
    }
    .sync-more > summary::-webkit-details-marker { display: none; }
    .sync-more > summary:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground, var(--ps-border));
    }
    .sync-dropdown {
      position: absolute;
      right: 0;
      top: calc(100% + 4px);
      z-index: 30;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 88px;
      padding: 4px;
      border-radius: var(--ps-r-2);
      border: 1px solid var(--c-border);
      background: var(--vscode-editor-background);
      box-shadow: var(--ps-shadow-2);
    }
    .sync-dropdown-item {
      font: inherit;
      font-size: var(--ps-t-sm);
      text-align: left;
      padding: 5px 8px;
      border: none;
      border-radius: var(--ps-r-2);
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .sync-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground, var(--ps-border));
    }
    .quick-btn {
      font: inherit;
      font-size: var(--ps-t-xs);
      border-radius: var(--ps-r-pill);
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      background: var(--vscode-button-background, var(--ps-c-accent));
      color: var(--vscode-button-foreground, white);
      padding: 3px 10px;
      cursor: pointer;
      opacity: 0.9;
    }
    .quick-btn:hover {
      opacity: 1;
      background: var(--vscode-button-hoverBackground, var(--ps-c-accent));
    }
    .wizard-overlay {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
      z-index: 20;
      padding: 10px;
    }
    .wizard-card {
      width: min(520px, 100%);
      border: 1px solid var(--c-border);
      border-radius: var(--ps-r-3);
      background: var(--vscode-editor-background);
      box-shadow: var(--ps-shadow-2);
      padding: 12px;
    }
    .wizard-title {
      font-weight: 700;
      margin-bottom: 4px;
    }
    .wizard-step {
      opacity: 0.75;
      font-size: var(--ps-t-sm);
      margin-bottom: 10px;
    }
    .wizard-field {
      display: grid;
      gap: 5px;
      margin-bottom: 8px;
    }
    .wizard-label { font-size: var(--ps-t-sm); opacity: 0.9; }
    .wizard-input, .wizard-select, .wizard-textarea {
      width: 100%;
      border-radius: var(--ps-r-2);
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
      font-size: var(--ps-t-sm);
      margin-top: 2px;
      margin-bottom: 8px;
    }
    .wizard-error {
      min-height: 1.2em;
      color: var(--vscode-errorForeground, var(--ps-c-failed));
      font-size: var(--ps-t-sm);
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
      border-radius: var(--ps-r-2);
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      padding: 5px 10px;
      cursor: pointer;
      background: transparent;
      color: inherit;
    }
    .wizard-btn.primary {
      background: var(--vscode-button-background, var(--ps-c-accent));
      color: var(--vscode-button-foreground, white);
      border-color: transparent;
    }

    .graph-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      opacity: 0.75;
      padding: 8px 10px 10px;
    }
    .graph-legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .graph-legend-dot {
      width: 9px;
      height: 9px;
      border-radius: var(--ps-r-pill);
      border: 2px solid var(--c-pending);
    }
    .graph-legend-dot.plan {
      border-color: color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 65%, transparent);
      background: color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 30%, transparent);
      border-radius: var(--ps-r-1);
    }
    .graph-legend-dot.tone-failed { border-color: var(--c-failed); }
    .graph-legend-dot.tone-completed { border-color: var(--c-done); }
    .graph-legend-dot.tone-in_progress { border-color: var(--c-running); }
    .graph-legend-dot.tone-pending { border-color: var(--c-pending); }
    .graph-legend-dot.tone-cancelled { border-color: var(--c-cancelled); }
    .graph-legend-line {
      width: 22px;
      height: 0;
      border-top: 2px solid var(--graph-edge);
    }
    .graph-legend-line.selected {
      border-top-color: var(--graph-edge-highlight);
      border-top-width: 2.5px;
    }

    .graph-filter-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 0 10px 10px;
    }
    .graph-filter-label {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      opacity: 0.55;
      margin-right: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .graph-filter-chip {
      font: inherit;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      line-height: 1;
      text-transform: lowercase;
      letter-spacing: 0.02em;
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
      border-radius: var(--ps-r-pill);
      padding: 4px 9px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.75;
      transition: background 100ms ease, border-color 100ms ease, opacity 100ms ease;
    }
    .graph-filter-chip.active {
      opacity: 1;
      border-color: color-mix(in srgb, var(--graph-edge-highlight) 60%, transparent);
      background: color-mix(in srgb, var(--graph-edge-highlight) 18%, transparent);
      color: var(--vscode-foreground);
    }
    .graph-filter-chip:hover {
      opacity: 1;
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
    }
    .plan-graph-card {
      margin: 2px 8px 12px;
      border: 1px solid var(--c-border);
      border-radius: var(--ps-r-3);
      overflow: hidden;
      background: var(--c-card-bg);
      box-shadow: var(--ps-shadow-2);
    }
    .plan-graph-card.tone-failed { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-failed) 26%, transparent) inset, var(--ps-shadow-2); }
    .plan-graph-card.tone-completed { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-done) 26%, transparent) inset, var(--ps-shadow-2); }
    .plan-graph-card.tone-in_progress { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-running) 26%, transparent) inset, var(--ps-shadow-2); }
    .plan-graph-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--c-border);
      flex-shrink: 0;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 100%, transparent) 0%,
          color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 60%, transparent) 100%);
    }
    .plan-graph-title {
      font-size: var(--ps-t-md);
      font-weight: 700;
      letter-spacing: 0.005em;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .plan-graph-title::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: var(--ps-r-pill);
      background: var(--graph-edge-highlight);
      box-shadow: 0 0 8px var(--graph-edge-highlight);
      flex-shrink: 0;
    }
    .plan-graph-meta {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      opacity: 0.75;
      white-space: nowrap;
      letter-spacing: 0.01em;
    }
    .graph-viewport {
      position: relative;
      min-height: 100px;
      height: clamp(100px, 32vh, 720px);
      overflow: hidden;
      border-bottom: 1px solid var(--c-border);
      /* Subtle dot grid (à la Figma/Excalidraw) so the canvas has a
         technical feel without competing with the nodes. */
      background:
        radial-gradient(circle, color-mix(in srgb, var(--vscode-foreground) 9%, transparent) 1px, transparent 1.4px) 0 0 / 22px 22px,
        radial-gradient(ellipse at top left, color-mix(in srgb, var(--vscode-foreground) 4%, transparent), transparent 60%),
        color-mix(in srgb, var(--vscode-sideBar-background) 78%, transparent);
      cursor: grab;
    }
    #root.view-nodes .graph-viewport {
      height: auto;
      flex: 1 1 auto;
      min-height: 96px;
    }
    .plan-graph-card.expanded .graph-viewport {
      min-height: 120px;
      height: clamp(120px, 42vh, 1080px);
    }
    #root.view-nodes .plan-graph-card.expanded .graph-viewport {
      flex: 2 1 auto;
      min-height: 120px;
      height: auto;
      max-height: min(1080px, 92vh);
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
    /* Default: every dependency arrow is muted grey so the graph reads as
       "structure" rather than alerts. Selection highlights one set. */
    .graph-edges path {
      stroke: var(--graph-edge);
      stroke-width: 1.6;
      fill: none;
      opacity: 0.9;
      transition: stroke 120ms ease, opacity 120ms ease, stroke-width 120ms ease;
    }
    .graph-edges marker#graph-arrow-global path { fill: var(--graph-edge); }
    .graph-edges marker#graph-arrow-highlight-global path { fill: var(--graph-edge-highlight); }
    /* Cross-plan still distinguished by a dashed pattern, but grey by default. */
    .graph-edges path.cross-plan {
      stroke-dasharray: 7 5;
    }
    .graph-edges path.phase-dep {
      stroke-width: 1.6;
    }
    /* Plan -> first-phase fan-out lines are even more subtle; they're not
       dependencies per se, just structural anchors. */
    .graph-edges path.plan-dep {
      opacity: 0.35;
    }
    /* Dimmed: a phase is selected and this edge is NOT one of its deps. */
    .graph-edges path.dimmed {
      stroke: var(--graph-edge-dimmed);
      opacity: 0.55;
    }
    /* Selected: this edge is one of the selected phase's incoming deps
       (i.e., a phase the selection depends on). */
    .graph-edges path.selected {
      stroke: var(--graph-edge-highlight);
      stroke-width: 2.6;
      opacity: 1;
    }
    .graph-edges path.cross-plan.selected {
      stroke-dasharray: 0;
    }
    .graph-edge-label.dimmed { opacity: 0.55; }
    .graph-edge-label.selected {
      fill: var(--graph-edge-highlight);
      stroke: var(--vscode-editor-background);
    }
    .graph-edge-label {
      fill: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 10px;
      font-weight: 700;
      paint-order: stroke;
      stroke: var(--vscode-editor-background);
      stroke-width: 4px;
      text-anchor: middle;
      pointer-events: none;
    }

    /* ── Plan node ────────────────────────────────────────────────────── */
    .graph-plan-node {
      position: absolute;
      border: 1px solid var(--graph-node-border);
      border-radius: var(--ps-r-3);
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 18%, var(--graph-node-bg)) 0%,
          var(--graph-node-bg) 100%);
      box-shadow:
        var(--ps-shadow-1),
        inset 0 1px 0 rgba(255,255,255,0.05);
      display: grid;
      grid-template-columns: 4px minmax(0, 1fr);
      overflow: hidden;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
    }
    .graph-plan-node:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
      box-shadow:
        0 12px 22px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.07);
    }
    .graph-plan-node.tone-failed { border-color: color-mix(in srgb, var(--c-failed) 62%, transparent); }
    .graph-plan-node.tone-completed { border-color: color-mix(in srgb, var(--c-done) 62%, transparent); }
    .graph-plan-node.tone-in_progress { border-color: color-mix(in srgb, var(--c-running) 62%, transparent); }
    .graph-plan-body {
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      min-height: 0;
      flex: 1 1 auto;
      align-self: stretch;
      justify-content: flex-start;
    }
    .graph-plan-top {
      display: flex;
      align-items: center;
      justify-content: flex-start;
    }
    .graph-plan-actions {
      margin-top: auto;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
      width: 100%;
      padding-top: 2px;
    }
    .graph-plan-run-btn { flex-shrink: 0; }
    .graph-node-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .graph-plan-kicker {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-weight: 700;
      opacity: 0.9;
      background: color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 28%, transparent);
      color: var(--vscode-foreground);
      padding: 2px 7px 2px 8px;
      border-radius: var(--ps-r-1);
      border: 1px solid color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 36%, transparent);
    }
    .graph-plan-title {
      font-size: var(--ps-t-md);
      font-weight: 700;
      line-height: 1.25;
      letter-spacing: -0.005em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Phase node ───────────────────────────────────────────────────── */
    .graph-phase-node {
      position: absolute;
      border: 1px solid var(--graph-node-border);
      border-radius: var(--ps-r-3);
      background: var(--graph-node-bg);
      box-shadow:
        var(--ps-shadow-1),
        inset 0 1px 0 rgba(255,255,255,0.04);
      display: grid;
      grid-template-columns: 4px minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
      overflow: hidden;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
    }
    .graph-phase-node.tone-failed { border-color: color-mix(in srgb, var(--c-failed) 50%, transparent); }
    .graph-phase-node.tone-completed { border-color: color-mix(in srgb, var(--c-done) 50%, transparent); }
    .graph-phase-node.tone-in_progress { border-color: color-mix(in srgb, var(--c-running) 50%, transparent); }
    .graph-phase-node:not(.selected):hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--vscode-foreground) 36%, transparent);
      box-shadow:
        0 14px 24px rgba(0,0,0,0.34),
        inset 0 1px 0 rgba(255,255,255,0.06);
    }
    .graph-phase-node.selected {
      border-color: var(--graph-edge-highlight);
      box-shadow:
        0 0 0 1px var(--graph-edge-highlight),
        0 0 0 5px color-mix(in srgb, var(--graph-edge-highlight) 22%, transparent),
        0 16px 30px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
      transform: none;
    }
    /* Status accent stripe used by both plan and phase nodes. */
    .graph-node-stripe {
      grid-row: 1 / 3;
      grid-column: 1;
      width: 4px;
      background: var(--c-pending);
    }
    .graph-plan-node .graph-node-stripe { grid-row: 1; }
    .graph-node-stripe.tone-completed   { background: var(--c-done); }
    .graph-node-stripe.tone-in_progress {
      background: linear-gradient(180deg, var(--c-running), color-mix(in srgb, var(--c-running) 50%, transparent));
      animation: graph-stripe-pulse 1.8s ease-in-out infinite;
    }
    .graph-node-stripe.tone-failed      { background: var(--c-failed); }
    .graph-node-stripe.tone-cancelled   { background: var(--c-cancelled); }
    .graph-node-stripe.tone-pending     { background: var(--c-pending); }

    @keyframes graph-stripe-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }

    .graph-node-id {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      letter-spacing: 0.01em;
      opacity: 0.75;
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      padding: 1px 6px;
      border-radius: var(--ps-r-1);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      align-self: flex-start;
    }
    .graph-plan-body .graph-node-id { font-size: var(--ps-t-xs); opacity: 0.55; padding: 0 4px; background: transparent; }

    .graph-phase-main {
      grid-column: 2;
      grid-row: 1;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      padding: 8px 10px 6px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      cursor: pointer;
      min-width: 0;
    }
    .graph-phase-main:hover { background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); }
    .graph-phase-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .graph-phase-head .graph-node-id {
      max-width: 60%;
    }
    .graph-phase-title {
      font-size: var(--ps-t-md);
      font-weight: 600;
      line-height: 1.25;
      letter-spacing: -0.005em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-width: 0;
    }
    .graph-phase-desc {
      font-size: var(--ps-t-xs);
      line-height: 1.35;
      color: var(--vscode-descriptionForeground, rgba(180, 180, 180, 0.92));
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-width: 0;
      flex-shrink: 0;
    }
    .graph-phase-deps-chip {
      align-self: flex-start;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 700;
      color: color-mix(in srgb, var(--vscode-foreground) 75%, transparent);
      background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      padding: 2px 8px;
      border-radius: var(--ps-r-pill);
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .graph-phase-deps-chip .chip-glyph {
      font-size: var(--ps-t-lg);
      opacity: 0.75;
      line-height: 1;
    }
    .graph-phase-node.selected .graph-phase-deps-chip {
      color: var(--graph-edge-highlight);
      background: color-mix(in srgb, var(--graph-edge-highlight) 15%, transparent);
      border-color: color-mix(in srgb, var(--graph-edge-highlight) 40%, transparent);
    }

    .graph-phase-footer {
      grid-column: 2;
      grid-row: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
      flex-shrink: 0;
      position: relative;
      z-index: 1;
    }
    .graph-phase-plan {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      opacity: 0.55;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    /* Higher-specificity selectors so these always beat the generic
       .run-btn { opacity: 0 } rule defined later in the stylesheet. */
    .graph-phase-node .graph-run-btn,
    .graph-plan-node .graph-run-btn {
      opacity: 1;
      height: 22px;
      font-size: var(--ps-t-xs);
      padding: 2px 10px;
      font-weight: 700;
      letter-spacing: 0.01em;
      border-radius: var(--ps-r-pill);
      border: 1px solid color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 70%, transparent);
      box-shadow: 0 2px 6px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
      flex-shrink: 0;
    }
    .ps-run-glyph {
      display: inline-block;
      margin-right: 2px;
      font-size: var(--ps-t-md);
      line-height: 1;
      color: var(--vscode-button-foreground, white);
      text-shadow: 0 0 1px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
    }
    .plan-header .run-btn .ps-run-glyph,
    .phase-header .run-btn .ps-run-glyph,
    .node-phase-header .run-btn .ps-run-glyph {
      color: var(--vscode-button-foreground, white);
    }
    .task-btn.run-task .ps-run-glyph {
      color: inherit;
      text-shadow: none;
      margin-right: 1px;
      font-size: var(--ps-t-xs);
    }
    .task-btn.run-task .run-task-label {
      font-size: var(--ps-t-xs);
      font-weight: 700;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .graph-phase-node .graph-run-btn:hover,
    .graph-plan-node .graph-run-btn:hover {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background, var(--ps-c-accent)));
      box-shadow: 0 3px 10px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent), 0 0 0 3px color-mix(in srgb, var(--vscode-button-background, var(--ps-c-accent)) 22%, transparent);
    }
    .graph-phase-node .graph-add-btn,
    .graph-plan-node .graph-add-btn {
      opacity: 1;
      height: 24px;
      font-size: var(--ps-t-xs);
      padding: 2px 8px;
    }

    .graph-controls {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--c-border);
      flex-shrink: 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 42%, transparent);
      backdrop-filter: blur(4px);
    }
    .graph-control-btn {
      font: inherit;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-xs);
      letter-spacing: 0.02em;
      border-radius: var(--ps-r-1);
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      color: var(--vscode-foreground);
      min-width: 24px;
      height: 22px;
      padding: 0 9px;
      cursor: pointer;
      opacity: 0.9;
      transition: background 100ms ease, opacity 100ms ease, border-color 100ms ease;
    }
    .graph-control-btn:hover {
      opacity: 1;
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      border-color: color-mix(in srgb, var(--vscode-foreground) 35%, transparent);
    }

    .graph-expanded-details {
      padding: 0 8px 8px;
      flex-shrink: 0;
    }
    .graph-expanded-details.empty {
      padding-top: 8px;
    }
    .graph-empty-hint {
      font-size: var(--ps-t-xs);
      opacity: 0.75;
      border: 1px dashed var(--c-border);
      border-radius: var(--ps-r-2);
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
    .node-phase-deps {
      margin: 7px 0 8px;
      padding: 7px 8px;
      border-left: 3px solid var(--vscode-charts-purple, #b180d7);
      border-radius: var(--ps-r-1);
      background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 12%, transparent);
      font-size: var(--ps-t-xs);
      line-height: 1.4;
    }

    /* ── Empty state ── */
    .empty-state {
      display: flex; flex-direction: column; align-items: center;
      padding: var(--ps-s-6) var(--ps-s-5); gap: var(--ps-s-3);
      color: var(--ps-fg-muted); text-align: center;
    }
    .empty-icon { color: var(--ps-fg-muted); display: inline-flex; }
    .empty-icon svg { width: 28px; height: 28px; }
    .empty-title { font-weight: 600; color: var(--ps-fg); }
    .empty-hint { font-size: var(--ps-t-sm); line-height: 1.5; }
    .empty-hint code { font-family: var(--vscode-editor-font-family); }

    /* ── Inline SVG icon base ── */
    .ps-i {
      display: inline-flex;
      vertical-align: -2px;
      flex-shrink: 0;
    }
    @keyframes ps-spin { to { transform: rotate(360deg); } }
    .icon-in_progress .ps-i {
      animation: ps-spin 1.4s linear infinite;
      transform-origin: 50% 50%;
    }
    .sync-chevron .ps-i { vertical-align: middle; opacity: 0.75; }
    .sync-chevron:hover .ps-i { opacity: 1; }

    /* ── Plan card ── */
    .plan-card {
      margin: 4px 8px;
      border: 1px solid var(--c-border);
      border-radius: var(--ps-r-2);
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
    .plan-header:hover .run-btn,
    .plan-header:hover .add-btn { opacity: 1; }
    .plan-header.drag-over { outline: 1px dashed rgba(86,156,214,0.6); outline-offset: -2px; }
    .plan-header.dragging { opacity: 0.75; }

    .plan-header-left {
      display: flex; align-items: center; gap: 6px;
      flex: 1; min-width: 0;
    }
    .plan-title {
      font-weight: 600; font-size: var(--ps-t-md);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .plan-header-right {
      display: flex; align-items: center; gap: 7px; flex-shrink: 0;
    }
    .plan-progress { font-size: var(--ps-t-xs); opacity: 0.55; white-space: nowrap; }
    .progress-bar {
      width: 44px; height: 3px;
      background: var(--ps-border-strong); border-radius: var(--ps-r-1); overflow: hidden;
    }
    .progress-fill {
      height: 100%; border-radius: var(--ps-r-1);
      background: var(--vscode-progressBar-background, var(--ps-c-accent));
      transition: width 0.3s ease;
    }

    /* ── Chevron ── */
    .chevron {
      font-size: 1em; display: inline-block; line-height: 1;
      transition: transform 0.15s ease; opacity: 0.55; flex-shrink: 0;
    }
    .chevron.expanded { transform: rotate(90deg); opacity: 0.9; }
    .chevron.sm { font-size: var(--ps-t-md); }
    .chevron-gap { display: inline-block; width: 13px; flex-shrink: 0; }

    /* ── Phases ── */
    .plan-phases { padding: 3px 0 4px; }

    .phase-row { margin: 1px 5px; border-radius: var(--ps-r-1); }

    .phase-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      padding: 4px 7px; gap: 5px; border-radius: var(--ps-r-1);
    }
    .phase-header:hover { background: var(--c-hover); }
    .phase-header:hover .run-btn,
    .phase-header:hover .add-btn { opacity: 1; }

    .phase-header-left {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 8px;
      row-gap: 0;
      align-items: start;
      flex: 1; min-width: 0; cursor: pointer; user-select: none;
    }
    .phase-header-lead {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      padding-top: 0.18em;
    }
    .phase-header-text {
      display: flex; flex-direction: column; gap: 2px;
      flex: 1; min-width: 0;
    }
    .phase-blocked-hint {
      font-size: var(--ps-t-xs);
      line-height: 1.35;
      color: var(--vscode-descriptionForeground, rgba(128, 128, 128, 0.95));
      white-space: normal;
      word-break: break-word;
    }
    .phase-status-dot {
      width: 7px; height: 7px; border-radius: var(--ps-r-pill); flex-shrink: 0;
      box-shadow: 0 0 4px currentColor;
      cursor: pointer; outline: none;
    }
    .phase-status-dot:hover { transform: scale(1.4); box-shadow: 0 0 6px currentColor; }
    .phase-status-dot:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--ps-c-accent)); outline-offset: 2px; }
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

    .phase-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .phase-title-row .phase-title {
      flex: 1;
      min-width: 0;
    }
    .phase-title {
      font-size: var(--ps-t-md);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .assignee-chip {
      font-size: var(--ps-t-xs);
      max-width: 88px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 1px 6px;
      border-radius: var(--ps-r-2);
      border: 1px solid var(--ps-border-strong);
      cursor: pointer;
      flex-shrink: 0;
      opacity: 0.9;
      line-height: 1.35;
    }
    .assignee-chip:hover {
      opacity: 1;
      background: var(--ps-border);
    }
    .assignee-placeholder {
      opacity: 0.55;
      font-style: italic;
    }
    .task-row .assignee-chip {
      max-width: 72px;
    }
    .graph-phase-assignee {
      font-size: var(--ps-t-xs);
      opacity: 0.9;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .phase-header-right {
      display: flex; align-items: center; gap: 5px; flex-shrink: 0;
      align-self: center;
    }

    /* ── Status badge ── */
    .badge {
      font-size: var(--ps-t-xs); padding: 1px 6px; border-radius: var(--ps-r-3);
      text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;
      white-space: nowrap;
    }
    .badge-completed  { background: var(--ps-fill-done);    color: var(--c-done); }
    .badge-in_progress{ background: var(--ps-fill-running); color: var(--c-running);
                        animation: pulse-badge 2s infinite; }
    .badge-failed     { background: var(--ps-fill-failed);  color: var(--c-failed); }
    .badge-pending    { background: var(--ps-fill-pending); color: var(--c-pending); }
    .badge-cancelled  { background: var(--ps-fill-pending); color: var(--c-cancelled); }

    @keyframes pulse-badge {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.75; }
    }

    /* ── Run button ── */
    .run-btn {
      font-size: var(--ps-t-xs); padding: 2px 8px; height: 20px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      border-radius: var(--ps-r-1);
      background: var(--vscode-button-background, var(--ps-c-accent));
      color: var(--vscode-button-foreground, white);
      white-space: nowrap; opacity: 0; transition: opacity 0.1s, background 0.1s;
      display: flex; align-items: center; gap: 3px;
    }
    .run-btn:hover { background: var(--vscode-button-hoverBackground); }

    .add-btn {
      font-size: var(--ps-t-xs); padding: 2px 7px; height: 20px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, var(--ps-border-strong));
      border-radius: var(--ps-r-1);
      background: transparent;
      color: var(--vscode-foreground);
      white-space: nowrap; opacity: 0; transition: opacity 0.1s, background 0.1s;
      display: flex; align-items: center; gap: 2px;
    }
    .add-btn:hover {
      background: var(--vscode-list-hoverBackground, var(--ps-border));
    }

    /* ── Tasks ── */
    .phase-tasks {
      padding: 2px 0 4px 14px;
      border-left: 1px solid var(--c-border);
      margin: 0 7px 0 17px;
    }

    .task-row {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 5px; border-radius: var(--ps-r-1); cursor: default;
    }
    .task-row.blocked { opacity: 0.75; }
    .task-row.needs-prompt:not(.blocked) {
      border-left: 2px solid var(--vscode-inputValidation-warningBorder, rgba(234, 179, 8, 0.75));
      padding-left: 4px;
      margin-left: -2px;
    }
    .task-needs-prompt-hint {
      font-size: var(--ps-t-xs);
      line-height: 1.35;
      color: var(--vscode-descriptionForeground, rgba(128, 128, 128, 0.95));
      flex-shrink: 0;
      white-space: nowrap;
    }
    .task-row:hover { background: var(--c-hover); }
    .task-row:hover .task-actions { opacity: 1; }

    .task-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; flex-shrink: 0;
      cursor: pointer; border-radius: var(--ps-r-1);
      outline: none; user-select: none;
    }
    .task-icon:hover { background: var(--ps-bg-hover); }
    .task-icon:focus-visible { box-shadow: 0 0 0 2px var(--vscode-focusBorder, var(--ps-c-accent)); }
    .icon-completed  { color: var(--c-done); }
    .icon-in_progress{ color: var(--c-running); }
    .icon-failed     { color: var(--c-failed); }
    .icon-cancelled  { color: var(--c-cancelled); }
    .icon-pending    { color: var(--c-pending); }

    .task-title {
      font-size: var(--ps-t-sm); flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      line-height: 1.4;
      cursor: pointer; user-select: none;
    }
    .task-title.strike { text-decoration: line-through; opacity: 0.55; }
    .task-deps-hint { opacity: 0.68; }

    .task-actions {
      display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; flex-shrink: 0;
    }
    .task-btn {
      width: 18px; height: 18px; padding: 0; display: flex;
      align-items: center; justify-content: center; cursor: pointer;
      border-radius: var(--ps-r-1); font-size: var(--ps-t-xs); border: none;
      background: transparent; line-height: 1;
    }
    .task-btn.run-task {
      width: auto;
      min-width: 18px;
      height: auto;
      min-height: 18px;
      padding: 2px 5px 2px 3px;
      gap: 3px;
    }
    .task-btn.done-btn  { color: var(--c-done); }
    .task-btn.done-btn:hover   { background: var(--ps-fill-done); }
    .task-btn.run-task  { color: var(--c-running); }
    .task-btn.run-task:hover   { background: var(--ps-fill-running); }
    .task-btn.cancel-btn{ color: var(--c-failed); }
    .task-btn.cancel-btn:hover { background: var(--ps-fill-failed); }
    .task-btn.reset-btn { color: var(--c-cancelled); }
    .task-btn.reset-btn:hover  { background: var(--ps-fill-pending); }
  </style>
</head>
<body>
  <div id="root">
    <div class="empty-state">
      <div class="empty-icon"><svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3" width="9" height="11" rx="1.2"/><rect x="6" y="1.8" width="4" height="2" rx="0.5"/><path d="M6 8 H10 M6 11 H9"/></svg></div>
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
  <script src="${labelsUri}"></script>
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
  const promptBody = prompt
    ? `<pre>${htmlEscape(prompt)}</pre>`
    : `<div class="subtle">No prompt provided for this task.</div>`;
  const promptSection = `<div class="section">
    <div class="row" style="margin-bottom: 6px; width: 100%; justify-content: space-between; align-items: center;">
      <div class="label" style="margin-bottom: 0;">Prompt</div>
      <button class="edit-btn" type="button" data-action="editTaskPrompt" title="Edit task prompt">✎</button>
    </div>
    ${promptBody}
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    ${PS_TOKENS_CSS}
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--ps-fg);
      background: var(--ps-bg-elevated);
      margin: 0;
      padding: var(--ps-s-4) var(--ps-s-5) var(--ps-s-5);
    }
    .h1 { font-size: var(--ps-t-lg); font-weight: 700; margin: 0 0 var(--ps-s-3); }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 10px;
      padding: 10px 12px;
      border: 1px solid var(--ps-border-strong);
      border-radius: var(--ps-r-2);
      background: var(--ps-bg-hover);
    }
    .k { opacity: 0.75; }
    .v { word-break: break-word; }
    .section { margin-top: 12px; }
    .label { font-weight: 700; margin-bottom: 6px; opacity: 0.9; }
    pre {
      margin: 0;
      padding: 10px 12px;
      border-radius: var(--ps-r-2);
      border: 1px solid var(--ps-border-strong);
      background: var(--vscode-textCodeBlock-background, var(--ps-border));
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-md);
      line-height: 1.45;
    }
    .subtle { opacity: 0.75; }
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
      opacity: 0.75;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: var(--ps-r-1);
      line-height: 1;
    }
    .edit-btn:hover { opacity: 1; background: var(--ps-border); }
    .toggle-btn {
      font: inherit;
      border: 1px solid var(--ps-border-strong);
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 1px 8px;
      border-radius: var(--ps-r-1);
      font-family: var(--vscode-editor-font-family);
      line-height: 1.4;
    }
    .toggle-btn:hover { background: var(--ps-border); border-color: var(--ps-border-strong); }
    .toggle-btn[data-value="true"] { color: var(--vscode-charts-green, var(--ps-c-done)); }
    .toggle-btn[data-value="false"] { color: var(--vscode-charts-red, var(--ps-c-failed)); }
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
    <div class="k">Assignee</div><div class="v"><span class="row"><span>${task.assignee?.trim() ? htmlEscape(task.assignee.trim()) : "—"}</span><button class="edit-btn" type="button" data-action="editTaskAssignee" title="Set assignee">✎</button></span></div>
  </div>
  ${promptSection}
  <script>
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "renameTask") {
        vscode.postMessage({ type: "renameTask", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)}, taskId: ${JSON.stringify(task.id)} });
      }
      if (action === "editTaskAssignee") {
        vscode.postMessage({ type: "editTaskAssignee", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)}, taskId: ${JSON.stringify(task.id)} });
      }
      if (action === "editTaskPrompt") {
        vscode.postMessage({ type: "editTaskPrompt", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)}, taskId: ${JSON.stringify(task.id)} });
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
  const phaseDeps = phase.dependsOn ?? [];
  const phaseDepsMarkup = phaseDeps.length
    ? phaseDeps.map((dep) => `<code>${htmlEscape(dep)}</code>`).join(", ")
    : `<span class="subtle">none</span>`;
  const tasksMarkup = tasks.length
    ? `<ul>${tasks
        .map((task) => {
          const asg = task.assignee?.trim();
          const asgLine = asg ? ` · assignee: ${htmlEscape(asg)}` : "";
          return `<li>
              <div><strong>${htmlEscape(task.desc)}</strong></div>
              <div class="subtle"><code>${htmlEscape(task.id)}</code> · <code>${htmlEscape(task.state)}</code> · commit=<code>${task.commit ? "true" : "false"}</code>${asgLine}</div>
            </li>`;
        })
        .join("")}</ul>`
    : `<div class="subtle">This phase has no tasks.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    ${PS_TOKENS_CSS}
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--ps-fg);
      background: var(--ps-bg-elevated);
      margin: 0;
      padding: var(--ps-s-4) var(--ps-s-5) var(--ps-s-5);
    }
    .h1 { font-size: var(--ps-t-lg); font-weight: 700; margin: 0 0 var(--ps-s-3); }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--ps-s-2) var(--ps-s-3);
      padding: var(--ps-s-3) var(--ps-s-4);
      border: 1px solid var(--ps-border);
      border-radius: var(--ps-r-2);
      background: var(--ps-bg-hover);
    }
    .k { color: var(--ps-fg-muted); }
    .v { word-break: break-word; }
    .section { margin-top: var(--ps-s-4); }
    ul { margin: var(--ps-s-3) 0 0; padding-left: var(--ps-s-5); }
    li { margin-bottom: var(--ps-s-3); }
    .subtle { color: var(--ps-fg-muted); }
    code { font-family: var(--vscode-editor-font-family); }
    .row { display: inline-flex; align-items: center; gap: var(--ps-s-3); min-width: 0; }
    .edit-btn {
      font: inherit;
      border: none;
      background: transparent;
      color: var(--ps-fg-muted);
      cursor: pointer;
      padding: var(--ps-s-1) var(--ps-s-2);
      border-radius: var(--ps-r-1);
      line-height: 1;
    }
    .edit-btn:hover { color: var(--ps-fg); background: var(--ps-bg-hover); }
    .overlay {
      position: fixed;
      inset: 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 60%, transparent);
      backdrop-filter: blur(2px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .modal {
      width: min(720px, calc(100vw - 28px));
      border-radius: var(--ps-r-3);
      border: 1px solid var(--ps-border-strong);
      background: var(--ps-bg-elevated);
      box-shadow: var(--ps-shadow-2);
      padding: var(--ps-s-4);
    }
    .modal-title { font-weight: 700; margin: 0 0 var(--ps-s-3); }
    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      padding: var(--ps-s-3) var(--ps-s-4);
      border-radius: var(--ps-r-2);
      border: 1px solid var(--ps-border);
      background: var(--vscode-textCodeBlock-background, var(--ps-bg-hover));
      color: var(--ps-fg);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-md);
      line-height: 1.45;
      outline: none;
    }
    textarea:focus { border-color: var(--ps-c-accent); }
    .modal-actions { display: flex; gap: var(--ps-s-3); justify-content: flex-end; margin-top: var(--ps-s-3); }
    .btn {
      font: inherit;
      border-radius: var(--ps-r-2);
      padding: var(--ps-s-2) var(--ps-s-3);
      cursor: pointer;
      border: 1px solid var(--ps-border-strong);
      background: transparent;
      color: inherit;
    }
    .btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .btn:hover { background: var(--ps-bg-hover); }
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
    <div class="k">Depends on</div><div class="v">${phaseDepsMarkup}</div>
    <div class="k">Assignee</div><div class="v"><span class="row"><span>${phase.assignee?.trim() ? htmlEscape(phase.assignee.trim()) : "—"}</span><button class="edit-btn" type="button" data-action="editPhaseAssignee" title="Set assignee">✎</button></span></div>
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
      if (action === "editPhaseAssignee") {
        vscode.postMessage({ type: "editPhaseAssignee", planId: ${JSON.stringify(plan.id)}, phaseId: ${JSON.stringify(phase.id)} });
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
    ${PS_TOKENS_CSS}
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--ps-fg);
      background: var(--ps-bg-elevated);
      margin: 0;
      padding: var(--ps-s-4) var(--ps-s-5) var(--ps-s-5);
    }
    .h1 { font-size: var(--ps-t-lg); font-weight: 700; margin: 0 0 var(--ps-s-3); }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--ps-s-2) var(--ps-s-3);
      padding: var(--ps-s-3) var(--ps-s-4);
      border: 1px solid var(--ps-border);
      border-radius: var(--ps-r-2);
      background: var(--ps-bg-hover);
    }
    .k { color: var(--ps-fg-muted); }
    .v { word-break: break-word; }
    .section { margin-top: var(--ps-s-4); }
    ul { margin: var(--ps-s-3) 0 0; padding-left: var(--ps-s-5); }
    li { margin-bottom: var(--ps-s-3); }
    .subtle { color: var(--ps-fg-muted); }
    code { font-family: var(--vscode-editor-font-family); }
    .row { display: inline-flex; align-items: center; gap: var(--ps-s-3); min-width: 0; }
    .edit-btn {
      font: inherit;
      border: none;
      background: transparent;
      color: var(--ps-fg-muted);
      cursor: pointer;
      padding: var(--ps-s-1) var(--ps-s-2);
      border-radius: var(--ps-r-1);
      line-height: 1;
    }
    .edit-btn:hover { color: var(--ps-fg); background: var(--ps-bg-hover); }
    .overlay {
      position: fixed;
      inset: 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 60%, transparent);
      backdrop-filter: blur(2px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .modal {
      width: min(720px, calc(100vw - 28px));
      border-radius: var(--ps-r-3);
      border: 1px solid var(--ps-border-strong);
      background: var(--ps-bg-elevated);
      box-shadow: var(--ps-shadow-2);
      padding: var(--ps-s-4);
    }
    .modal-title { font-weight: 700; margin: 0 0 var(--ps-s-3); }
    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      padding: var(--ps-s-3) var(--ps-s-4);
      border-radius: var(--ps-r-2);
      border: 1px solid var(--ps-border);
      background: var(--vscode-textCodeBlock-background, var(--ps-bg-hover));
      color: var(--ps-fg);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--ps-t-md);
      line-height: 1.45;
      outline: none;
    }
    textarea:focus { border-color: var(--ps-c-accent); }
    .modal-actions { display: flex; gap: var(--ps-s-3); justify-content: flex-end; margin-top: var(--ps-s-3); }
    .btn {
      font: inherit;
      border-radius: var(--ps-r-2);
      padding: var(--ps-s-2) var(--ps-s-3);
      cursor: pointer;
      border: 1px solid var(--ps-border-strong);
      background: transparent;
      color: inherit;
    }
    .btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .btn:hover { background: var(--ps-bg-hover); }
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
