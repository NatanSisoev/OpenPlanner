import * as vscode from "vscode";
import { recomputeAggregates } from "./aggregate";
import { loadPlansFromWorkspace, watchPlans } from "./loader";
import type { Phase, Plan, Task, WorkState } from "./types";
import { savePlanPreservingFile } from "./writePlan";

export type TaskPatch = {
  state?: WorkState;
  desc?: string;
  prompt?: string;
  commit?: boolean;
};

/**
 * Single source of truth for plans loaded from `.planstack/plans/`. The
 * extension, tree provider, and sidebar webview all subscribe to changes here
 * instead of holding their own copies.
 */
export class PlansStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<readonly Plan[]>();
  readonly onDidChange = this._onDidChange.event;

  private plans: Plan[] = [];
  private loading: Promise<void> | undefined;
  private watcher: vscode.Disposable | undefined;

  /** Plans currently in memory. The returned array is a snapshot. */
  list(): readonly Plan[] {
    return this.plans;
  }

  findPlan(planId: string): Plan | undefined {
    return this.plans.find((p) => p.id === planId);
  }

  findPhase(planId: string, phaseId: string): { plan: Plan; phase: Phase } | undefined {
    const plan = this.findPlan(planId);
    const phase = plan?.phases.find((ph) => ph.id === phaseId);
    return plan && phase ? { plan, phase } : undefined;
  }

  findTask(planId: string, phaseId: string, taskId: string):
    | { plan: Plan; phase: Phase; task: Task }
    | undefined {
    const found = this.findPhase(planId, phaseId);
    const task = found?.phase.tasks.find((t) => t.id === taskId);
    return found && task ? { ...found, task } : undefined;
  }

  /**
   * Reload plans from disk. Concurrent calls collapse onto the in-flight load
   * so we never finish out of order.
   */
  async refresh(): Promise<void> {
    if (this.loading) {
      return this.loading;
    }
    this.loading = (async () => {
      try {
        this.plans = await loadPlansFromWorkspace();
        this._onDidChange.fire(this.plans);
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /** Start watching `.planstack/plans/*.json` for changes (debounced). */
  startWatching(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = watchPlans(() => void this.refresh());
  }

  /**
   * Apply a task patch and persist the owning plan. Returns true on success.
   * If saving fails, the in-memory state is reloaded from disk so we don't
   * drift from the file.
   */
  async updateTask(
    planId: string,
    phaseId: string,
    taskId: string,
    patch: TaskPatch,
    workspaceRoot: vscode.Uri,
  ): Promise<boolean> {
    const found = this.findTask(planId, phaseId, taskId);
    if (!found) {
      return false;
    }
    const { plan, task } = found;

    if (patch.state !== undefined) {
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
    recomputeAggregates(plan);

    try {
      await savePlanPreservingFile(plan, workspaceRoot);
      this._onDidChange.fire(this.plans);
      return true;
    } catch {
      // Out of sync with disk; pull authoritative state back.
      await this.refresh();
      return false;
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
