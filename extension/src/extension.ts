import * as vscode from "vscode";
import { handoffToNativeComposer } from "./dispatch/cursorNativeHandoff";
import { dispatchPhaseHandoff } from "./dispatch/router";
import { ensurePlanWorkBranch } from "./git/ensurePlanWorkBranch";
import { effectiveWorkBranch, summarizeGitForPlan } from "./git/resolver";
import { loadPlansFromWorkspace } from "./plan/loader";
import { buildPhaseHandoffPrompt } from "./plan/prompt";
import { CURSOR_API_KEY_SECRET } from "./plan/createPlanFromCli";
import { PlanstackChatWebview, CHAT_WEBVIEW_ID } from "./ui/planstackChatWebview";
import { PlanstackSidebarWebview, SIDEBAR_WEBVIEW_ID } from "./ui/planstackSidebarWebview";
import { PlanTreeProvider, PLAN_TREE_VIEW_ID, PhaseTreeItem } from "./ui/planTreeProvider";

let currentPlans: import("./plan/types").Plan[] = [];

async function refreshPlans(provider: PlanTreeProvider, sidebar: PlanstackSidebarWebview): Promise<void> {
  currentPlans = await loadPlansFromWorkspace();
  provider.setPlans(currentPlans);
  sidebar.setPlans(currentPlans);
}

export function activate(context: vscode.ExtensionContext): void {
  const extUri = context.extensionUri;
  const sidebarUi = new PlanstackSidebarWebview(extUri, async (planId, phaseId) => {
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
    await dispatchPhaseHandoff(prompt);
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR_WEBVIEW_ID, sidebarUi));

  const tree = new PlanTreeProvider();
  const view = vscode.window.createTreeView(PLAN_TREE_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  const chatUi = new PlanstackChatWebview(extUri, context, async () => {
    await refreshPlans(tree, sidebarUi);
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(CHAT_WEBVIEW_ID, chatUi));

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.refresh", async () => {
      await refreshPlans(tree, sidebarUi);
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
    vscode.commands.registerCommand("hackupc.nativeHandoff.demo", async () => {
      const demo =
        `HackUPC native handoff demo (${new Date().toISOString()}):\n\n` +
        `Summarize docs/base_idea.md in two bullet points. Only that file for context.`;
      await handoffToNativeComposer(demo);
    }),
  );

  void refreshPlans(tree, sidebarUi);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshPlans(tree, sidebarUi);
    }),
  );
}

export function deactivate(): void {}
