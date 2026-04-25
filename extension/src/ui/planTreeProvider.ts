import * as vscode from "vscode";
import { summarizeGitForPlan } from "../git/resolver";
import type { Phase, Plan } from "../plan/types";

export const PLAN_TREE_VIEW_ID = "hackupc.planstackPlans";

export const PHASE_CONTEXT = "hackupcPhase";

export class PhaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly plan: Plan,
    public readonly phase: Phase,
    label: string,
    description?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = PHASE_CONTEXT;
    this.description = description;
    const preview = phase.body.length > 400 ? `${phase.body.slice(0, 400)}…` : phase.body;
    this.tooltip = `${phase.title}\n\n${preview}`;
    this.iconPath = statusIcon(phase.status);
  }
}

export class PlanTreeItem extends vscode.TreeItem {
  constructor(
    public readonly plan: Plan,
    label: string,
    state: vscode.TreeItemCollapsibleState,
  ) {
    super(label, state);
    this.contextValue = "hackupcPlan";
    this.description = `${plan.phases.length} phase(s)`;
    this.tooltip = plan.title;
    this.iconPath = new vscode.ThemeIcon("list-tree");
  }
}

function statusIcon(status: Phase["status"]): vscode.ThemeIcon {
  switch (status) {
    case "done":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "in_progress":
      return new vscode.ThemeIcon("sync~spin");
    case "blocked":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    default:
      return new vscode.ThemeIcon("circle-large-outline");
  }
}

export class PlanTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private plans: Plan[] = [];

  setPlans(plans: Plan[]): void {
    this.plans = plans;
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      if (!this.plans.length) {
        const hint = new vscode.TreeItem(
          "No plans — add `.planstack/plans/*.json`",
          vscode.TreeItemCollapsibleState.None,
        );
        hint.iconPath = new vscode.ThemeIcon("info");
        return [hint];
      }
      return this.plans.map(
        (p) => new PlanTreeItem(p, p.title, vscode.TreeItemCollapsibleState.Expanded),
      );
    }
    if (element instanceof PlanTreeItem) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const items: PhaseTreeItem[] = [];
      for (const ph of element.plan.phases) {
        let desc: string = ph.status;
        if (root) {
          const g = await summarizeGitForPlan(root, ph, element.plan);
          if (g.effectiveBranch) {
            desc = `${ph.status} · ${g.effectiveBranch}`;
          }
          if (g.currentBranchLabel) {
            desc = `${desc} · HEAD ${g.currentBranchLabel}`;
          }
        }
        items.push(new PhaseTreeItem(element.plan, ph, ph.title, desc));
      }
      return items;
    }
    return [];
  }
}
