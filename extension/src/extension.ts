import * as vscode from "vscode";
import { dispatchPhaseHandoff } from "./dispatch/router";
import { effectiveWorkBranch, summarizeGitForPlan } from "./git/resolver";
import { loadPlansFromWorkspace } from "./plan/loader";
import { buildPhaseHandoffPrompt } from "./plan/prompt";
import { CURSOR_API_KEY_SECRET } from "./plan/createPlanFromCli";
import { PlanstackChatWebview, CHAT_WEBVIEW_ID } from "./ui/planstackChatWebview";
import { PlanstackSidebarWebview, SIDEBAR_WEBVIEW_ID } from "./ui/planstackSidebarWebview";
import { PlanTreeProvider, PLAN_TREE_VIEW_ID, PhaseTreeItem } from "./ui/planTreeProvider";

async function refreshPlans(provider: PlanTreeProvider, sidebar: PlanstackSidebarWebview): Promise<void> {
  const plans = await loadPlansFromWorkspace();
  provider.setPlans(plans);
  sidebar.setPlanCount(plans.length);
}

export function activate(context: vscode.ExtensionContext): void {
  const extUri = context.extensionUri;
  const sidebarUi = new PlanstackSidebarWebview(extUri);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.runPhase", async (item: PhaseTreeItem | vscode.TreeItem) => {
      if (!(item instanceof PhaseTreeItem)) {
        await vscode.window.showInformationMessage(
          "Run phase from the Planstack sidebar: expand a plan, then use Run on a phase.",
        );
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const git = root
        ? await summarizeGitForPlan(root, item.phase, item.plan)
        : { effectiveBranch: undefined, currentBranchLabel: undefined, hasGitRepository: false };
      const eff = effectiveWorkBranch(item.phase, item.plan);
      const prompt = buildPhaseHandoffPrompt(item.plan, item.phase, {
        currentHead: git.currentBranchLabel,
        effectiveWorkBranch: eff,
        baseBranch: item.plan.git?.baseBranch,
      });
      await dispatchPhaseHandoff(prompt);
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
      await dispatchPhaseHandoff(demo);
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
