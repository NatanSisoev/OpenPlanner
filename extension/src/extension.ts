import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "./debug/trace";
import { handoffToNativeComposer } from "./dispatch/cursorNativeHandoff";
import type { CliPhaseRunFinishedKind } from "./dispatch/cursorCli";
import { dispatchPhaseHandoff } from "./dispatch/router";
import { mergePlanBranchNoFf } from "./git/mergePlanBranch";
import { ensurePlanWorkBranch } from "./git/ensurePlanWorkBranch";
import { effectiveWorkBranch, summarizeGitForPlan } from "./git/resolver";
import { loadPlansFromWorkspace, watchPlans } from "./plan/loader";
import { blockingDependencies, deriveAggregateState, recomputeAggregates } from "./plan/aggregate";
import { buildPhaseHandoffPrompt } from "./plan/prompt";
import { CURSOR_API_KEY_SECRET, resyncPlanFromCurrentWorkspace, runAgentPromptEdits } from "./plan/createPlanFromCli";
import { debugCliConnection } from "./plan/debugCliConnection";
import { AgentCliError, AgentRunBusyError, isAgentRunBusy, killAllAgentCliProcesses } from "./plan/agentCliRunner";
import { getOutput, logLine } from "./log";
import { savePlanPreservingFile, deletePlanFile } from "./plan/writePlan";
import { PlanstackChatWebview, CHAT_WEBVIEW_ID } from "./ui/planstackChatWebview";
import { postChatSystemMessage, postChatUserMessage } from "./ui/chatStatusBridge";
import { postAgentStreamChunk, postAgentStreamEnd, postAgentStreamStart, type AgentStreamEndReason } from "./ui/agentChatStreamBridge";
import { postAnimatedStatus, postRunFailure } from "./ui/richChatBridge";
import { PlanstackSidebarWebview, SIDEBAR_WEBVIEW_ID } from "./ui/planstackSidebarWebview";
import { PlanTreeProvider, PLAN_TREE_VIEW_ID, PhaseTreeItem, TaskTreeItem } from "./ui/planTreeProvider";
import { WORK_STATES, type ExecutionState } from "./plan/types";
import type { Plan } from "./plan/types";

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

export function activate(context: vscode.ExtensionContext): void {
  const extUri = context.extensionUri;
  type RunEntrySource = "sidebar_webview" | "tree_command";
  type BranchDecision = "prepare_branch" | "current_branch" | "cancel";

  const phaseRunHooks: {
    applyOutcome?: (planId: string, phaseId: string, outcome: CliPhaseRunFinishedKind) => Promise<void>;
  } = {};
  let refreshGeneration = 0;
  const planMutationQueues = new Map<string, Promise<unknown>>();

  async function refreshPlansOrdered(provider: PlanTreeProvider, sidebar: PlanstackSidebarWebview): Promise<void> {
    const generation = ++refreshGeneration;
    const loaded = await loadPlansFromWorkspace();
    if (generation !== refreshGeneration) {
      return;
    }
    const savedOrder = context.workspaceState.get<string[]>(PLAN_ORDER_KEY);
    currentPlans = orderPlans(loaded, savedOrder);
    provider.setPlans(currentPlans);
    sidebar.setPlans(currentPlans);
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

  function planChatLabel(plan: Plan): string {
    const title = plan.title.trim();
    return title.length > 0 ? `${title} (${plan.id})` : plan.id;
  }

  function emitRunRequestMessage(plan: Plan, phase: Plan["phases"][number], source: RunEntrySource): void {
    const sourceLabel = source === "tree_command" ? "tree" : "sidebar";
    postChatUserMessage(`Run phase request: ${plan.title} › ${phase.title} (${sourceLabel})`);
  }

  function emitTaskRunRequestMessage(
    plan: Plan,
    phase: Plan["phases"][number],
    task: Plan["phases"][number]["tasks"][number],
    source: RunEntrySource,
  ): void {
    const sourceLabel = source === "tree_command" ? "tree" : "sidebar";
    postChatUserMessage(`Run task request: ${plan.title} › ${phase.title} › ${task.desc} (${sourceLabel})`);
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
    const prompt = (task.prompt ?? "").trim();
    if (!prompt) {
      void vscode.window.showWarningMessage(
        `Planstack: task "${task.desc}" has no prompt. Open task details and add a prompt before running.`,
      );
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

    emitTaskRunRequestMessage(plan, phase, task, source);
    postChatSystemMessage(`${planChatLabel(plan)}: running task "${task.desc}".`);

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
    output.appendLine(`\n=== ${statusLabel}: task run started ${new Date().toISOString()} ===\n`);

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
                  maybeChat("Task run: ", text);
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
                  maybeChat("Task run (stderr): ", last);
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
      postChatSystemMessage(`${statusLabel}: task run completed.`);
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
          summary: stopped ? "Task run stopped by user" : "Task run failed",
          details: msg.slice(0, 2000),
          retryPrompt: prompt,
        });
        postChatSystemMessage(`${statusLabel}: ${stopped ? "task run stopped." : `task run failed — ${msg.slice(0, 400)}`}`);
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
    const sourceLabel = source === "tree_command" ? "Plans tree" : "Overview";

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
          label: "$(play) Run on current branch",
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

  async function runPhaseWithBranchDecision(
    plan: Plan,
    phase: Plan["phases"][number],
    traceId: string,
    source: RunEntrySource,
  ): Promise<boolean> {
    const blockers = blockingDependencies(plan, phase);
    if (blockers.length > 0) {
      void vscode.window.showWarningMessage(
        `Planstack: phase "${phase.title}" is blocked by incomplete dependencies: ${blockers.join(", ")}`,
      );
      traceEvent(traceId, "runphase.blocked_dependencies", { planId: plan.id, phaseId: phase.id, blockers });
      return false;
    }
    if (isAgentRunBusy()) {
      void vscode.window.showWarningMessage(
        "Planstack: an agent run is already in progress. Stop it or wait for completion, then retry.",
      );
      traceEvent(traceId, "runphase.agent_busy_preflight", { planId: plan.id, phaseId: phase.id });
      return false;
    }
    const decision = await askRunBranchDecision(plan, phase, source);
    traceEvent(traceId, "runphase.branch_decision", { source, decision, planId: plan.id, phaseId: phase.id });
    if (decision === "cancel") {
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
    await dispatchPhaseHandoff(prompt, context, {
      statusLabel: `${plan.title} › ${phase.title}`,
      traceId,
      onCliRunFinished: (kind) =>
        phaseRunHooks.applyOutcome ? phaseRunHooks.applyOutcome(plan.id, phase.id, kind) : Promise.resolve(),
    });
    return true;
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
      await refreshPlansOrdered(tree, sidebarUi);
      return true;
    });
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
      await refreshPlansOrdered(tree, sidebarUi);
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
      await refreshPlansOrdered(tree, sidebarUi);
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
      await refreshPlansOrdered(tree, sidebarUi);
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
          if (Array.isArray(remaining.dependsOn) && remaining.dependsOn.includes(phaseId)) {
            remaining.dependsOn = remaining.dependsOn.filter((id) => id !== phaseId);
          }
        }
      });
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
  });
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
    } catch (e) {
      logLine(`applyPhaseRunOutcome: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const chatUi = new PlanstackChatWebview(
    extUri,
    context,
    async () => {
      await refreshPlansOrdered(tree, sidebarUi);
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

  function resolvePlanFromArg(arg: unknown): Plan | undefined {
    const phase = resolvePhaseTreeItem(arg);
    if (phase) {
      return phase.plan;
    }
    const task = resolveTaskTreeItem(arg);
    if (task) {
      return task.plan;
    }
    return undefined;
  }

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

      const fromArg = resolvePlanFromArg(item);
      let selectedPlanId = fromArg?.id;
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
            await savePlanPreservingFile(merged, root);
          },
        );
        await refreshPlansOrdered(tree, sidebarUi);
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

      const fromArg = typeof item === "string" ? item : resolvePlanFromArg(item)?.id;
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
        await refreshPlansOrdered(tree, sidebarUi);
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
        const started = await runPhaseWithBranchDecision(phaseItem.plan, phaseItem.phase, tid, "tree_command");
        if (!started) {
          traceEvent(tid, "runphase.tree.abort", { reason: "user_cancelled_or_branch_prep_failed" });
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

        const ok = await mutatePlan(taskItem.plan.id, (plan) => {
          const phase = plan.phases.find((ph) => ph.id === taskItem.phase.id);
          const task = phase?.tasks.find((t) => t.id === taskItem.task.id);
          if (!phase || !task) {
            return false;
          }
          task.state = state;
        });
        if (!ok) {
          void vscode.window.showWarningMessage("Planstack: task not found — refresh and try again.");
          return;
        }
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

