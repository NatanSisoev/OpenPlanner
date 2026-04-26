import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "./debug/trace";
import { handoffToNativeComposer } from "./dispatch/cursorNativeHandoff";
import type { CliPhaseRunFinishedKind } from "./dispatch/cursorCli";
import { handoffPathForMessage, writePlanstackHandoffFile } from "./dispatch/handoffFile";
import { dispatchPhaseHandoff } from "./dispatch/router";
import { mergePlanBranchNoFf } from "./git/mergePlanBranch";
import { ensurePlanWorkBranch } from "./git/ensurePlanWorkBranch";
import { effectiveWorkBranch, summarizeGitForPlan } from "./git/resolver";
import { loadPlansFromWorkspace, watchPlans } from "./plan/loader";
import { deriveAggregateState, recomputeAggregates } from "./plan/aggregate";
import {
  blockingPhaseDependencies,
  type PhaseDependencyBlocker,
} from "./plan/dependencies";
import { buildPhaseHandoffPrompt, buildTaskHandoffPrompt } from "./plan/prompt";
import {
  CURSOR_API_KEY_SECRET,
  resyncPlanFromCurrentWorkspace,
  runAgentPromptEdits,
} from "./plan/createPlanFromCli";
import { getWriteHandoffFileOnCliRun } from "./plan/executorConfig";
import { JUNIE_API_KEY_SECRET } from "./plan/junieApiKey";
import { PLANSTACK_MONGODB_URI_SECRET, requireMongoUriOrThrow } from "./plan/mongoUri";
import { reconcileAllPlansWithMongo, type ReconcileMongoPlansResult } from "./plan/mongoPlanSync";
import { applyTaskPromptDefaultsFromDesc, ensureTaskPromptFromDesc } from "./plan/taskPromptDefaults";
import { validatePlanJson } from "./plan/validate";
import { debugCliConnection } from "./plan/debugCliConnection";
import { AgentCliError, AgentRunBusyError, isAgentRunBusy, killAllAgentCliProcesses } from "./plan/agentCliRunner";
import { getOutput, logLine } from "./log";
import { savePlanPreservingFile, deletePlanFile } from "./plan/writePlan";
import { PlanstackChatWebview, CHAT_WEBVIEW_ID } from "./ui/planstackChatWebview";
import { postChatSystemMessage, postChatUserMessage } from "./ui/chatStatusBridge";
import { postAgentStreamChunk, postAgentStreamEnd, postAgentStreamStart, type AgentStreamEndReason } from "./ui/agentChatStreamBridge";
import { postAnimatedStatus, postRunFailure } from "./ui/richChatBridge";
import { PlanstackSidebarWebview, SIDEBAR_WEBVIEW_ID } from "./ui/planstackSidebarWebview";
import { PS_RUN_UI } from "./ui/runUiStrings";
import { WORK_STATES, type ExecutionState } from "./plan/types";
import type { Plan, Task } from "./plan/types";

let currentPlans: import("./plan/types").Plan[] = [];

const PLAN_ORDER_KEY = "hackupc.planstack.planOrder";

function summarizeCommandArg(arg: unknown): unknown {
  if (arg === undefined) {
    return undefined;
  }
  if (Array.isArray(arg)) {
    return { kind: "array", length: arg.length, first: summarizeCommandArg(arg[0]) };
  }
  return { kind: typeof arg };
}

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

function normalizeStaleInProgressToPending(plan: Plan): void {
  for (const phase of plan.phases) {
    if (phase.state === "in_progress") {
      phase.state = "pending";
    }
    for (const task of phase.tasks) {
      if (task.state === "in_progress") {
        task.state = "pending";
      }
    }
  }
  recomputeAggregates(plan);
}

// Tasks no longer carry dependencies; only phases do. Helpers that used to
// scrub task-level refs have been removed.

export function activate(context: vscode.ExtensionContext): void {
  const extUri = context.extensionUri;
  type RunEntrySource = "sidebar_webview" | "command_palette";
  type BranchDecision = "prepare_branch" | "current_branch" | "cancel";

  const phaseRunHooks: {
    applyOutcome?: (planId: string, phaseId: string, outcome: CliPhaseRunFinishedKind) => Promise<void>;
  } = {};
  let refreshGeneration = 0;
  const planMutationQueues = new Map<string, Promise<unknown>>();

  async function refreshPlans(sidebar: PlanstackSidebarWebview): Promise<void> {
    const generation = ++refreshGeneration;
    const loaded = await loadPlansFromWorkspace();
    if (generation !== refreshGeneration) {
      return;
    }
    const savedOrder = context.workspaceState.get<string[]>(PLAN_ORDER_KEY);
    currentPlans = orderPlans(loaded, savedOrder);
    sidebar.setPlans(currentPlans);
  }

  async function pickPhaseInteractively(): Promise<{ plan: Plan; phase: Plan["phases"][number] } | undefined> {
    if (!currentPlans.length) {
      void vscode.window.showWarningMessage("Planstack: no plans found.");
      return undefined;
    }
    const planPick = await vscode.window.showQuickPick(
      currentPlans.map((plan) => ({
        label: plan.title,
        description: plan.id,
        plan,
      })),
      { title: "Planstack: Run phase", placeHolder: "Select plan", ignoreFocusOut: true },
    );
    if (!planPick) {
      return undefined;
    }
    const plan = planPick.plan;
    const phases = plan.phases ?? [];
    if (!phases.length) {
      void vscode.window.showWarningMessage("Planstack: this plan has no phases.");
      return undefined;
    }
    const phasePick = await vscode.window.showQuickPick(
      phases.map((ph) => ({
        label: ph.title,
        description: ph.id,
        phase: ph,
      })),
      { title: "Planstack: Run phase", placeHolder: "Select phase", ignoreFocusOut: true },
    );
    if (!phasePick) {
      return undefined;
    }
    return { plan, phase: phasePick.phase };
  }

  async function pickTaskInteractively(): Promise<{
    plan: Plan;
    phase: Plan["phases"][number];
    task: Task;
  } | undefined> {
    if (!currentPlans.length) {
      void vscode.window.showWarningMessage("Planstack: no plans found.");
      return undefined;
    }
    const planPick = await vscode.window.showQuickPick(
      currentPlans.map((plan) => ({
        label: plan.title,
        description: plan.id,
        plan,
      })),
      { title: "Planstack: Set task state", placeHolder: "Select plan", ignoreFocusOut: true },
    );
    if (!planPick) {
      return undefined;
    }
    const plan = planPick.plan;
    const phases = plan.phases ?? [];
    if (!phases.length) {
      void vscode.window.showWarningMessage("Planstack: this plan has no phases.");
      return undefined;
    }
    const phasePick = await vscode.window.showQuickPick(
      phases.map((ph) => ({
        label: ph.title,
        description: ph.id,
        phase: ph,
      })),
      { title: "Planstack: Set task state", placeHolder: "Select phase", ignoreFocusOut: true },
    );
    if (!phasePick) {
      return undefined;
    }
    const phase = phasePick.phase;
    const tasks = phase.tasks ?? [];
    if (!tasks.length) {
      void vscode.window.showWarningMessage("Planstack: this phase has no tasks.");
      return undefined;
    }
    const taskPick = await vscode.window.showQuickPick(
      tasks.map((t) => ({
        label: t.desc.trim().length > 0 ? t.desc.trim() : t.id,
        description: t.id,
        task: t,
      })),
      { title: "Planstack: Set task state", placeHolder: "Select task", ignoreFocusOut: true },
    );
    if (!taskPick) {
      return undefined;
    }
    return { plan, phase, task: taskPick.task };
  }

  function enqueuePlanMutation<T>(planId: string, op: () => Promise<T>): Promise<T> {
    const prev = planMutationQueues.get(planId) ?? Promise.resolve();
    const next = prev.then(op, op);
    planMutationQueues.set(
      planId,
      next.finally(() => {
        if (planMutationQueues.get(planId) === next) {
          planMutationQueues.delete(planId);
        }
      }),
    );
    return next;
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
      git: {
        baseBranch: "main",
        planBranch: `planstack/${planId}`,
      },
    };
    await savePlanPreservingFile(plan, root);
    await refreshPlans(sidebarUi);
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
    await refreshPlans(sidebarUi);
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
    const newTask: Task = {
      id: taskId,
      state: "pending",
      desc: trimmedDesc,
      commit: input.commit,
      prompt: input.prompt?.trim() || undefined,
    };
    ensureTaskPromptFromDesc(newTask);
    phase.tasks.push(newTask);
    phase.state = deriveAggregateState(phase.tasks.map((t) => t.state));
    plan.state = deriveAggregateState(plan.phases.map((p) => p.state));
    await savePlanPreservingFile(plan, root);
    await refreshPlans(sidebarUi);
    return true;
  }

  function planChatLabel(plan: Plan): string {
    const title = plan.title.trim();
    return title.length > 0 ? `${title} (${plan.id})` : plan.id;
  }

  function emitRunRequestMessage(plan: Plan, phase: Plan["phases"][number], source: RunEntrySource): void {
    const sourceLabel = source === "command_palette" ? "command palette" : "sidebar";
    postChatUserMessage(`${PS_RUN_UI.runPhaseRequestPrefix} ${plan.title} › ${phase.title} (${sourceLabel})`);
  }

  function emitTaskRunRequestMessage(
    plan: Plan,
    phase: Plan["phases"][number],
    task: Plan["phases"][number]["tasks"][number],
    source: RunEntrySource,
  ): void {
    const sourceLabel = source === "command_palette" ? "command palette" : "sidebar";
    postChatUserMessage(`${PS_RUN_UI.runTaskRequestPrefix} ${plan.title} › ${phase.title} › ${task.desc} (${sourceLabel})`);
  }

  async function runTaskWithPrompt(
    planId: string,
    phaseId: string,
    taskId: string,
    source: RunEntrySource,
  ): Promise<boolean> {
    const traceId = newTraceId("runtask");
    const plan = currentPlans.find((p) => p.id === planId);
    const phase = plan?.phases.find((ph) => ph.id === phaseId);
    const task = phase?.tasks.find((t) => t.id === taskId);
    if (!plan || !phase || !task) {
      void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
      return false;
    }
    const requireTaskPrompt =
      vscode.workspace.getConfiguration("planstack").get<boolean>("requireTaskPrompt") ?? true;
    const taskPrompt = (task.prompt ?? "").trim();
    if (requireTaskPrompt && !taskPrompt) {
      void vscode.window.showWarningMessage(
        `Planstack: task "${task.desc}" has no prompt. Add one in the plan JSON, or open task details and use Edit prompt (✎), then save before running. You can also set planstack.requireTaskPrompt to false to run using the task title only.`,
      );
      return false;
    }
    // Tasks now inherit blocking state from their parent phase's dependsOn —
    // there are no task-level dependencies any more. If the parent phase has
    // unmet phase dependencies, propose running them first.
    const phaseBlockers = blockingPhaseDependencies(currentPlans, plan, phase);
    if (phaseBlockers.length > 0) {
      const handled = await offerToRunBlockingDepsThen(
        plan,
        phase,
        phaseBlockers,
        {
          subjectLabel: `task "${task.desc}"`,
          traceId,
          onResume: () => {
            void runTaskWithPrompt(planId, phaseId, taskId, source);
          },
        },
      );
      traceEvent(traceId, "runtask.blocked_dependencies", {
        planId: plan.id,
        phaseId: phase.id,
        taskId: task.id,
        blockers: phaseBlockers,
        outcome: handled,
      });
      return false;
    }
    if (isAgentRunBusy()) {
      void vscode.window.showWarningMessage(
        "Planstack: an agent run is already in progress. Stop it or wait for completion, then retry.",
      );
      return false;
    }

    const statusLabel = `${plan.title} › ${phase.title} › ${task.desc}`;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
      return false;
    }
    const git = await summarizeGitForPlan(root, phase, plan);
    const prompt = buildTaskHandoffPrompt(plan, phase, task, {
      currentHead: git.currentBranchLabel,
      effectiveWorkBranch: effectiveWorkBranch(phase, plan),
      baseBranch: plan.git?.baseBranch,
    });

    emitTaskRunRequestMessage(plan, phase, task, source);
    postChatSystemMessage(`${planChatLabel(plan)}: ${PS_RUN_UI.runTaskChatStarting} "${task.desc}".`);

    const marked = await mutatePlan(plan.id, (latest) => {
      const latestPhase = latest.phases.find((ph) => ph.id === phase.id);
      const latestTask = latestPhase?.tasks.find((t) => t.id === task.id);
      if (!latestPhase || !latestTask) {
        return false;
      }
      latestTask.state = "in_progress";
    });
    if (!marked) {
      void vscode.window.showWarningMessage("Planstack: task could not be marked in progress.");
      return false;
    }

    const output = getOutput();
    output.show(true);
    output.appendLine(`\n=== ${statusLabel}: ${PS_RUN_UI.runTaskLogStarted} ${new Date().toISOString()} ===\n`);

    const cfg = vscode.workspace.getConfiguration("planstack.cursor");
    const streamToOutput = cfg.get<boolean>("cliStreamAgentOutput") ?? true;
    const useLiveChat = cfg.get<boolean>("agentChatLiveStream") ?? true;
    const chatThrottleMs = cfg.get<number>("cliStreamChatThrottleMs") ?? 25_000;
    let lastChatAt = 0;
    const runId = randomUUID();
    let endReason: AgentStreamEndReason = "complete";
    const startedAt = Date.now();

    const maybeChat = (prefix: string, chunk: string): void => {
      const t = chunk.trim();
      if (!t) {
        return;
      }
      const now = Date.now();
      if (now - lastChatAt < chatThrottleMs) {
        return;
      }
      lastChatAt = now;
      postChatSystemMessage(`${prefix}${t.slice(-220)}`);
    };

    postAnimatedStatus(runId);
    if (useLiveChat) {
      postAgentStreamStart(runId, {
        label: statusLabel,
        source: "runTask",
      });
    }
    try {
      const result = await runAgentPromptEdits({
        extensionContext: context,
        workspaceRoot: root,
        prompt,
        debugTraceId: traceId,
        onAgentStdoutChunk:
          streamToOutput || useLiveChat
            ? (text) => {
                if (streamToOutput && text) {
                  output.append(text);
                }
                if (!text) {
                  return;
                }
                if (useLiveChat) {
                  postAgentStreamChunk(runId, "stdout", text);
                } else {
                  maybeChat(PS_RUN_UI.runTaskThrottleStdoutPrefix, text);
                }
              }
            : undefined,
        onAgentStderrChunk:
          streamToOutput || useLiveChat
            ? (text) => {
                if (streamToOutput && text) {
                  output.append(text);
                }
                if (!text) {
                  return;
                }
                if (useLiveChat) {
                  postAgentStreamChunk(runId, "stderr", text);
                } else {
                  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
                  const last = lines.length > 0 ? lines[lines.length - 1]! : text;
                  maybeChat(PS_RUN_UI.runTaskThrottleStderrPrefix, last);
                }
              }
            : undefined,
      });

      if (result.exitCode !== 0) {
        endReason = "error";
        const tail = result.stderr.trim() || result.stdout.slice(-400);
        throw new AgentCliError(
          `agent exited with code ${result.exitCode}. ${tail ? `Details: ${tail}` : ""}`.trim(),
          result.exitCode,
          result.stderr,
        );
      }

      await mutatePlan(plan.id, (latest) => {
        const latestPhase = latest.phases.find((ph) => ph.id === phase.id);
        const latestTask = latestPhase?.tasks.find((t) => t.id === task.id);
        if (!latestPhase || !latestTask) {
          return false;
        }
        latestTask.state = "completed";
      });
      postChatSystemMessage(`${statusLabel}: ${PS_RUN_UI.runTaskChatCompleted}.`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stopped = e instanceof AgentCliError && msg.includes("stopped");
      endReason = stopped ? "stopped" : "error";
      if (e instanceof AgentRunBusyError) {
        await mutatePlan(plan.id, (latest) => {
          const latestPhase = latest.phases.find((ph) => ph.id === phase.id);
          const latestTask = latestPhase?.tasks.find((t) => t.id === task.id);
          if (!latestPhase || !latestTask) {
            return false;
          }
          latestTask.state = "pending";
        });
        void vscode.window.showWarningMessage(e.message);
        postChatSystemMessage(`${statusLabel}: skipped — ${e.message}`);
      } else {
        await mutatePlan(plan.id, (latest) => {
          const latestPhase = latest.phases.find((ph) => ph.id === phase.id);
          const latestTask = latestPhase?.tasks.find((t) => t.id === task.id);
          if (!latestPhase || !latestTask) {
            return false;
          }
          latestTask.state = stopped ? "cancelled" : "failed";
        });
        postRunFailure(runId, {
          phaseLabel: statusLabel,
          durationSec: Math.floor((Date.now() - startedAt) / 1000),
          summary: stopped ? PS_RUN_UI.runTaskFailureSummaryStopped : PS_RUN_UI.runTaskFailureSummaryFailed,
          details: msg.slice(0, 2000),
          retryPrompt: prompt,
        });
        postChatSystemMessage(
          `${statusLabel}: ${stopped ? `${PS_RUN_UI.runTaskChatStopped}.` : `${PS_RUN_UI.runTaskChatFailed} — ${msg.slice(0, 400)}`}`,
        );
        if (stopped) {
          void vscode.window.showWarningMessage(`Planstack: ${msg.slice(0, 2000)}`);
        } else {
          void vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
        }
      }
      return false;
    } finally {
      postAgentStreamEnd(runId, endReason);
    }
  }

  async function askRunBranchDecision(
    plan: Plan,
    phase: Plan["phases"][number],
    source: RunEntrySource,
  ): Promise<BranchDecision> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const git = root
      ? await summarizeGitForPlan(root, phase, plan)
      : { effectiveBranch: undefined, currentBranchLabel: undefined, hasGitRepository: false };

    const planBranch = plan.git?.planBranch?.trim();
    const baseBranch = plan.git?.baseBranch?.trim() || "main";
    const currentBranch = git.currentBranchLabel ?? "unknown";
    const sourceLabel = source === "command_palette" ? "Command palette" : "Overview";

    const prepareDetail = planBranch
      ? `planBranch=${planBranch} · baseBranch=${baseBranch}`
      : "No git.planBranch configured; setup step will be skipped.";

    const pick = await vscode.window.showQuickPick<
      vscode.QuickPickItem & { decision: Exclude<BranchDecision, "cancel"> }
    >(
      [
        {
          label: "$(git-branch) Prepare/switch branch, then run",
          description: prepareDetail,
          detail: `Current branch: ${currentBranch}`,
          decision: "prepare_branch",
        },
        {
          label: `$(play) ${PS_RUN_UI.runPhaseButton} on current branch`,
          description: `Skip branch setup and run now`,
          detail: `Current branch: ${currentBranch}`,
          decision: "current_branch",
        },
      ],
      {
        title: `Planstack: Run "${phase.title}" (${sourceLabel})`,
        placeHolder: "Choose how to run this phase",
        ignoreFocusOut: true,
      },
    );
    return pick?.decision ?? "cancel";
  }

  // Plans currently running every phase sequentially via `onRunPlanFully`. The
  // value is the branch decision picked once at the start of the run, reused
  // for each subsequent phase so the user is not re-prompted.
  const autoRunningPlans = new Map<string, Exclude<BranchDecision, "cancel">>();

  /**
   * After a "Run dependencies first" choice, we queue follow-up runs that
   * fire once the just-finished phase reports success. Keyed by
   * `${planId}::${phaseId}`. Each entry replaces any previous one for that
   * key, so re-prompts collapse onto the latest user intent.
   */
  const pendingChainContinuations = new Map<string, () => Promise<void> | void>();

  function chainKey(planId: string, phaseId: string): string {
    return `${planId}::${phaseId}`;
  }

  /**
   * Topologically order the resolved phase blockers so direct prerequisites
   * run first. Cycles are broken by leaving the offending node in place.
   */
  function orderBlockerChain(
    blockers: readonly PhaseDependencyBlocker[],
  ): Array<{ plan: Plan; phase: Plan["phases"][number] }> {
    const incomplete = blockers.filter((b) => b.reason === "incomplete" && b.target);
    const targets = incomplete.map((b) => b.target!);
    const indexByKey = new Map<string, number>();
    targets.forEach((t, i) => indexByKey.set(chainKey(t.plan.id, t.phase.id), i));

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: typeof targets = [];

    const visit = (entry: { plan: Plan; phase: Plan["phases"][number] }): void => {
      const key = chainKey(entry.plan.id, entry.phase.id);
      if (visited.has(key) || visiting.has(key)) {
        return;
      }
      visiting.add(key);
      for (const ref of entry.phase.dependsOn ?? []) {
        const parts = ref.split("/").map((s) => s.trim());
        const planId = parts.length === 2 ? parts[0]! : entry.plan.id;
        const phaseId = parts.length === 2 ? parts[1]! : parts[0]!;
        const subKey = chainKey(planId, phaseId);
        const idx = indexByKey.get(subKey);
        if (idx !== undefined) {
          visit(targets[idx]!);
        }
      }
      visiting.delete(key);
      visited.add(key);
      result.push(entry);
    };

    for (const t of targets) {
      visit(t);
    }
    return result;
  }

  /**
   * Show a warning that lists the unmet phase dependencies and offers to
   * either run them first (queueing the original phase/task to resume after)
   * or cancel. Returns the user's chosen action.
   */
  async function offerToRunBlockingDepsThen(
    plan: Plan,
    phase: Plan["phases"][number],
    blockers: readonly PhaseDependencyBlocker[],
    opts: {
      subjectLabel: string;
      traceId: string;
      onResume: () => void | Promise<void>;
    },
  ): Promise<"run_deps_then_subject" | "cancel"> {
    const ordered = orderBlockerChain(blockers);
    const blockerSummary = blockers.map((b) => b.label).join(", ");
    const runDepsLabel = ordered.length > 0
      ? `Run ${ordered.length} dependenc${ordered.length === 1 ? "y" : "ies"} first, then this`
      : "Run dependencies first";

    const choice = await vscode.window.showWarningMessage(
      `Planstack: ${opts.subjectLabel} cannot start — phase "${phase.title}" depends on incomplete phases: ${blockerSummary}.`,
      { modal: true, detail: ordered.length > 0
          ? `Order:\n${ordered.map((e, i) => `  ${i + 1}. ${e.plan.title} › ${e.phase.title}`).join("\n")}\n\nThe original ${opts.subjectLabel} will run automatically once every dependency completes successfully.`
          : "No runnable dependencies were resolved (some may be malformed). Fix the plan JSON and try again.",
      },
      runDepsLabel,
    );

    if (choice !== runDepsLabel || ordered.length === 0) {
      traceEvent(opts.traceId, "deps.proposal.cancelled", {
        planId: plan.id,
        phaseId: phase.id,
        ordered: ordered.length,
      });
      return "cancel";
    }

    // Build the chain back-to-front: the final continuation re-runs the
    // original phase/task; each preceding link runs the next dependency.
    let continuation: () => Promise<void> | void = async () => opts.onResume();
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const link = ordered[i]!;
      const after = continuation;
      const linkKey = chainKey(link.plan.id, link.phase.id);
      continuation = async () => {
        pendingChainContinuations.set(linkKey, after);
        const tid = newTraceId("runphase-deps-chain");
        traceEvent(tid, "deps.chain.runlink", {
          planId: link.plan.id,
          phaseId: link.phase.id,
          remaining: i,
        });
        const started = await runPhaseWithBranchDecision(
          link.plan,
          link.phase,
          tid,
          "sidebar_webview",
        );
        if (!started) {
          // User cancelled the branch picker (or another preflight failed).
          // Drop the queued resume so the chain doesn't fire stale on the
          // next unrelated success.
          pendingChainContinuations.delete(linkKey);
          postChatSystemMessage(
            `${planChatLabel(link.plan)}: dependency chain stopped — "${link.phase.title}" did not start.`,
          );
        }
      };
    }

    postChatSystemMessage(
      `${planChatLabel(plan)}: queued ${ordered.length} dependenc${ordered.length === 1 ? "y" : "ies"} before ${opts.subjectLabel}.`,
    );
    traceEvent(opts.traceId, "deps.proposal.accepted", {
      planId: plan.id,
      phaseId: phase.id,
      chain: ordered.map((e) => `${e.plan.id}/${e.phase.id}`),
    });
    void continuation();
    return "run_deps_then_subject";
  }

  async function executePhaseRun(
    plan: Plan,
    phase: Plan["phases"][number],
    decision: Exclude<BranchDecision, "cancel">,
    traceId: string,
    source: RunEntrySource,
  ): Promise<boolean> {
    const blockers = blockingPhaseDependencies(currentPlans, plan, phase);
    if (blockers.length > 0) {
      const handled = await offerToRunBlockingDepsThen(
        plan,
        phase,
        blockers,
        {
          subjectLabel: `phase "${phase.title}"`,
          traceId,
          onResume: () => {
            void runPhaseWithBranchDecision(plan, phase, newTraceId("runphase-resume"), source);
          },
        },
      );
      traceEvent(traceId, "runphase.blocked_dependencies", {
        planId: plan.id,
        phaseId: phase.id,
        blockers,
        outcome: handled,
      });
      return false;
    }
    if (isAgentRunBusy()) {
      void vscode.window.showWarningMessage(
        "Planstack: an agent run is already in progress. Stop it or wait for completion, then retry.",
      );
      traceEvent(traceId, "runphase.agent_busy_preflight", { planId: plan.id, phaseId: phase.id });
      return false;
    }
    if (decision === "prepare_branch") {
      emitRunRequestMessage(plan, phase, source);
      const branchOk = await ensurePlanWorkBranch(plan, context.workspaceState);
      traceEvent(traceId, "runphase.branch_prep", { path: source, ok: branchOk, mode: "prepare_branch" });
      if (!branchOk) {
        return false;
      }
      postChatSystemMessage(`${planChatLabel(plan)}: branch prep accepted for phase "${phase.title}".`);
    } else {
      emitRunRequestMessage(plan, phase, source);
      postChatSystemMessage(
        `${planChatLabel(plan)}: running phase "${phase.title}" on current branch (branch prep skipped).`,
      );
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
    traceMultiline(traceId, "runphase.generated_prompt", prompt);
    if (root) {
      const marked = await mutatePlan(plan.id, (latest) => {
        const latestPhase = latest.phases.find((ph) => ph.id === phase.id);
        if (!latestPhase) {
          return false;
        }
        latestPhase.state = "in_progress";
      });
      if (!marked) {
        void vscode.window.showWarningMessage("Planstack: phase could not be marked in progress.");
        return false;
      }
    }
    traceEvent(traceId, "runphase.dispatch", {
      statusLabel: `${plan.title} › ${phase.title}`,
      traceId,
      source,
    });
    if (root && getWriteHandoffFileOnCliRun()) {
      try {
        const written = await writePlanstackHandoffFile(root, prompt, {
          planId: plan.id,
          phaseId: phase.id,
          planTitle: plan.title,
          phaseTitle: phase.title,
        });
        postChatSystemMessage(
          `Handoff file: ${handoffPathForMessage(root, written)} — attach in Junie or keep for your records.`,
        );
      } catch (e) {
        logLine(`runphase: handoff file write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await dispatchPhaseHandoff(prompt, context, {
      statusLabel: `${plan.title} › ${phase.title}`,
      traceId,
      onCliRunFinished: (kind) =>
        phaseRunHooks.applyOutcome ? phaseRunHooks.applyOutcome(plan.id, phase.id, kind) : Promise.resolve(),
    });
    return true;
  }

  async function runPhaseWithBranchDecision(
    plan: Plan,
    phase: Plan["phases"][number],
    traceId: string,
    source: RunEntrySource,
  ): Promise<boolean> {
    const decision = await askRunBranchDecision(plan, phase, source);
    traceEvent(traceId, "runphase.branch_decision", { source, decision, planId: plan.id, phaseId: phase.id });
    if (decision === "cancel") {
      return false;
    }
    return executePhaseRun(plan, phase, decision, traceId, source);
  }

  function nextRunnablePhase(plan: Plan): Plan["phases"][number] | undefined {
    return plan.phases.find((ph) => ph.state !== "completed" && ph.state !== "cancelled");
  }

  async function continueAutoRunPlan(planId: string): Promise<void> {
    const decision = autoRunningPlans.get(planId);
    if (!decision) return;
    const plan = currentPlans.find((p) => p.id === planId);
    if (!plan) {
      autoRunningPlans.delete(planId);
      return;
    }
    const next = nextRunnablePhase(plan);
    if (!next) {
      autoRunningPlans.delete(planId);
      postChatSystemMessage(`${planChatLabel(plan)}: plan run complete.`);
      return;
    }
    const tid = newTraceId("runplan-auto");
    traceEvent(tid, "runplan.auto.next", { planId, phaseId: next.id });
    try {
      await executePhaseRun(plan, next, decision, tid, "sidebar_webview");
    } catch (e) {
      traceEvent(tid, "runplan.auto.error", { error: e instanceof Error ? e.message : String(e) });
      autoRunningPlans.delete(planId);
    }
  }

  async function startPlanAutoRun(planId: string): Promise<void> {
    if (autoRunningPlans.has(planId)) {
      void vscode.window.showInformationMessage("Planstack: this plan is already running.");
      return;
    }
    const plan = currentPlans.find((p) => p.id === planId);
    if (!plan) {
      void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
      return;
    }
    const next = nextRunnablePhase(plan);
    if (!next) {
      void vscode.window.showInformationMessage("Planstack: plan has no runnable phases.");
      return;
    }
    const decision = await askRunBranchDecision(plan, next, "sidebar_webview");
    if (decision === "cancel") {
      return;
    }
    autoRunningPlans.set(planId, decision);
    postChatSystemMessage(`${planChatLabel(plan)}: starting sequential run of ${plan.phases.length} phase${plan.phases.length === 1 ? "" : "s"}.`);
    const tid = newTraceId("runplan-auto-start");
    try {
      await executePhaseRun(plan, next, decision, tid, "sidebar_webview");
    } catch (e) {
      traceEvent(tid, "runplan.auto.error", { error: e instanceof Error ? e.message : String(e) });
      autoRunningPlans.delete(planId);
    }
  }

  async function mutatePlan(
    planId: string,
    mutator: (plan: Plan) => boolean | void,
  ): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
      return false;
    }
    return enqueuePlanMutation(planId, async () => {
      const loaded = await loadPlansFromWorkspace();
      const ordered = orderPlans(loaded, context.workspaceState.get<string[]>(PLAN_ORDER_KEY));
      const plan = ordered.find((p) => p.id === planId);
      if (!plan) {
        return false;
      }
      const changed = mutator(plan);
      if (changed === false) {
        return false;
      }
      recomputeAggregates(plan);
      await savePlanPreservingFile(plan, root);
      await refreshPlans(sidebarUi);
      return true;
    });
  }

  function showMongoSyncOutcome(
    reconciled: number,
    failed: string[],
    summary: ReconcileMongoPlansResult | undefined,
    dbName: string,
    collName: string,
  ): void {
    if (failed.length > 0) {
      const first = failed.slice(0, 2).join(" · ");
      void vscode.window.showWarningMessage(
        `Planstack: ${reconciled} updated, ${failed.length} failed — ${first}`.slice(0, 2000),
      );
      for (const line of failed) {
        logLine(`mongo sync: ${line}`);
      }
      return;
    }
    if (reconciled > 0) {
      void vscode.window.showInformationMessage(
        `Planstack: ${reconciled} plan${reconciled === 1 ? "" : "s"} updated.`,
      );
      return;
    }
    const s = summary;
    if (s && s.idsTotal > 0) {
      void vscode.window.showInformationMessage(`Planstack: Up to date (${s.idsTotal} plans).`);
      logLine(`mongo sync ok ids=${s.idsTotal} local=${s.localPlanCount} remote=${s.remoteDocCount}`);
      return;
    }
    void vscode.window.showInformationMessage(
      `Planstack: Nothing to sync — add .planstack/plans or data in ${dbName}.${collName}.`,
    );
    logLine(`mongo sync empty local=${s?.localPlanCount ?? 0} remote=${s?.remoteDocCount ?? 0}`);
  }

  async function syncReconcileAllPlans(title: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: Open a workspace folder first.");
      return;
    }
    let uri: string;
    try {
      uri = await requireMongoUriOrThrow(context);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const cfg = vscode.workspace.getConfiguration("planstack.cursor");
    const dbName = cfg.get<string>("mongoDatabase")?.trim() || "planstack";
    const collName = cfg.get<string>("mongoCollection")?.trim() || "plan";

    const failed: string[] = [];
    let reconciled = 0;
    let syncSummary: ReconcileMongoPlansResult | undefined;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: false,
        },
        async (progress) => {
          const r = await reconcileAllPlansWithMongo(root, uri, dbName, collName, (message, increment) => {
            progress.report({ message, increment });
          });
          syncSummary = r;
          reconciled = r.reconciled;
          failed.push(...r.failed);
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Planstack: ${msg}`);
      logLine(`mongo sync fatal: ${msg}`);
      return;
    }

    await refreshPlans(sidebarUi);
    showMongoSyncOutcome(reconciled, failed, syncSummary, dbName, collName);
  }

  async function syncPullThenPushAllPlans(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showWarningMessage("Planstack: Open a workspace folder first.");
      return;
    }
    let uri: string;
    try {
      uri = await requireMongoUriOrThrow(context);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const cfg = vscode.workspace.getConfiguration("planstack.cursor");
    const dbName = cfg.get<string>("mongoDatabase")?.trim() || "planstack";
    const collName = cfg.get<string>("mongoCollection")?.trim() || "plan";

    const failed: string[] = [];
    let reconciled = 0;
    let lastSummary: ReconcileMongoPlansResult | undefined;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Planstack: Sync",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "1/2 Pull", increment: 0 });
          const r1 = await reconcileAllPlansWithMongo(root, uri, dbName, collName, (message, increment) => {
            progress.report({
              message: `Pull · ${message}`,
              increment: increment !== undefined ? increment / 2 : undefined,
            });
          });
          progress.report({ message: "2/2 Push", increment: 50 });
          const r2 = await reconcileAllPlansWithMongo(root, uri, dbName, collName, (message, increment) => {
            progress.report({
              message: `Push · ${message}`,
              increment: increment !== undefined ? increment / 2 : undefined,
            });
          });
          reconciled = r1.reconciled + r2.reconciled;
          failed.push(...r1.failed, ...r2.failed);
          lastSummary = r2;
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Planstack: ${msg}`);
      logLine(`mongo sync fatal: ${msg}`);
      return;
    }

    await refreshPlans(sidebarUi);
    showMongoSyncOutcome(reconciled, failed, lastSummary, dbName, collName);
  }

  async function syncPushAllPlans(): Promise<void> {
    await syncReconcileAllPlans("Planstack: Push");
  }

  async function syncPullAllPlans(): Promise<void> {
    await syncReconcileAllPlans("Planstack: Pull");
  }

  const sidebarUi = new PlanstackSidebarWebview(extUri, {
    onRunPhase: async (planId, phaseId) => {
      const tid = newTraceId("runphase-sidebar");
      traceEvent(tid, "runphase.sidebar.enter", { planId, phaseId });
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
        const started = await runPhaseWithBranchDecision(plan, phase, tid, "sidebar_webview");
        if (!started) {
          traceEvent(tid, "runphase.sidebar.abort", { reason: "user_cancelled_or_branch_prep_failed" });
          return;
        }
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
    onRunTask: async (planId, phaseId, taskId) => {
      const tid = newTraceId("runtask-sidebar");
      traceEvent(tid, "runtask.sidebar.enter", { planId, phaseId, taskId });
      try {
        const started = await runTaskWithPrompt(planId, phaseId, taskId, "sidebar_webview");
        traceEvent(tid, "runtask.sidebar.exit", { ok: started });
      } catch (e) {
        traceEvent(tid, "runtask.sidebar.exit", {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof Error && e.stack) {
          traceMultiline(tid, "runtask.sidebar.error.stack", e.stack);
        }
        throw e;
      }
    },
    onUpdatePhase: async (planId, phaseId, patch) => {
      const ok = await mutatePlan(planId, (plan) => {
        const phase = plan.phases.find((ph) => ph.id === phaseId);
        if (!phase) {
          return false;
        }
        // Phase/plan state is derived from task states; reject direct phase state edits.
        if (patch.state !== undefined) {
          return false;
        }
        if (patch.title !== undefined) {
          phase.title = patch.title;
        }
        if (patch.description !== undefined) {
          phase.description = patch.description;
        }
        if (patch.assignee !== undefined) {
          const a = patch.assignee.trim();
          if (a) {
            phase.assignee = a;
          } else {
            delete phase.assignee;
          }
        }
      });
      if (!ok && patch.state !== undefined) {
        void vscode.window.showWarningMessage(
          "Planstack: phase status is derived from its tasks. Update task states instead.",
        );
      }
      return ok;
    },
    onUpdateTask: async (planId, phaseId, taskId, patch) => {
      return mutatePlan(planId, (plan) => {
        const phase = plan.phases.find((ph) => ph.id === phaseId);
        const task = phase?.tasks.find((t) => t.id === taskId);
        if (!phase || !task) {
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
        if (patch.assignee !== undefined) {
          const a = patch.assignee.trim();
          if (a) {
            task.assignee = a;
          } else {
            delete task.assignee;
          }
        }
      });
    },
    onUpdatePlan: async (planId, patch) => {
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
      await refreshPlans(sidebarUi);
      return true;
    },
    onCreatePlan: async ({ title, description }) => {
      const ok = await createPlan({ title, description });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: created plan "${title.trim()}".`);
      }
    },
    onCreatePhase: async ({ planId, title, description }) => {
      const ok = await createPhase({ planId, title, description });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: added phase "${title.trim()}".`);
      }
    },
    onCreateTask: async ({ planId, phaseId, desc, prompt, commit }) => {
      const ok = await createTask({ planId, phaseId, desc, prompt, commit });
      if (ok) {
        void vscode.window.showInformationMessage(`Planstack: added task "${desc.trim()}".`);
      }
    },
    onMergePlan: async (planId) => {
      await vscode.commands.executeCommand("hackupc.planstack.mergePlan", planId);
    },
    onReorderPlans: async (orderedPlanIds) => {
      const loadedIds = new Set(currentPlans.map((p) => p.id));
      const cleaned = orderedPlanIds.filter((id) => loadedIds.has(id));
      await context.workspaceState.update(PLAN_ORDER_KEY, cleaned);
      await refreshPlans(sidebarUi);
    },
    onDeletePlan: async (planId) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
        return;
      }
      const plan = currentPlans.find((p) => p.id === planId);
      if (!plan) {
        void vscode.window.showWarningMessage("Planstack: plan not found — refresh and try again.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete plan "${plan.title}"? This removes the plan file and all its phases and tasks. This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (choice !== "Delete") {
        return;
      }
      const removed = await deletePlanFile(planId, root);
      if (!removed) {
        void vscode.window.showWarningMessage("Planstack: plan file not found on disk.");
      }
      const savedOrder = context.workspaceState.get<string[]>(PLAN_ORDER_KEY) ?? [];
      if (savedOrder.includes(planId)) {
        await context.workspaceState.update(
          PLAN_ORDER_KEY,
          savedOrder.filter((id) => id !== planId),
        );
      }
      await refreshPlans(sidebarUi);
    },
    onDeletePhase: async (planId, phaseId) => {
      const plan = currentPlans.find((p) => p.id === planId);
      const phase = plan?.phases.find((ph) => ph.id === phaseId);
      if (!plan || !phase) {
        void vscode.window.showWarningMessage("Planstack: phase not found — refresh and try again.");
        return;
      }
      const taskCount = phase.tasks?.length ?? 0;
      const choice = await vscode.window.showWarningMessage(
        `Delete phase "${phase.title}" and its ${taskCount} task${taskCount === 1 ? "" : "s"}? This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (choice !== "Delete") {
        return;
      }
      await mutatePlan(planId, (latest) => {
        latest.phases = latest.phases.filter((ph) => ph.id !== phaseId);
        for (const remaining of latest.phases) {
          if (Array.isArray(remaining.dependsOn)) {
            remaining.dependsOn = remaining.dependsOn.filter((id) => id !== phaseId && id !== `${latest.id}/${phaseId}`);
          }
        }
      });
    },
    onRunPlanFully: async (planId) => {
      await startPlanAutoRun(planId);
    },
    onDeleteTask: async (planId, phaseId, taskId) => {
      const plan = currentPlans.find((p) => p.id === planId);
      const phase = plan?.phases.find((ph) => ph.id === phaseId);
      if (!plan || !phase) {
        void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
        return;
      }
      await mutatePlan(planId, (latest) => {
        const latestPhase = latest.phases.find((ph) => ph.id === phaseId);
        if (!latestPhase) {
          return false;
        }
        latestPhase.tasks = latestPhase.tasks.filter((t) => t.id !== taskId);
      });
    },
    onSyncPushAll: async () => {
      try {
        await syncPushAllPlans();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
      }
    },
    onSyncPullAll: async () => {
      try {
        await syncPullAllPlans();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
      }
    },
    onSyncPullPushAll: async () => {
      try {
        await syncPullThenPushAllPlans();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
      }
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_WEBVIEW_ID, sidebarUi, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("planstack.requireTaskPrompt")) {
        void refreshPlans(sidebarUi);
      }
    }),
  );

  phaseRunHooks.applyOutcome = async (
    planId: string,
    phaseId: string,
    outcome: CliPhaseRunFinishedKind,
  ): Promise<void> => {
    try {
      const ok = await mutatePlan(planId, (plan) => {
        const phase = plan.phases.find((ph) => ph.id === phaseId);
        if (!phase) {
          return false;
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
      });
      if (!ok) {
        logLine(`applyPhaseRunOutcome: missing plan/phase ${planId}/${phaseId}`);
      }

      // Dependency chain follow-up: when the user accepted "Run dependencies
      // first, then this", each completed dependency triggers the next link;
      // the final link re-runs the originally requested phase or task.
      const continuationKey = chainKey(planId, phaseId);
      const continuation = pendingChainContinuations.get(continuationKey);
      if (continuation) {
        pendingChainContinuations.delete(continuationKey);
        if (outcome === "success") {
          setTimeout(() => {
            try {
              void continuation();
            } catch (e) {
              logLine(`deps chain continuation failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }, 250);
        } else {
          const latestPlan = currentPlans.find((p) => p.id === planId);
          const planLabel = latestPlan ? planChatLabel(latestPlan) : `Plan ${planId}`;
          postChatSystemMessage(
            `${planLabel}: dependency chain stopped — phase "${phaseId}" ${outcome === "stopped" ? "was cancelled" : "failed"}.`,
          );
        }
      }

      if (autoRunningPlans.has(planId)) {
        if (outcome === "success") {
          // Defer so the sidebar refresh paints the green phase before the
          // next dispatch logs/spinners arrive.
          setTimeout(() => void continueAutoRunPlan(planId), 250);
        } else {
          autoRunningPlans.delete(planId);
          const latestPlan = currentPlans.find((p) => p.id === planId);
          const latestPhase = latestPlan?.phases.find((ph) => ph.id === phaseId);
          const planLabel = latestPlan ? planChatLabel(latestPlan) : `Plan ${planId}`;
          const phaseLabel = latestPhase?.title ?? phaseId;
          postChatSystemMessage(
            `${planLabel}: plan run halted (phase "${phaseLabel}" ${outcome === "stopped" ? "was cancelled" : "failed"}).`,
          );
        }
      }
    } catch (e) {
      logLine(`applyPhaseRunOutcome: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const chatUi = new PlanstackChatWebview(
    extUri,
    context,
    async () => {
      await refreshPlans(sidebarUi);
    },
  );
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
      const tid = newTraceId("cmd-refresh");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.refresh" });
      try {
        await refreshPlans(sidebarUi);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.resyncPlan", async (item: unknown) => {
      const tid = newTraceId("cmd-resyncPlan");
      traceEvent(tid, "command.enter", {
        command: "hackupc.planstack.resyncPlan",
        arg: summarizeCommandArg(item),
      });
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.resyncPlan",
          ok: true,
          skipped: "no_workspace",
        });
        void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
        return;
      }

      const fromArg = typeof item === "string" && item.trim() ? item.trim() : undefined;
      let selectedPlanId = fromArg;
      if (!selectedPlanId) {
        if (currentPlans.length === 0) {
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.resyncPlan",
            ok: true,
            skipped: "no_plans",
          });
          void vscode.window.showWarningMessage("Planstack: no plans loaded to re-sync.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          currentPlans.map((p) => ({
            label: p.title,
            description: p.id,
            detail: `${p.phases.length} phase(s)`,
            planId: p.id,
          })),
          {
            title: "Planstack: Re-sync plan to current codebase",
            placeHolder: "Select a plan to re-sync",
            ignoreFocusOut: true,
          },
        );
        if (!pick) {
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.resyncPlan",
            ok: true,
            cancelled: true,
          });
          return;
        }
        selectedPlanId = pick.planId;
      }

      const loaded = await loadPlansFromWorkspace();
      const ordered = orderPlans(loaded, context.workspaceState.get<string[]>(PLAN_ORDER_KEY));
      const existingPlan = ordered.find((p) => p.id === selectedPlanId);
      if (!existingPlan) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.resyncPlan",
          ok: true,
          skipped: "plan_not_found",
          planId: selectedPlanId,
        });
        void vscode.window.showWarningMessage("Planstack: selected plan not found — refresh and try again.");
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Planstack: Re-syncing "${existingPlan.title}"`,
            cancellable: false,
          },
          async () => {
            const regenerated = await resyncPlanFromCurrentWorkspace({
              extensionContext: context,
              workspaceRoot: root,
              existingPlan,
              extraInstructions: "Reset stale in_progress phases/tasks to pending so they can be re-done.",
              debugTraceId: tid,
            });
            const merged: Plan = {
              ...regenerated,
              id: existingPlan.id,
              git: regenerated.git ?? existingPlan.git,
              createdAt: regenerated.createdAt ?? existingPlan.createdAt,
            };
            normalizeStaleInProgressToPending(merged);
            applyTaskPromptDefaultsFromDesc(merged);
            await savePlanPreservingFile(merged, root);
          },
        );
        await refreshPlans(sidebarUi);
        void vscode.window.showInformationMessage(
          `Planstack: re-synced "${existingPlan.title}" to the current codebase and reset stale in-progress work to pending.`,
        );
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.resyncPlan",
          ok: true,
          planId: existingPlan.id,
        });
      } catch (e) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.resyncPlan",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof Error && e.stack) {
          traceMultiline(tid, "resyncPlan.error.stack", e.stack);
        }
        throw e;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.mergePlan", async (item: unknown) => {
      const tid = newTraceId("cmd-mergePlan");
      traceEvent(tid, "command.enter", {
        command: "hackupc.planstack.mergePlan",
        arg: summarizeCommandArg(item),
      });

      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.mergePlan",
          ok: true,
          skipped: "no_workspace",
        });
        void vscode.window.showWarningMessage("Planstack: no workspace folder found.");
        return;
      }

      const fromArg = typeof item === "string" && item.trim() ? item.trim() : undefined;
      let selectedPlanId = fromArg;
      if (!selectedPlanId) {
        const mergeCandidates = currentPlans.filter((p) => p.state === "completed" && !!p.git?.planBranch);
        if (mergeCandidates.length === 0) {
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.mergePlan",
            ok: true,
            skipped: "no_merge_candidates",
          });
          void vscode.window.showWarningMessage(
            "Planstack: no completed plans with git.planBranch are available to merge.",
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(
          mergeCandidates.map((p) => ({
            label: p.title,
            description: p.id,
            detail: `${p.git?.planBranch} -> ${p.git?.baseBranch || "main"}`,
            planId: p.id,
          })),
          {
            title: "Planstack: Merge plan branch into base branch",
            placeHolder: "Select a completed plan",
            ignoreFocusOut: true,
          },
        );
        if (!pick) {
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.mergePlan",
            ok: true,
            cancelled: true,
          });
          return;
        }
        selectedPlanId = pick.planId;
      }

      const loaded = await loadPlansFromWorkspace();
      const ordered = orderPlans(loaded, context.workspaceState.get<string[]>(PLAN_ORDER_KEY));
      const plan = ordered.find((p) => p.id === selectedPlanId);
      if (!plan) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.mergePlan",
          ok: true,
          skipped: "plan_not_found",
          planId: selectedPlanId,
        });
        void vscode.window.showWarningMessage("Planstack: selected plan not found — refresh and try again.");
        return;
      }

      const fromBranch = plan.git?.planBranch?.trim();
      const toBranch = plan.git?.baseBranch?.trim() || "main";
      const label = plan.title.trim() || plan.id;

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Planstack: Merging ${fromBranch || "(missing plan branch)"} into ${toBranch}`,
            cancellable: false,
          },
          async () => mergePlanBranchNoFf(plan),
        );
        await refreshPlans(sidebarUi);
        if (result.status === "already_merged") {
          void vscode.window.showInformationMessage(
            `Planstack: "${label}" is already merged (${result.planBranch} -> ${result.baseBranch}).`,
          );
        } else {
          void vscode.window.showInformationMessage(
            `Planstack: merged "${label}" (${result.planBranch} -> ${result.baseBranch}) with --no-ff.`,
          );
        }
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.mergePlan",
          ok: true,
          planId: plan.id,
          status: result.status,
          from: result.planBranch,
          to: result.baseBranch,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.mergePlan",
          ok: false,
          error: msg,
          planId: plan.id,
        });
        void vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.runPhase", async (item: unknown) => {
      const tid = newTraceId("runphase-cmd");
      traceEvent(tid, "command.enter", {
        command: "hackupc.planstack.runPhase",
        arg: summarizeCommandArg(item),
      });
      try {
        const picked = await pickPhaseInteractively();
        if (!picked) {
          traceEvent(tid, "runphase.cmd.abort", { reason: "cancelled_or_no_selection" });
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.runPhase",
            ok: true,
            skipped: "cancelled_or_no_selection",
          });
          return;
        }
        traceEvent(tid, "runphase.cmd.resolved", {
          planId: picked.plan.id,
          phaseId: picked.phase.id,
          planTitle: picked.plan.title,
          phaseTitle: picked.phase.title,
        });
        const started = await runPhaseWithBranchDecision(picked.plan, picked.phase, tid, "command_palette");
        if (!started) {
          traceEvent(tid, "runphase.cmd.abort", { reason: "user_cancelled_or_branch_prep_failed" });
          traceEvent(tid, "command.exit", {
            command: "hackupc.planstack.runPhase",
            ok: true,
            skipped: "user_cancelled_or_branch_prep_failed",
          });
          return;
        }
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.runPhase", ok: true });
      } catch (e) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.runPhase",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof Error && e.stack) {
          traceMultiline(tid, "runphase.cmd.error.stack", e.stack);
        }
        throw e;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hackupc.planstack.setMongoConnectionString", async () => {
      const tid = newTraceId("cmd-setmongo");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.setMongoConnectionString" });
      const value = await vscode.window.showInputBox({
        title: "MongoDB connection string (Planstack plan sync)",
        prompt:
          "Stored in VS Code Secret Storage. Use Atlas SRV URI (mongodb+srv://…). Leave empty to clear and fall back to MONGODB_URI env when set.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.setMongoConnectionString",
          ok: true,
          cancelled: true,
        });
        return;
      }
      if (!value.trim()) {
        await context.secrets.delete(PLANSTACK_MONGODB_URI_SECRET);
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.setMongoConnectionString",
          ok: true,
          cleared: true,
        });
        void vscode.window.showInformationMessage("Planstack: cleared stored MongoDB connection string.");
        return;
      }
      await context.secrets.store(PLANSTACK_MONGODB_URI_SECRET, value.trim());
      traceEvent(tid, "command.exit", {
        command: "hackupc.planstack.setMongoConnectionString",
        ok: true,
        storedChars: value.trim().length,
      });
      void vscode.window.showInformationMessage("Planstack: MongoDB connection string saved for this profile.");
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
    vscode.commands.registerCommand("hackupc.planstack.setJunieApiToken", async () => {
      const tid = newTraceId("cmd-setjunie");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.setJunieApiToken" });
      const value = await vscode.window.showInputBox({
        title: "Junie API token (Planstack / Junie CLI)",
        prompt:
          "Token from junie.jetbrains.com/cli. Stored in Secret Storage; passed as --auth when using Junie executor. Leave empty to clear.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.setJunieApiToken", ok: true, cancelled: true });
        return;
      }
      if (!value.trim()) {
        await context.secrets.delete(JUNIE_API_KEY_SECRET);
        traceEvent(tid, "command.exit", { command: "hackupc.planstack.setJunieApiToken", ok: true, cleared: true });
        void vscode.window.showInformationMessage("Planstack: cleared stored Junie API token.");
        return;
      }
      await context.secrets.store(JUNIE_API_KEY_SECRET, value.trim());
      traceEvent(tid, "command.exit", {
        command: "hackupc.planstack.setJunieApiToken",
        ok: true,
        storedChars: value.trim().length,
      });
      void vscode.window.showInformationMessage("Planstack: Junie API token saved for this profile.");
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
    vscode.commands.registerCommand("hackupc.planstack.confirmStopHeadlessAgents", async () => {
      const tid = newTraceId("cmd-confirm-killagents");
      traceEvent(tid, "command.enter", { command: "hackupc.planstack.confirmStopHeadlessAgents" });
      const pick = await vscode.window.showWarningMessage(
        "Stop running Planstack headless agent processes? In-flight runs will abort.",
        { modal: true },
        "Stop",
      );
      if (pick !== "Stop") {
        traceEvent(tid, "command.exit", {
          command: "hackupc.planstack.confirmStopHeadlessAgents",
          ok: true,
          cancelled: true,
        });
        return;
      }
      await vscode.commands.executeCommand("hackupc.planstack.killAgentRuns");
      traceEvent(tid, "command.exit", { command: "hackupc.planstack.confirmStopHeadlessAgents", ok: true });
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
        const picked = await pickTaskInteractively();
        if (!picked) {
          traceEvent(tid, "command.exit", {
            command: `hackupc.planstack.taskSetState.${state}`,
            ok: true,
            skipped: "cancelled_or_no_selection",
          });
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

        const ok = await mutatePlan(picked.plan.id, (plan) => {
          const phase = plan.phases.find((ph) => ph.id === picked.phase.id);
          const task = phase?.tasks.find((t) => t.id === picked.task.id);
          if (!phase || !task) {
            return false;
          }
          task.state = state;
        });
        if (!ok) {
          void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
          return;
        }
        await refreshPlans(sidebarUi);
        traceEvent(tid, "command.exit", {
          command: `hackupc.planstack.taskSetState.${state}`,
          ok: true,
          planId: picked.plan.id,
          phaseId: picked.phase.id,
          taskId: picked.task.id,
        });
      }),
    );
  }

  void refreshPlans(sidebarUi);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshPlans(sidebarUi);
    }),
    watchPlans(() => {
      void refreshPlans(sidebarUi);
    }),
  );
}

export function deactivate(): void {}

