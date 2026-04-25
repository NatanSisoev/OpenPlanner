import * as vscode from "vscode";
import { handoffToNativeComposer } from "./dispatch/cursorNativeHandoff";
import { dispatchPhaseHandoff } from "./dispatch/router";
import { ensurePlanWorkBranch } from "./git/ensurePlanWorkBranch";
import { effectiveWorkBranch, summarizeGitForPlan } from "./git/resolver";
import { loadPlansFromWorkspace, watchPlans } from "./plan/loader";
import { deriveAggregateState } from "./plan/aggregate";
import { buildPhaseHandoffPrompt } from "./plan/prompt";
import { CURSOR_API_KEY_SECRET } from "./plan/createPlanFromCli";
import { debugCliConnection } from "./plan/debugCliConnection";
import { savePlanPreservingFile } from "./plan/writePlan";
import { PlanstackChatWebview, CHAT_WEBVIEW_ID } from "./ui/planstackChatWebview";
import { PlanstackSidebarWebview, SIDEBAR_WEBVIEW_ID } from "./ui/planstackSidebarWebview";
import { PlanTreeProvider, PLAN_TREE_VIEW_ID, PhaseTreeItem, TaskTreeItem } from "./ui/planTreeProvider";
import { WORK_STATES, type ExecutionState } from "./plan/types";

let currentPlans: import("./plan/types").Plan[] = [];

const PLAN_ORDER_KEY = "hackupc.planstack.planOrder";

function slugifyId(value: string): string {
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s.length ? s : "item";
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  let i = 2;
  while (taken.has(`${base}-${i}`)) {
    i += 1;
  }
  return `${base}-${i}`;
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

  async function refreshPlansOrdered(provider: PlanTreeProvider, sidebar: PlanstackSidebarWebview): Promise<void> {
    const loaded = await loadPlansFromWorkspace();
    const savedOrder = context.workspaceState.get<string[]>(PLAN_ORDER_KEY);
    currentPlans = orderPlans(loaded, savedOrder);
    provider.setPlans(currentPlans);
    sidebar.setPlans(currentPlans);
  }

  async function createPlan(input: { title: string; description?: string }): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
      return false;
    }
    const trimmedTitle = input.title.trim();
    if (!trimmedTitle) {
      void vscode.window.showWarningMessage("Planstack: plan title is required.");
      return false;
    }
    const existingPlanIds = new Set(currentPlans.map((p) => p.id));
    const planId = uniqueId(`plan-${slugifyId(trimmedTitle)}`, existingPlanIds);
    const plan: import("./plan/types").Plan = {
      id: planId,
      state: "pending",
      title: trimmedTitle,
      description: input.description?.trim() || undefined,
      createdAt: new Date().toISOString(),
      phases: [],
    };
    await savePlanPreservingFile(plan, root);
    await refreshPlansOrdered(tree, sidebarUi);
    return true;
  }

  async function createPhase(input: { planId: string; title: string; description?: string }): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
      return false;
    }
    const plan = currentPlans.find((p) => p.id === input.planId);
    if (!plan) {
      void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
      return false;
    }
    const trimmedTitle = input.title.trim();
    if (!trimmedTitle) {
      void vscode.window.showWarningMessage("Planstack: phase title is required.");
      return false;
    }
    const existingPhaseIds = new Set((plan.phases ?? []).map((p) => p.id));
    const phaseId = uniqueId(`phase-${slugifyId(trimmedTitle)}`, existingPhaseIds);
    plan.phases.push({
      id: phaseId,
      state: "pending",
      title: trimmedTitle,
      description: input.description?.trim() || "",
      tasks: [],
    });
    plan.state = deriveAggregateState(plan.phases.map((p) => p.state));
    await savePlanPreservingFile(plan, root);
    await refreshPlansOrdered(tree, sidebarUi);
    return true;
  }

  async function createTask(input: {
    planId: string;
    phaseId: string;
    desc: string;
    prompt?: string;
    commit: boolean;
  }): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
      return false;
    }
    const plan = currentPlans.find((p) => p.id === input.planId);
    const phase = plan?.phases.find((ph) => ph.id === input.phaseId);
    if (!plan || !phase) {
      void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
      return false;
    }
    const trimmedDesc = input.desc.trim();
    if (!trimmedDesc) {
      void vscode.window.showWarningMessage("Planstack: task title is required.");
      return false;
    }
    const existingTaskIds = new Set((phase.tasks ?? []).map((t) => t.id));
    const taskId = uniqueId(`task-${slugifyId(trimmedDesc)}`, existingTaskIds);
    phase.tasks.push({
      id: taskId,
      state: "pending",
      desc: trimmedDesc,
      commit: input.commit,
      prompt: input.prompt?.trim() || undefined,
    });
    phase.state = deriveAggregateState(phase.tasks.map((t) => t.state));
    plan.state = deriveAggregateState(plan.phases.map((p) => p.state));
    await savePlanPreservingFile(plan, root);
    await refreshPlansOrdered(tree, sidebarUi);
    return true;
  }

  const sidebarUi = new PlanstackSidebarWebview(
    extUri,
    async (planId, phaseId) => {
      const plan = currentPlans.find((p) => p.id === planId);
      const phase = plan?.phases.find((ph) => ph.id === phaseId);
      if (!plan || !phase) {
        void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
        return;
      }
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
      await dispatchPhaseHandoff(prompt, context, {
        statusLabel: `${plan.title} › ${phase.title}`,
      });
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
      if (patch.title !== undefined) {
        phase.title = patch.title;
      }
      if (patch.description !== undefined) {
        phase.description = patch.description;
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
    async (planId, patch) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
        return false;
      }
      const plan = currentPlans.find((p) => p.id === planId);
      if (!plan) {
        void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
        return false;
      }
      if (patch.title !== undefined) {
        plan.title = patch.title;
      }
      if (patch.description !== undefined) {
        (plan as { description?: string }).description = patch.description;
      }

      await savePlanPreservingFile(plan, root);
      await refreshPlansOrdered(tree, sidebarUi);
      return true;
    },
    async ({ title, description }) => {
      const ok = await createPlan({ title, description });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: created plan "${title.trim()}".`);
      }
    },
    async ({ planId, title, description }) => {
      const ok = await createPhase({ planId, title, description });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: added phase "${title.trim()}".`);
      }
    },
    async ({ planId, phaseId, desc, prompt, commit }) => {
      const ok = await createTask({ planId, phaseId, desc, prompt, commit });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: added task "${desc.trim()}".`);
      }
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

  const chatUi = new PlanstackChatWebview(extUri, context, async () => {
    await refreshPlansOrdered(tree, sidebarUi);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_WEBVIEW_ID, chatUi, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.createPlan", async () => {
      const title = await vscode.window.showInputBox({
        title: "Planstack: Add Plan",
        prompt: "Plan title",
        placeHolder: "E.g. Launch onboarding MVP",
        ignoreFocusOut: true,
      });
      if (title === undefined) return;
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        void vscode.window.showWarningMessage("Planstack: plan title is required.");
        return;
      }
      const description = await vscode.window.showInputBox({
        title: "Planstack: Add Plan",
        prompt: "Description (optional)",
        placeHolder: "Short summary for your team",
        ignoreFocusOut: true,
      });
      const ok = await createPlan({ title: trimmedTitle, description: description ?? undefined });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: created plan "${trimmedTitle}".`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.createPhase", async () => {
      if (!currentPlans.length) {
        void vscode.window.showWarningMessage("Planstack: no plans found. Create a plan first.");
        return;
      }
      const planPick = await vscode.window.showQuickPick(
        currentPlans.map((plan) => ({
          label: plan.title,
          description: plan.id,
          planId: plan.id,
        })),
        {
          title: "Planstack: Add Phase",
          placeHolder: "Select plan",
          ignoreFocusOut: true,
        },
      );
      if (!planPick) return;

      const title = await vscode.window.showInputBox({
        title: "Planstack: Add Phase",
        prompt: "Phase title",
        placeHolder: "E.g. API implementation",
        ignoreFocusOut: true,
      });
      if (title === undefined) return;
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        void vscode.window.showWarningMessage("Planstack: phase title is required.");
        return;
      }
      const description = await vscode.window.showInputBox({
        title: "Planstack: Add Phase",
        prompt: "Description (optional)",
        placeHolder: "What should be completed in this phase?",
        ignoreFocusOut: true,
      });

      const ok = await createPhase({
        planId: planPick.planId,
        title: trimmedTitle,
        description: description ?? undefined,
      });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: added phase "${trimmedTitle}".`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.createTask", async () => {
      if (!currentPlans.length) {
        void vscode.window.showWarningMessage("Planstack: no plans found. Create a plan first.");
        return;
      }
      const planPick = await vscode.window.showQuickPick(
        currentPlans.map((plan) => ({
          label: plan.title,
          description: `${plan.phases.length} phases`,
          detail: plan.id,
          planId: plan.id,
        })),
        {
          title: "Planstack: Add Task",
          placeHolder: "Select plan",
          ignoreFocusOut: true,
        },
      );
      if (!planPick) return;

      const selectedPlan = currentPlans.find((p) => p.id === planPick.planId);
      const phases = selectedPlan?.phases ?? [];
      if (!phases.length) {
        void vscode.window.showWarningMessage("Planstack: selected plan has no phases. Add a phase first.");
        return;
      }

      const phasePick = await vscode.window.showQuickPick(
        phases.map((phase) => ({
          label: phase.title,
          description: phase.state,
          detail: phase.id,
          phaseId: phase.id,
        })),
        {
          title: "Planstack: Add Task",
          placeHolder: "Select phase",
          ignoreFocusOut: true,
        },
      );
      if (!phasePick) return;

      const desc = await vscode.window.showInputBox({
        title: "Planstack: Add Task",
        prompt: "Task title",
        placeHolder: "E.g. Build login endpoint",
        ignoreFocusOut: true,
      });
      if (desc === undefined) return;
      const trimmedDesc = desc.trim();
      if (!trimmedDesc) {
        void vscode.window.showWarningMessage("Planstack: task title is required.");
        return;
      }

      const prompt = await vscode.window.showInputBox({
        title: "Planstack: Add Task",
        prompt: "Task prompt (optional)",
        placeHolder: "Implementation instructions for the executor",
        ignoreFocusOut: true,
      });
      const commitPick = await vscode.window.showQuickPick(
        [
          { label: "No commit required", value: false },
          { label: "Require commit on completion", value: true },
        ],
        {
          title: "Planstack: Add Task",
          placeHolder: "Commit behavior",
          ignoreFocusOut: true,
        },
      );
      if (!commitPick) return;

      const ok = await createTask({
        planId: planPick.planId,
        phaseId: phasePick.phaseId,
        desc: trimmedDesc,
        prompt: prompt ?? undefined,
        commit: commitPick.value,
      });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: added task "${trimmedDesc}".`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.refresh", async () => {
      await refreshPlansOrdered(tree, sidebarUi);
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
      const phaseItem = resolvePhaseTreeItem(item);
      if (!phaseItem) {
        await vscode.window.showInformationMessage(
          "Run phase from the Planstack sidebar: expand a plan, then use Run on a phase.",
        );
        return;
      }
      const branchOk = await ensurePlanWorkBranch(phaseItem.plan, context.workspaceState);
      if (!branchOk) {
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
      await dispatchPhaseHandoff(prompt, context, {
        statusLabel: `${phaseItem.plan.title} › ${phaseItem.phase.title}`,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.setCursorApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "Cursor API key (Planstack / agent CLI)",
        prompt: "Stored in VS Code Secret Storage as CURSOR_API_KEY when spawning agent. Leave empty to clear.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      if (!value.trim()) {
        await context.secrets.delete(CURSOR_API_KEY_SECRET);
        void vscode.window.showInformationMessage("Planstack: cleared stored Cursor API key.");
        return;
      }
      await context.secrets.store(CURSOR_API_KEY_SECRET, value.trim());
      void vscode.window.showInformationMessage("Planstack: Cursor API key saved for this profile.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.debugCliConnection", async () => {
      await debugCliConnection(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.nativeHandoff.demo", async () => {
      const demo =
        `HackUPC native handoff demo (${new Date().toISOString()}):\n\n` +
        `Summarize docs/base_idea.md in two bullet points. Only that file for context.`;
      await handoffToNativeComposer(demo);
    }),
  );

  for (const state of WORK_STATES) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`hackupc.planstack.taskSetState.${state}`, async (item: unknown) => {
        const taskItem = resolveTaskTreeItem(item);
        if (!taskItem) {
          await vscode.window.showInformationMessage(
            "Set task state from the Planstack sidebar: right-click a task, then pick Set state.",
          );
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
          return;
        }

        taskItem.task.state = state;
        taskItem.phase.state = deriveAggregateState(taskItem.phase.tasks.map((t) => t.state));
        taskItem.plan.state = deriveAggregateState(taskItem.plan.phases.map((p) => p.state));

        await savePlanPreservingFile(taskItem.plan, root);
        await refreshPlansOrdered(tree, sidebarUi);
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

