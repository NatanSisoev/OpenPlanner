import * as vscode from "vscode";
import { summarizeGitForPlan } from "../git/resolver";
import type { Phase, PhaseState, Plan, Task, TaskState } from "../plan/types";

export const PLAN_TREE_VIEW_ID = "hackupc.planstackPlans";

export const PHASE_CONTEXT = "hackupcPhase";

export class TaskTreeItem extends vscode.TreeItem {
  constructor(public readonly task: Task) {
    const label = task.desc.trim().length > 0 ? truncate(task.desc, 56) : task.id;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "hackupcTask";
    this.description = task.state;
    this.tooltip = `${task.id}\n${task.state}${task.commit ? " · commit" : ""}\n\n${task.desc}`;
    this.iconPath = stateIconTask(task.state);
  }
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export class PhaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly plan: Plan,
    public readonly phase: Phase,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    description?: string,
  ) {
    super(label, collapsible);
    this.contextValue = PHASE_CONTEXT;
    this.description = description;
    const preview =
      phase.description.length > 400 ? `${phase.description.slice(0, 400)}…` : phase.description;
    this.tooltip = `${phase.title}\n\n${preview}`;
    this.iconPath = stateIconPhase(phase.state);
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
    this.description = `${plan.state} · ${plan.phases.length} phase(s)`;
    this.tooltip = plan.title;
    this.iconPath = new vscode.ThemeIcon("list-tree");
  }
}

function stateIconPhase(state: PhaseState): vscode.ThemeIcon {
  switch (state) {
    case "completed":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "in_progress":
      return new vscode.ThemeIcon("sync~spin");
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    case "cancelled":
      return new vscode.ThemeIcon("circle-slash");
    default:
      return new vscode.ThemeIcon("circle-large-outline");
  }
}

function stateIconTask(state: TaskState): vscode.ThemeIcon {
  return stateIconPhase(state);
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
          "No plans — add `.planstack/plans/*.json` or `seed/*.json`",
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
        let desc: string = ph.state;
        if (root) {
          const g = await summarizeGitForPlan(root, ph, element.plan);
          if (g.effectiveBranch) {
            desc = `${ph.state} · ${g.effectiveBranch}`;
          }
          if (g.currentBranchLabel) {
            desc = `${desc} · HEAD ${g.currentBranchLabel}`;
          }
        }
        const collapsible =
          ph.tasks.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        items.push(new PhaseTreeItem(element.plan, ph, ph.title, collapsible, desc));
      }
      return items;
    }
    if (element instanceof PhaseTreeItem) {
      return element.phase.tasks.map((t) => new TaskTreeItem(t));
    }
    return [];
  }
}
