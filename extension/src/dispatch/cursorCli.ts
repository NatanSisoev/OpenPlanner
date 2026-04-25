import * as vscode from "vscode";
import { AgentCliError, runAgentPrint } from "../plan/agentCliRunner";
import { buildAgentEnv, resolveCursorApiKey } from "../plan/createPlanFromCli";
import { resolveDefaultAgentExecutable } from "../plan/agentPath";
import { postChatSystemMessage } from "../ui/chatStatusBridge";

let planstackOutput: vscode.OutputChannel | undefined;

function appendRunLog(stdout: string, stderr: string): void {
  planstackOutput ??= vscode.window.createOutputChannel("Planstack");
  const tail = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n)}`);
  planstackOutput.appendLine(`--- Run phase (CLI) ${new Date().toISOString()} ---`);
  if (stderr.trim()) {
    planstackOutput.appendLine("[stderr]\n" + tail(stderr.trim(), 2000));
  }
  if (stdout.trim()) {
    planstackOutput.appendLine("[stdout tail]\n" + tail(stdout.trim(), 3000));
  }
}

/**
 * Run Cursor `agent` in print mode with `--force` so the model may edit the workspace (same idea as
 * scripts/cursor-agent-smoke.sh --write-demo).
 */
export async function handoffViaAgentCli(
  prompt: string,
  extensionContext: vscode.ExtensionContext,
  statusLabel?: string,
): Promise<void> {
  const label = (statusLabel?.trim() || "Run phase").slice(0, 200);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    postChatSystemMessage(`${label}: skipped — no workspace folder open.`);
    await vscode.window.showErrorMessage("Planstack: open a workspace folder before running phase with the CLI.");
    return;
  }

  const apiKey = await resolveCursorApiKey(extensionContext);
  if (!apiKey) {
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
  const cwd = folder.uri.fsPath;
  const env = await buildAgentEnv(extensionContext);
  const resolvedAgent = resolveDefaultAgentExecutable(agentPath);

  const heartbeatEveryMs = 45_000;
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const elapsedHuman = elapsedSec < 60 ? `${elapsedSec}s` : `~${Math.floor(elapsedSec / 60)} min`;
    postChatSystemMessage(`${label}: still running (${elapsedHuman} elapsed)…`);
  }, heartbeatEveryMs);

  try {
    const { stdout, stderr, exitCode } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Planstack: running Cursor agent for this phase…",
        cancellable: false,
      },
      () =>
        runAgentPrint({
          agentPath: resolvedAgent,
          cwd,
          prompt,
          env,
          timeoutMs,
          maxStdoutChars,
          applyEdits: true,
        }),
    );

    appendRunLog(stdout, stderr);

    if (exitCode !== 0) {
      const tail = stderr.trim() || stdout.slice(-500);
      planstackOutput?.show(true);
      const detail = tail ? tail.slice(0, 280) : "see Output → Planstack";
      postChatSystemMessage(`${label}: agent exited with code ${exitCode}. ${detail}`);
      await vscode.window.showErrorMessage(
        `Planstack: agent exited with code ${exitCode}. ${tail ? `Details: ${tail.slice(0, 400)}` : ""}`.trim(),
      );
      return;
    }

    postChatSystemMessage(`${label}: finished — check the workspace for changes (Output → Planstack for a log tail).`);
    await vscode.window.showInformationMessage("Planstack: phase CLI run finished. Check the workspace for changes; see Output → Planstack for a log tail.");
  } catch (e) {
    const msg = e instanceof AgentCliError ? e.message : e instanceof Error ? e.message : String(e);
    if (e instanceof AgentCliError && e.stderr?.trim()) {
      appendRunLog("", e.stderr);
    }
    planstackOutput?.show(true);
    postChatSystemMessage(`${label}: failed — ${msg.slice(0, 400)}`);
    await vscode.window.showErrorMessage(`Planstack: ${msg.slice(0, 2000)}`);
  } finally {
    clearInterval(heartbeat);
  }
}
