import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { formatGitSnapshotDeltaForChat, gitSnapshotFingerprint } from "../git/gitSnapshotDelta";
import { getWorktreeChangeSummary, getWorktreeNumstat, type WorktreeChangeSummary } from "../git/worktreeChangeSummary";
import { postAnimatedStatus, postRunFailure, postRunSummary } from "../ui/richChatBridge";
import { getOutput, logLine } from "../log";
import { AgentCliError, AgentRunBusyError, runExternalCli } from "../plan/agentCliRunner";
import { resolveDefaultAgentExecutable } from "../plan/agentPath";
import { getJunieExecutable } from "../plan/executorConfig";
import { buildJunieCliArgs } from "../plan/junieCliArgs";
import { buildJunieCliEnv, resolveJunieApiKey } from "../plan/junieApiKey";
import {
  postAgentStreamEnd,
  postAgentStreamStart,
  postAgentStreamChunk,
  type AgentStreamEndReason,
} from "../ui/agentChatStreamBridge";
import { postChatSystemMessage } from "../ui/chatStatusBridge";
import { PS_RUN_UI } from "../ui/runUiStrings";
import type { CliPhaseRunFinishedKind } from "./cursorCli";

function appendRunLog(stdout: string, stderr: string): void {
  const out = getOutput();
  const tail = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n)}`);
  out.appendLine(`--- Run phase (Junie CLI) ${new Date().toISOString()} ---`);
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
 * Run phase via Junie CLI in the workspace (headless). Mirrors {@link handoffViaAgentCli} UX.
 */
export async function handoffViaJunieCli(
  prompt: string,
  extensionContext: vscode.ExtensionContext,
  statusLabel?: string,
  traceId?: string,
  onCliRunFinished?: (kind: CliPhaseRunFinishedKind) => void | Promise<void>,
): Promise<void> {
  const tid = traceId ?? newTraceId("junieCli");
  const notifyFinished = async (kind: CliPhaseRunFinishedKind): Promise<void> => {
    if (!onCliRunFinished) {
      return;
    }
    try {
      await onCliRunFinished(kind);
    } catch (e) {
      logLine(`handoffViaJunieCli: onCliRunFinished(${kind}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const label = (statusLabel?.trim() || PS_RUN_UI.cliPhaseDefaultStreamLabel).slice(0, 200);
  traceEvent(tid, "handoffViaJunieCli.enter", { label, statusLabel, promptLength: prompt.length });
  traceMultiline(tid, "handoffViaJunieCli.prompt", prompt);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    traceEvent(tid, "handoffViaJunieCli.skip", { reason: "no_workspace_folder" });
    postChatSystemMessage(`${label}: skipped — no workspace folder open.`);
    await vscode.window.showErrorMessage("Planstack: open a workspace folder before running a phase with the CLI.");
    await notifyFinished("error");
    return;
  }

  const apiKey = await resolveJunieApiKey(extensionContext);
  if (!apiKey) {
    traceEvent(tid, "handoffViaJunieCli.skip", { reason: "no_junie_api_key" });
    postChatSystemMessage(`${label}: skipped — Junie token not set (use “Planstack: Set Junie API token”).`);
    await vscode.window.showErrorMessage(
      "Planstack: Junie API token is not set. Use “Planstack: Set Junie API token” or export JUNIE_API_KEY for the Extension Host.",
    );
    await notifyFinished("error");
    return;
  }

  postChatSystemMessage(`${label}: starting Junie CLI…`);

  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const juniePath = getJunieExecutable();
  const timeoutMs = cfg.get<number>("agentTimeoutMs") ?? 180_000;
  const maxStdoutChars = cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000;
  const streamToOutput = cfg.get<boolean>("cliStreamAgentOutput") ?? true;
  const progressThrottleMs = cfg.get<number>("cliStreamProgressThrottleMs") ?? 2_000;
  const chatThrottleMs = cfg.get<number>("cliStreamChatThrottleMs") ?? 25_000;
  const showGitSummary = cfg.get<boolean>("showGitSummaryAfterCliRun") ?? true;
  const useLiveChat = cfg.get<boolean>("agentChatLiveStream") ?? true;
  const gitSnapshotEveryMs = cfg.get<number>("cliRunGitSnapshotIntervalMs") ?? 30_000;
  const agentDigestEveryMs = cfg.get<number>("cliRunAgentDigestIntervalMs") ?? 15_000;
  const useWsl = cfg.get<boolean>("useWsl") ?? false;
  const wslDistro = cfg.get<string>("wslDistro")?.trim() || "Ubuntu";

  const cwd = folder.uri.fsPath;
  const env = await buildJunieCliEnv(extensionContext);
  const resolvedJunie = useWsl ? juniePath : resolveDefaultAgentExecutable(juniePath);
  const args = buildJunieCliArgs({
    cwd,
    authToken: apiKey,
    timeoutMs,
    task: prompt,
  });

  traceEvent(tid, "handoffViaJunieCli.config", {
    juniePath,
    resolvedJunie,
    timeoutMs,
    maxStdoutChars,
    cwd,
  });

  const startedAt = Date.now();
  const output = getOutput();
  output.show(true);
  output.appendLine(`\n=== ${label}: Junie CLI run started ${new Date().toISOString()} ===\n`);

  try {
    const runId = randomUUID();
    let endReason: AgentStreamEndReason = "complete";

    postAnimatedStatus(runId);

    const { stdout, stderr, exitCode } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: PS_RUN_UI.vscodeProgressRunPhaseJunie,
        cancellable: false,
      },
      async (progress) => {
        const progressTimers: ReturnType<typeof setInterval>[] = [];
        let outBuf = "";
        let errBuf = "";
        let lastGitSnapshot: WorktreeChangeSummary | undefined;
        let lastDigestKey = "";
        let gitSnapshotBusy = false;

        const clearProgressTimers = (): void => {
          for (const t of progressTimers) {
            clearInterval(t);
          }
          progressTimers.length = 0;
        };

        if (gitSnapshotEveryMs > 0) {
          progressTimers.push(
            setInterval(() => {
              if (gitSnapshotBusy) {
                return;
              }
              gitSnapshotBusy = true;
              void getWorktreeChangeSummary(cwd)
                .then((s) => {
                  if (!s) {
                    return;
                  }
                  const sig = gitSnapshotFingerprint(s);
                  if (lastGitSnapshot && sig === gitSnapshotFingerprint(lastGitSnapshot)) {
                    return;
                  }
                  const msg = formatGitSnapshotDeltaForChat(lastGitSnapshot, s);
                  lastGitSnapshot = { statusLine: s.statusLine, diffStat: s.diffStat };
                  if (!msg) {
                    return;
                  }
                  postChatSystemMessage(`${label} [git]\n${msg}`);
                })
                .catch(() => {
                  /* ignore */
                })
                .finally(() => {
                  gitSnapshotBusy = false;
                });
            }, gitSnapshotEveryMs),
          );
        }

        if (agentDigestEveryMs > 0) {
          progressTimers.push(
            setInterval(() => {
              const o = outBuf.trimEnd();
              const e = errBuf.trimEnd();
              if (!o && !e) {
                return;
              }
              const key = `${o.slice(-500)}|${e.slice(-400)}`;
              if (key === lastDigestKey) {
                return;
              }
              lastDigestKey = key;
              const block =
                (o ? `stdout (tail):\n${o.slice(-520)}` : "(no stdout yet)") +
                (e ? `\n\nstderr (tail):\n${e.slice(-420)}` : "");
              postChatSystemMessage(`${label} [junie]\n${block.slice(-950)}`);
            }, agentDigestEveryMs),
          );
        }

        if (useLiveChat) {
          postAgentStreamStart(runId, {
            label,
            source: "runPhase",
          });
        }
        const baseHandlers = buildStreamHandlers({
          streamToOutput,
          output,
          progressThrottleMs,
          chatThrottleMs,
          progress,
          label,
          liveRunId: useLiveChat ? runId : undefined,
        });
        const onStdoutChunk = (text: string): void => {
          if (text) {
            outBuf = (outBuf + text).slice(-150_000);
          }
          baseHandlers.onStdoutChunk(text);
        };
        const onStderrChunk = (text: string): void => {
          if (text) {
            errBuf = (errBuf + text).slice(-150_000);
          }
          baseHandlers.onStderrChunk(text);
        };
        try {
          const r = await runExternalCli({
            executable: resolvedJunie,
            args,
            cwd,
            env,
            timeoutMs,
            maxStdoutChars,
            onStdoutChunk,
            onStderrChunk,
            debugTraceId: tid,
            useWsl,
            wslDistro,
            wslPassThroughKeys: ["JUNIE_API_KEY"],
            onStallWarning: (idleMs) => {
              postChatSystemMessage(
                `${label}: no Junie output for ${Math.floor(idleMs / 1000)}s — process may be stalled. Use “Stop agents” to abort.`,
              );
            },
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
          clearProgressTimers();
          postAgentStreamEnd(runId, endReason);
        }
      },
    );

    appendRunLog(stdout, stderr);
    traceEvent(tid, "handoffViaJunieCli.finished", {
      exitCode,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
    });

    if (exitCode !== 0) {
      await notifyFinished("error");
      const tail = stderr.trim() || stdout.slice(-500);
      output.show(true);
      const detail = tail ? tail.slice(0, 280) : "see Output → Planstack";
      postRunFailure(runId, {
        phaseLabel: label,
        durationSec: Math.floor((Date.now() - startedAt) / 1000),
        summary: `Junie CLI exited with code ${exitCode}`,
        details: tail.slice(0, 2000),
        retryPrompt: prompt,
      });
      postChatSystemMessage(`${label}: Junie CLI exited with code ${exitCode}. ${detail}`);
      await vscode.window.showErrorMessage(
        `Planstack: Junie CLI exited with code ${exitCode}. ${tail ? `Details: ${tail.slice(0, 400)}` : ""}`.trim(),
      );
      return;
    }

    await notifyFinished("success");

    const durationSec = Math.floor((Date.now() - startedAt) / 1000);

    if (showGitSummary) {
      try {
        const [summary, files] = await Promise.all([
          getWorktreeChangeSummary(cwd),
          getWorktreeNumstat(cwd),
        ]);
        traceEvent(tid, "handoffViaJunieCli.git_summary", {
          hasSummary: Boolean(summary),
          statusLine: summary?.statusLine ?? null,
          diffStatHead: summary?.diffStat ? summary.diffStat.slice(0, 500) : null,
          fileCount: files.length,
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
        }
        postRunSummary(runId, {
          phaseLabel: label,
          durationSec,
          files,
          totalAdditions: files.reduce((s, f) => s + f.additions, 0),
          totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
          exitCode: 0,
        });
      } catch (summaryErr) {
        const msg = summaryErr instanceof Error ? summaryErr.message : String(summaryErr);
        traceEvent(tid, "handoffViaJunieCli.git_summary_error", { message: msg });
        output.appendLine(`Planstack: non-fatal Git summary error: ${msg}`);
        postChatSystemMessage(`${label}: run finished, but Git summary failed (see Output → Planstack).`);
      }
    } else {
      postChatSystemMessage(`${label}: finished — check the workspace for changes (Output → Planstack for a log tail).`);
      await vscode.window.showInformationMessage(
        "Planstack: phase Junie CLI run finished. Check the workspace for changes; see Output → Planstack for a log tail.",
      );
    }
  } catch (e) {
    traceEvent(tid, "handoffViaJunieCli.catch", {
      name: e instanceof Error ? e.name : typeof e,
      message: e instanceof Error ? e.message : String(e),
      agentRunBusy: e instanceof AgentRunBusyError,
    });
    if (e instanceof AgentRunBusyError) {
      await notifyFinished("error");
      postChatSystemMessage(`${label}: skipped — ${e.message}`);
      void vscode.window.showWarningMessage(e.message);
      return;
    }
    const msg = e instanceof AgentCliError ? e.message : e instanceof Error ? e.message : String(e);
    const stopped = e instanceof AgentCliError && msg.includes("stopped");
    await notifyFinished(stopped ? "stopped" : "error");
    postRunFailure(randomUUID(), {
      phaseLabel: label,
      durationSec: Math.floor((Date.now() - startedAt) / 1000),
      summary: stopped ? "Run stopped by user" : "Run failed",
      details: msg.slice(0, 2000),
      retryPrompt: prompt,
    });
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
    traceEvent(tid, "handoffViaJunieCli.finally", {});
  }
}
