import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { formatGitSummaryChatLine, getWorktreeChangeSummary } from "../git/worktreeChangeSummary";
import { getOutput } from "../log";
import { AgentCliError, AgentRunBusyError, runAgentPrint } from "../plan/agentCliRunner";
import { buildAgentEnv, resolveCursorApiKey } from "../plan/createPlanFromCli";
import { resolveDefaultAgentExecutable } from "../plan/agentPath";
import {
  postAgentStreamEnd,
  postAgentStreamStart,
  postAgentStreamChunk,
  type AgentStreamEndReason,
} from "../ui/agentChatStreamBridge";
import { postChatSystemMessage } from "../ui/chatStatusBridge";

function appendRunLog(stdout: string, stderr: string): void {
  const out = getOutput();
  const tail = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n)}`);
  out.appendLine(`--- Run phase (CLI) ${new Date().toISOString()} ---`);
  if (stderr.trim()) {
    out.appendLine("[stderr]\n" + tail(stderr.trim(), 2000));
  }
  if (stdout.trim()) {
    out.appendLine("[stdout tail]\n" + tail(stdout.trim(), 3000));
  }
}

function buildStreamHandlers(opts: {
  streamToOutput: boolean;
  output: vscode.OutputChannel;
  progressThrottleMs: number;
  chatThrottleMs: number;
  progress: vscode.Progress<{ message?: string }>;
  label: string;
  /** When set, mirror chunks to live Chat stream and skip throttled chat bubbles. */
  liveRunId?: string;
}): { onStdoutChunk: (t: string) => void; onStderrChunk: (t: string) => void } {
  const useLive = !!opts.liveRunId;
  let lastProgressAt = 0;
  let lastChatAt = 0;

  const maybeChat = (snippet: string): void => {
    if (useLive) {
      return;
    }
    const t = snippet.trim();
    if (!t) {
      return;
    }
    const now = Date.now();
    if (now - lastChatAt < opts.chatThrottleMs) {
      return;
    }
    lastChatAt = now;
    postChatSystemMessage(`${opts.label}: ${t.slice(-220)}`);
  };

  return {
    onStdoutChunk: (text: string) => {
      if (opts.streamToOutput && text) {
        opts.output.append(text);
      }
      if (useLive && opts.liveRunId && text) {
        postAgentStreamChunk(opts.liveRunId, "stdout", text);
      }
      maybeChat(text);
    },
    onStderrChunk: (text: string) => {
      if (opts.streamToOutput && text) {
        opts.output.append(text);
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const lastLine = lines.length > 0 ? lines[lines.length - 1]! : text.trim().slice(-160);
      const now = Date.now();
      if (lastLine && now - lastProgressAt >= opts.progressThrottleMs) {
        lastProgressAt = now;
        opts.progress.report({ message: lastLine.slice(0, 120) });
      }
      if (useLive && opts.liveRunId && text) {
        postAgentStreamChunk(opts.liveRunId, "stderr", text);
      }
      if (text.trim()) {
        maybeChat(lastLine || text);
      }
    },
  };
}

/**
 * Run Cursor `agent` in print mode with `--force` so the model may edit the workspace (same idea as
 * scripts/cursor-agent-smoke.sh --write-demo).
 */
export async function handoffViaAgentCli(
  prompt: string,
  extensionContext: vscode.ExtensionContext,
  statusLabel?: string,
  traceId?: string,
): Promise<void> {
  const tid = traceId ?? newTraceId("cursorCli");
  const label = (statusLabel?.trim() || "Run phase").slice(0, 200);
  traceEvent(tid, "handoffViaAgentCli.enter", { label, statusLabel, promptLength: prompt.length });
  traceMultiline(tid, "handoffViaAgentCli.prompt", prompt);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    traceEvent(tid, "handoffViaAgentCli.skip", { reason: "no_workspace_folder" });
    postChatSystemMessage(`${label}: skipped — no workspace folder open.`);
    await vscode.window.showErrorMessage("Planstack: open a workspace folder before running phase with the CLI.");
    return;
  }

  const apiKey = await resolveCursorApiKey(extensionContext);
  if (!apiKey) {
    traceEvent(tid, "handoffViaAgentCli.skip", { reason: "no_cursor_api_key" });
    postChatSystemMessage(`${label}: skipped — CURSOR_API_KEY not set (use “Planstack: Set Cursor API key”).`);
    await vscode.window.showErrorMessage(
      "Planstack: CURSOR_API_KEY is not set. Use “Planstack: Set Cursor API key” or export it for the Extension Host.",
    );
    return;
  }

  postChatSystemMessage(`${label}: starting Cursor agent (CLI, --force)…`);

  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const agentPath = cfg.get<string>("agentPath")?.trim() || "agent";
  const timeoutMs = cfg.get<number>("agentTimeoutMs") ?? 180_000;
  const maxStdoutChars = cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000;
  const streamToOutput = cfg.get<boolean>("cliStreamAgentOutput") ?? true;
  const progressThrottleMs = cfg.get<number>("cliStreamProgressThrottleMs") ?? 2_000;
  const chatThrottleMs = cfg.get<number>("cliStreamChatThrottleMs") ?? 25_000;
  const showGitSummary = cfg.get<boolean>("showGitSummaryAfterCliRun") ?? true;
  const useLiveChat = cfg.get<boolean>("agentChatLiveStream") ?? true;

  const cwd = folder.uri.fsPath;
  const env = await buildAgentEnv(extensionContext);
  const resolvedAgent = resolveDefaultAgentExecutable(agentPath);
  traceEvent(tid, "handoffViaAgentCli.config", {
    agentPath,
    resolvedAgent,
    timeoutMs,
    maxStdoutChars,
    streamToOutput,
    progressThrottleMs,
    chatThrottleMs,
    showGitSummary,
    useLiveChat,
    cwd,
  });

  const heartbeatEveryMs = 45_000;
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const elapsedHuman = elapsedSec < 60 ? `${elapsedSec}s` : `~${Math.floor(elapsedSec / 60)} min`;
    postChatSystemMessage(`${label}: still running (${elapsedHuman} elapsed)…`);
  }, heartbeatEveryMs);

  const output = getOutput();
  output.show(true);
  output.appendLine(`\n=== ${label}: agent run started ${new Date().toISOString()} ===\n`);

  try {
    const runId = randomUUID();
    let streamActive = false;
    let endReason: AgentStreamEndReason = "complete";

    const { stdout, stderr, exitCode } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Planstack: running Cursor agent for this phase…",
        cancellable: false,
      },
      async (progress) => {
        if (useLiveChat) {
          streamActive = true;
          postAgentStreamStart(runId, {
            label,
            source: "runPhase",
            initialLine:
              "Waiting for agent stdout/stderr…\n\nIf this stays empty for a long time, the Cursor CLI may be buffering until the run completes.\n\n",
          });
        }
        const { onStdoutChunk, onStderrChunk } = buildStreamHandlers({
          streamToOutput,
          output,
          progressThrottleMs,
          chatThrottleMs,
          progress,
          label,
          liveRunId: useLiveChat ? runId : undefined,
        });
        try {
          const r = await runAgentPrint({
            agentPath: resolvedAgent,
            cwd,
            prompt,
            env,
            timeoutMs,
            maxStdoutChars,
            applyEdits: true,
            onStdoutChunk,
            onStderrChunk,
            debugTraceId: tid,
          });
          if (r.exitCode !== 0) {
            endReason = "error";
          }
          return r;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          endReason =
            e instanceof AgentCliError && msg.includes("stopped") ? "stopped" : "error";
          throw e;
        } finally {
          if (streamActive) {
            postAgentStreamEnd(runId, endReason);
            streamActive = false;
          }
        }
      },
    );

    appendRunLog(stdout, stderr);
    traceEvent(tid, "handoffViaAgentCli.agent_finished", {
      exitCode,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
    });

    if (exitCode !== 0) {
      const tail = stderr.trim() || stdout.slice(-500);
      output.show(true);
      const detail = tail ? tail.slice(0, 280) : "see Output → Planstack";
      postChatSystemMessage(`${label}: agent exited with code ${exitCode}. ${detail}`);
      await vscode.window.showErrorMessage(
        `Planstack: agent exited with code ${exitCode}. ${tail ? `Details: ${tail.slice(0, 400)}` : ""}`.trim(),
      );
      return;
    }

    postChatSystemMessage(`${label}: finished — check the workspace for changes (Output → Planstack for a log tail).`);

    if (showGitSummary) {
      const summary = await getWorktreeChangeSummary(cwd);
      traceEvent(tid, "handoffViaAgentCli.git_summary", {
        hasSummary: Boolean(summary),
        statusLine: summary?.statusLine ?? null,
        diffStatHead: summary?.diffStat ? summary.diffStat.slice(0, 500) : null,
      });
      if (summary) {
        output.appendLine(`\n--- Git vs HEAD (${label}) ---\n`);
        if (summary.statusLine) {
          output.appendLine(summary.statusLine);
        }
        if (summary.diffStat) {
          output.appendLine(summary.diffStat);
        } else {
          output.appendLine("(no file changes vs HEAD)");
        }
        const chatLine = formatGitSummaryChatLine(summary);
        postChatSystemMessage(`${label}: changes vs HEAD —\n${chatLine}`);
        const openScm = "Open Source Control";
        await vscode.window
          .showInformationMessage(
            "Planstack: phase finished. Git summary vs HEAD is in Output → Planstack; open Source Control for the full diff.",
            openScm,
          )
          .then((choice) => {
            if (choice === openScm) {
              void vscode.commands.executeCommand("workbench.view.scm");
            }
          });
      } else {
        postChatSystemMessage(`${label}: Git summary skipped (not a repo or git unavailable).`);
        await vscode.window.showInformationMessage(
          "Planstack: phase CLI run finished. Check the workspace for changes; see Output → Planstack for a log tail.",
        );
      }
    } else {
      await vscode.window.showInformationMessage(
        "Planstack: phase CLI run finished. Check the workspace for changes; see Output → Planstack for a log tail.",
      );
    }
  } catch (e) {
    traceEvent(tid, "handoffViaAgentCli.catch", {
      name: e instanceof Error ? e.name : typeof e,
      message: e instanceof Error ? e.message : String(e),
      agentRunBusy: e instanceof AgentRunBusyError,
    });
    if (e instanceof AgentRunBusyError) {
      postChatSystemMessage(`${label}: skipped — ${e.message}`);
      void vscode.window.showWarningMessage(e.message);
      return;
    }
    const msg = e instanceof AgentCliError ? e.message : e instanceof Error ? e.message : String(e);
    const stopped = e instanceof AgentCliError && msg.includes("stopped");
    if (e instanceof AgentCliError && e.stderr?.trim() && !stopped) {
      appendRunLog("", e.stderr);
    }
    if (stopped) {
      output.appendLine(`\n=== ${label}: run stopped by user ===\n`);
    }
    output.show(true);
    postChatSystemMessage(`${label}: ${stopped ? "run aborted (process terminated)." : `failed — ${msg.slice(0, 400)}`}`);
    if (stopped) {
      void vscode.window.showWarningMessage(`Planstack: ${msg.slice(0, 2000)}`);
    } else {
      await vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
    }
  } finally {
    clearInterval(heartbeat);
    traceEvent(tid, "handoffViaAgentCli.finally", {});
  }
}
