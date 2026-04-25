import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "./debug/trace";
import { handoffToNativeComposer } from "./dispatch/cursorNativeHandoff";
import type { CliPhaseRunFinishedKind } from "./dispatch/cursorCli";
import { dispatchPhaseHandoff } from "./dispatch/router";
import { ensurePlanWorkBranch } from "./git/ensurePlanWorkBranch";
import { effectiveWorkBranch, summarizeGitForPlan } from "./git/resolver";
import { loadPlansFromWorkspace, watchPlans } from "./plan/loader";
import { deriveAggregateState, recomputeAggregates } from "./plan/aggregate";
import { buildPhaseHandoffPrompt } from "./plan/prompt";
import { CURSOR_API_KEY_SECRET } from "./plan/createPlanFromCli";
import { debugCliConnection } from "./plan/debugCliConnection";
import { killAllAgentCliProcesses } from "./plan/agentCliRunner";
import { logLine } from "./log";
import { savePlanPreservingFile } from "./plan/writePlan";
import { PlanstackChatWebview, CHAT_WEBVIEW_ID } from "./ui/planstackChatWebview";
import { PlanstackSidebarWebview, SIDEBAR_WEBVIEW_ID } from "./ui/planstackSidebarWebview";
import { PlanTreeProvider, PLAN_TREE_VIEW_ID, PhaseTreeItem, TaskTreeItem } from "./ui/planTreeProvider";
import { WORK_STATES, type ExecutionState } from "./plan/types";

let currentPlans: import("./plan/types").Plan[] = [];

const PLAN_ORDER_KEY = "hackupc.planstack.planOrder";

function summarizeCommandArg(arg: unknown): unknown {
  if (arg === undefined) {
    return undefined;
  }
  if (arg instanceof PhaseTreeItem) {
    return {
      kind: "PhaseTreeItem",
      planId: arg.plan.id,
      phaseId: arg.phase.id,
      planTitle: arg.plan.title,
      phaseTitle: arg.phase.title,
    };
  }
  if (arg instanceof TaskTreeItem) {
    return {
      kind: "TaskTreeItem",
      planId: arg.plan.id,
      phaseId: arg.phase.id,
      taskId: arg.task.id,
      taskDesc: arg.task.desc,
    };
  }
  if (Array.isArray(arg)) {
    return { kind: "array", length: arg.length, first: summarizeCommandArg(arg[0]) };
  }
  return { kind: typeof arg };
}

function orderPlans(plans: import("./plan/types").Plan[], orderedIds: string[] | undefined): import("./plan/types").Plan[] {
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  const withKeys = plans.map((p, originalIdx) => ({
    p,
    k: index.has(p.id) ? index.get(p.id)! : Number.POSITIVE_INFINITY,
    originalIdx,
  }));
  withKeys.sort((a, b) => {
    if (a.k !== b.k) return a.k - b.k;
    return a.originalIdx - b.originalIdx;
  });
  return withKeys.map((x) => x.p);
}

export function activate(context: vscode.ExtensionContext): void {
  const extUri = context.extensionUri;

  const phaseRunHooks: {
    applyOutcome?: (planId: string, phaseId: string, outcome: CliPhaseRunFinishedKind) => Promise<void>;
  } = {};

  async function refreshPlansOrdered(provider: PlanTreeProvider, sidebar: PlanstackSidebarWebview): Promise<void> {
    const loaded = await loadPlansFromWorkspace();
    const savedOrder = context.workspaceState.get<string[]>(PLAN_ORDER_KEY);
    currentPlans = orderPlans(loaded, savedOrder);
    provider.setPlans(currentPlans);
    sidebar.setPlans(currentPlans);
  }

  const sidebarUi = new PlanstackSidebarWebview(
    extUri,
    async (planId, phaseId) => {
      const tid = newTraceId("runphase-sidebar");
      traceEvent(tid, "runphase.sidebar.enter", { planId, phaseId });
      traceEvent(tid, "runphase.branch_prep", {
        path: "sidebar_webview",
        note: "ensurePlanWorkBranch is not invoked on this path (tree command path does).",
      });
      try {
        const plan = currentPlans.find((p) => p.id === planId);
        const phase = plan?.phases.find((ph) => ph.id === phaseId);
        if (!plan || !phase) {
          traceEvent(tid, "runphase.sidebar.abort", { reason: "phase_not_found" });
          void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
          return;
        }
        traceEvent(tid, "runphase.sidebar.resolved", {
          planTitle: plan.title,
          phaseTitle: phase.title,
        });
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const git = root
          ? await summarizeGitForPlan(root, phase, plan)
          : { effectiveBranch: undefined, currentBranchLabel: undefined, hasGitRepository: false };
        const eff = effectiveWorkBranch(phase, plan);
        const prompt = buildPhaseHandoffPrompt(plan, phase, {
          currentHead: git.currentBranchLabel,
          effectiveWorkBranch: eff,
          baseBranch: plan.git?.baseBranch,
        });
        traceMultiline(tid, "runphase.generated_prompt", prompt);
        traceEvent(tid, "runphase.dispatch", {
          statusLabel: `${plan.title} › ${phase.title}`,
          traceId: tid,
        });
        await dispatchPhaseHandoff(prompt, context, {
          statusLabel: `${plan.title} › ${phase.title}`,
          traceId: tid,
          onCliRunFinished: (kind) =>
            phaseRunHooks.applyOutcome ? phaseRunHooks.applyOutcome(planId, phaseId, kind) : Promise.resolve(),
        });
        traceEvent(tid, "runphase.sidebar.exit", { ok: true });
      } catch (e) {
        traceEvent(tid, "runphase.sidebar.exit", {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof Error && e.stack) {
          traceMultiline(tid, "runphase.sidebar.error.stack", e.stack);
        }
        throw e;
      }
    },
    async (planId, phaseId, patch) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
        return false;
      }
      const plan = currentPlans.find((p) => p.id === planId);
      const phase = plan?.phases.find((ph) => ph.id === phaseId);
      if (!plan || !phase) {
        void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
        return false;
      }

      if (patch.state) {
        phase.state = patch.state;
      }
      plan.state = deriveAggregateState(plan.phases.map((p) => p.state));

      await savePlanPreservingFile(plan, root);
      await refreshPlansOrdered(tree, sidebarUi);
      return true;
    },
    async (planId, phaseId, taskId, patch) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
        return false;
      }
      const plan = currentPlans.find((p) => p.id === planId);
      const phase = plan?.phases.find((ph) => ph.id === phaseId);
      const task = phase?.tasks.find((t) => t.id === taskId);
      if (!plan || !phase || !task) {
        void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
        return false;
      }

      if (patch.state) {
        task.state = patch.state;
      }
      if (patch.desc !== undefined) {
        task.desc = patch.desc;
      }
      if (patch.prompt !== undefined) {
        task.prompt = patch.prompt;
      }
      if (patch.commit !== undefined) {
        task.commit = patch.commit;
      }

      // Keep phase and plan states in sync after task-level edits.
      phase.state = deriveAggregateState(phase.tasks.map((t) => t.state));
      plan.state = deriveAggregateState(plan.phases.map((p) => p.state));

      await savePlanPreservingFile(plan, root);
      await refreshPlansOrdered(tree, sidebarUi);
      return true;
    },
    async (orderedPlanIds) => {
      const loadedIds = new Set(currentPlans.map((p) => p.id));
      const cleaned = orderedPlanIds.filter((id) => loadedIds.has(id));
      await context.workspaceState.update(PLAN_ORDER_KEY, cleaned);
      await refreshPlansOrdered(tree, sidebarUi);
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_WEBVIEW_ID, sidebarUi, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const tree = new PlanTreeProvider();
  const view = vscode.window.createTreeView(PLAN_TREE_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  phaseRunHooks.applyOutcome = async (
    planId: string,
    phaseId: string,
    outcome: CliPhaseRunFinishedKind,
  ): Promise<void> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    try {
      const loaded = await loadPlansFromWorkspace();
      const ordered = orderPlans(loaded, context.workspaceState.get<string[]>(PLAN_ORDER_KEY));
      const plan = ordered.find((p) => p.id === planId);
      const phase = plan?.phases.find((ph) => ph.id === phaseId);
      if (!plan || !phase) {
        logLine(`applyPhaseRunOutcome: missing plan/phase ${planId}/${phaseId}`);
        return;
      }

      if (outcome === "success") {
        phase.state = "completed";
        for (const t of phase.tasks) {
          if (t.state !== "cancelled" && t.state !== "failed") {
            t.state = "completed";
          }
        }
      } else if (outcome === "stopped") {
        phase.state = "cancelled";
        for (const t of phase.tasks) {
          if (t.state === "in_progress") {
            t.state = "cancelled";
          }
        }
      } else {
        phase.state = "failed";
        for (const t of phase.tasks) {
          if (t.state === "in_progress") {
            t.state = "failed";
          }
        }
      }
      recomputeAggregates(plan);
      await savePlanPreservingFile(plan, root);
      await refreshPlansOrdered(tree, sidebarUi);
    } catch (e) {
      logLine(`applyPhaseRunOutcome: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const chatUi = new PlanstackChatWebview(extUri, context, async () => {
    await refreshPlansOrdered(tree, sidebarUi);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_WEBVIEW_ID, chatUi, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.refresh", async () => {
      const tid = newTraceId("cmd-refresh");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.refresh" });
      try {
        await refreshPlansOrdered(tree, sidebarUi);
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.refresh", ok: true });
      } catch (e) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.refresh",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }),
  );

  function resolvePhaseTreeItem(arg: unknown): PhaseTreeItem | undefined {
    if (arg instanceof PhaseTreeItem) {
      return arg;
    }
    if (Array.isArray(arg)) {
      const first = arg[0];
      if (first instanceof PhaseTreeItem) {
        return first;
      }
    }
    return undefined;
  }

  function resolveTaskTreeItem(arg: unknown): TaskTreeItem | undefined {
    if (arg instanceof TaskTreeItem) {
      return arg;
    }
    if (Array.isArray(arg)) {
      const first = arg[0];
      if (first instanceof TaskTreeItem) {
        return first;
      }
    }
    return undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.runPhase", async (item: unknown) => {
      const tid = newTraceId("runphase-tree");
      traceEvent(tid, "command.enter", {
        command: "hackupc.planstack.runPhase",
        arg: summarizeCommandArg(item),
      });
      try {
        const phaseItem = resolvePhaseTreeItem(item);
        if (!phaseItem) {
          traceEvent(tid, "runphase.tree.abort", { reason: "no_phase_tree_item" });
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.runPhase",
            ok: true,
            skipped: "no_phase_tree_item",
          });
          await vscode.window.showInformationMessage(
            "Run phase from the Planstack sidebar: expand a plan, then use Run on a phase.",
          );
          return;
        }
        traceEvent(tid, "runphase.tree.resolved", {
          planId: phaseItem.plan.id,
          phaseId: phaseItem.phase.id,
          planTitle: phaseItem.plan.title,
          phaseTitle: phaseItem.phase.title,
        });
        const branchOk = await ensurePlanWorkBranch(phaseItem.plan, context.workspaceState);
        traceEvent(tid, "runphase.branch_prep", { path: "tree_command", ok: branchOk });
        if (!branchOk) {
          traceEvent(tid, "runphase.tree.abort", { reason: "branch_prep_failed" });
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.runPhase",
            ok: true,
            skipped: "branch_prep_failed",
          });
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const git = root
          ? await summarizeGitForPlan(root, phaseItem.phase, phaseItem.plan)
          : { effectiveBranch: undefined, currentBranchLabel: undefined, hasGitRepository: false };
        const eff = effectiveWorkBranch(phaseItem.phase, phaseItem.plan);
        const prompt = buildPhaseHandoffPrompt(phaseItem.plan, phaseItem.phase, {
          currentHead: git.currentBranchLabel,
          effectiveWorkBranch: eff,
          baseBranch: phaseItem.plan.git?.baseBranch,
        });
        traceMultiline(tid, "runphase.generated_prompt", prompt);
        if (root) {
          phaseItem.phase.state = "in_progress";
          phaseItem.plan.state = deriveAggregateState(phaseItem.plan.phases.map((p) => p.state));
          await savePlanPreservingFile(phaseItem.plan, root);
          await refreshPlansOrdered(tree, sidebarUi);
        }
        traceEvent(tid, "runphase.dispatch", {
          statusLabel: `${phaseItem.plan.title} › ${phaseItem.phase.title}`,
          traceId: tid,
        });
        await dispatchPhaseHandoff(prompt, context, {
          statusLabel: `${phaseItem.plan.title} › ${phaseItem.phase.title}`,
          traceId: tid,
          onCliRunFinished: (kind) =>
            phaseRunHooks.applyOutcome
              ? phaseRunHooks.applyOutcome(phaseItem.plan.id, phaseItem.phase.id, kind)
              : Promise.resolve(),
        });
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.runPhase", ok: true });
      } catch (e) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.runPhase",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof Error && e.stack) {
          traceMultiline(tid, "runphase.tree.error.stack", e.stack);
        }
        throw e;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.setCursorApiKey", async () => {
      const tid = newTraceId("cmd-setkey");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.setCursorApiKey" });
      const value = await vscode.window.showInputBox({
        title: "Cursor API key (Planstack / agent CLI)",
        prompt: "Stored in VS Code Secret Storage as CURSOR_API_KEY when spawning agent. Leave empty to clear.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.setCursorApiKey", ok: true, cancelled: true });
        return;
      }
      if (!value.trim()) {
        await context.secrets.delete(CURSOR_API_KEY_SECRET);
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.setCursorApiKey", ok: true, cleared: true });
        void vscode.window.showInformationMessage("Planstack: cleared stored Cursor API key.");
        return;
      }
      await context.secrets.store(CURSOR_API_KEY_SECRET, value.trim());
      traceEvent(tid, "command.exit", {
        command: "hackupc.planstack.setCursorApiKey",
        ok: true,
        storedChars: value.trim().length,
      });
      void vscode.window.showInformationMessage("Planstack: Cursor API key saved for this profile.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.debugCliConnection", async () => {
      const tid = newTraceId("cmd-debugcli");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.debugCliConnection" });
      try {
        await debugCliConnection(context);
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.debugCliConnection", ok: true });
      } catch (e) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.debugCliConnection",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.killAgentRuns", () => {
      const tid = newTraceId("cmd-killagents");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.killAgentRuns" });
      const n = killAllAgentCliProcesses();
      traceEvent(tid, "command.killAgentRuns", { processesSignaled: n });
      const msg =
        n > 0
          ? `Sent SIGTERM to ${n} agent process(es). In-flight runs will abort.`
          : "No Planstack agent process was running.";
      void vscode.window.showInformationMessage(`Planstack: ${msg}`);
      traceEvent(tid, "command.exit", { command: "hackupc.planstack.killAgentRuns", ok: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.nativeHandoff.demo", async () => {
      const tid = newTraceId("cmd-nativeDemo");
      traceEvent(tid, "command.enter", { command: "hackupc.nativeHandoff.demo" });
      try {
        const demo =
          `HackUPC native handoff demo (${new Date().toISOString()}):\n\n` +
          `Summarize docs/base_idea.md in two bullet points. Only that file for context.`;
        traceMultiline(tid, "nativeHandoff.demo.prompt", demo);
        await handoffToNativeComposer(demo);
        traceEvent(tid, "command.exit", { command: "hackupc.nativeHandoff.demo", ok: true });
      } catch (e) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.nativeHandoff.demo",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }),
  );

  for (const state of WORK_STATES) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`hackupc.planstack.taskSetState.${state}`, async (item: unknown) => {
        const tid = newTraceId("cmd-taskSetState");
        traceEvent(tid, "command.enter", {
          command: `hackupc.planstack.taskSetState.${state}`,
          arg: summarizeCommandArg(item),
        });
        const taskItem = resolveTaskTreeItem(item);
        if (!taskItem) {
          traceEvent(tid, "command.exit", {
            command: `hackupc.planstack.taskSetState.${state}`,
            ok: true,
            skipped: "no_task_item",
          });
          await vscode.window.showInformationMessage(
            "Set task state from the Planstack sidebar: right-click a task, then pick Set state.",
          );
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          traceEvent(tid, "command.exit", {
            command: `hackupc.planstack.taskSetState.${state}`,
            ok: true,
            skipped: "no_workspace",
          });
          void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
          return;
        }

        taskItem.task.state = state;
        taskItem.phase.state = deriveAggregateState(taskItem.phase.tasks.map((t) => t.state));
        taskItem.plan.state = deriveAggregateState(taskItem.plan.phases.map((p) => p.state));

        await savePlanPreservingFile(taskItem.plan, root);
        await refreshPlansOrdered(tree, sidebarUi);
        traceEvent(tid, "command.exit", {
          command: `hackupc.planstack.taskSetState.${state}`,
          ok: true,
          planId: taskItem.plan.id,
          phaseId: taskItem.phase.id,
          taskId: taskItem.task.id,
        });
      }),
    );
  }

  void refreshPlansOrdered(tree, sidebarUi);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshPlansOrdered(tree, sidebarUi);
    }),
    watchPlans(() => {
      void refreshPlansOrdered(tree, sidebarUi);
    }),
  );
}

export function deactivate(): void {}

