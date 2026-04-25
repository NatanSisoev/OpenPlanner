import * as vscode from "vscode";
import * as path from "path";
import { newTraceId, traceEvent, traceMultiline } from "../debug/trace";
import { logLine, showOutput } from "../log";
import { AgentCliError, AgentRunBusyError, runAgentPrint, runExternalCli } from "./agentCliRunner";
import { resolveDefaultAgentExecutable } from "./agentPath";
import { buildAgentEnv, resolveCursorApiKey } from "./cursorApiKey";
import { getActiveExecutorProfileId, getJunieExecutable } from "./executorConfig";
import { buildJunieCliArgs } from "./junieCliArgs";
import { buildJunieCliEnv, resolveJunieApiKey } from "./junieApiKey";

function firstPathEntries(env: NodeJS.ProcessEnv, maxEntries = 5): string {
  const raw = env.PATH ?? "";
  if (!raw) {
    return "(empty)";
  }
  return raw.split(path.delimiter).filter(Boolean).slice(0, maxEntries).join(" ; ");
}

/**
 * End-to-end smoke test for the Extension Host -> Cursor CLI bridge used by
 * Chat/Create-plan and CLI phase execution paths.
 */
export async function debugCliConnection(context: vscode.ExtensionContext): Promise<void> {
  const tid = newTraceId("debugCli");
  traceEvent(tid, "debugCli.enter", {});
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    traceEvent(tid, "debugCli.skip", { reason: "no_workspace" });
    await vscode.window.showErrorMessage("Planstack: open a workspace folder before running CLI diagnostics.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const agentPath = cfg.get<string>("agentPath")?.trim() || "agent";
  const timeoutMs = Math.min(cfg.get<number>("agentTimeoutMs") ?? 180_000, 30_000);
  const maxStdoutChars = Math.min(cfg.get<number>("agentMaxStdoutChars") ?? 2_000_000, 20_000);
  const cwd = folder.uri.fsPath;
  const useWsl = cfg.get<boolean>("useWsl") ?? false;
  const wslDistro = cfg.get<string>("wslDistro")?.trim() || "Ubuntu";
  const profile = getActiveExecutorProfileId();

  logLine(`debug-cli: start cwd=${cwd} activeProfile=${profile}`);

  const prompt = "Reply with exactly OK.";
  traceMultiline(tid, "debugCli.prompt", prompt);
  try {
    let stdout: string;
    let stderr: string;
    let exitCode: number | null;

    if (profile === "junie-cli") {
      const juniePath = getJunieExecutable();
      const resolvedJunie = useWsl ? juniePath : resolveDefaultAgentExecutable(juniePath);
      const env = await buildJunieCliEnv(context);
      const jKey = await resolveJunieApiKey(context);
      logLine(`debug-cli: juniePath="${juniePath}" resolved="${resolvedJunie}"`);
      logLine(`debug-cli: JUNIE_API_KEY present=${jKey ? "yes" : "no"}`);
      logLine(`debug-cli: PATH(first entries) ${firstPathEntries(env)}`);
      if (!jKey) {
        traceEvent(tid, "debugCli.skip", { reason: "no_junie_api_key" });
        showOutput();
        await vscode.window.showErrorMessage(
          "Planstack: Junie token missing (run “Planstack: Set Junie API token”). See Output → Planstack for diagnostics.",
        );
        return;
      }
      const args = buildJunieCliArgs({
        cwd,
        authToken: jKey,
        timeoutMs,
        task: prompt,
      });
      const r = await runExternalCli({
        executable: resolvedJunie,
        args,
        cwd,
        env,
        timeoutMs,
        maxStdoutChars,
        debugTraceId: tid,
        useWsl,
        wslDistro,
        wslPassThroughKeys: ["JUNIE_API_KEY"],
      });
      stdout = r.stdout;
      stderr = r.stderr;
      exitCode = r.exitCode;
    } else {
      const env = await buildAgentEnv(context);
      const apiKey = await resolveCursorApiKey(context);
      const resolvedAgent = useWsl ? agentPath : resolveDefaultAgentExecutable(agentPath);
      logLine(`debug-cli: configured agentPath="${agentPath}" resolved="${resolvedAgent}"`);
      if (/(^|[\\/])cursor(\.cmd|\.exe)?$/i.test(resolvedAgent)) {
        logLine("debug-cli: resolved executable is Cursor CLI; will invoke `cursor agent -p ...`.");
      }
      logLine(`debug-cli: CURSOR_API_KEY present=${apiKey ? "yes" : "no"}`);
      logLine(`debug-cli: PATH(first entries) ${firstPathEntries(env)}`);
      if (!apiKey) {
        traceEvent(tid, "debugCli.skip", { reason: "no_api_key" });
        showOutput();
        await vscode.window.showErrorMessage(
          "Planstack: CURSOR_API_KEY is missing (run “Planstack: Set Cursor API key”). See Output → Planstack for diagnostics.",
        );
        return;
      }
      const r = await runAgentPrint({
        agentPath: resolvedAgent,
        cwd,
        prompt,
        env,
        timeoutMs,
        maxStdoutChars,
        debugTraceId: tid,
        useWsl,
        wslDistro,
      });
      stdout = r.stdout;
      stderr = r.stderr;
      exitCode = r.exitCode;
    }

    const out = stdout.trim();
    const err = stderr.trim();
    logLine(`debug-cli: exitCode=${String(exitCode)}`);
    if (err) {
      logLine(`debug-cli: stderr tail=${err.slice(-500)}`);
    }
    if (out) {
      logLine(`debug-cli: stdout tail=${out.slice(-500)}`);
    }

    if (exitCode !== 0) {
      traceEvent(tid, "debugCli.exit", { ok: false, exitCode });
      showOutput();
      await vscode.window.showErrorMessage(
        `Planstack: CLI diagnostic failed (exit ${exitCode}). See Output → Planstack for stderr/stdout tails.`,
      );
      return;
    }

    const ok = /\bOK\b/.test(out);
    if (!ok) {
      traceEvent(tid, "debugCli.exit", { ok: false, reason: "missing_ok_token", stdoutChars: out.length });
      logLine("debug-cli: command succeeded but expected token 'OK' not found in stdout.");
      showOutput();
      await vscode.window.showWarningMessage(
        "Planstack: CLI reached successfully, but smoke response did not include OK. See Output → Planstack.",
      );
      return;
    }

    traceEvent(tid, "debugCli.exit", { ok: true, stdoutChars: out.length });
    await vscode.window.showInformationMessage(
      profile === "junie-cli"
        ? "Planstack: Junie CLI bridge healthy (reachable from Extension Host)."
        : "Planstack: CLI bridge healthy (agent reachable from Extension Host).",
    );
  } catch (e) {
    if (e instanceof AgentRunBusyError) {
      traceEvent(tid, "debugCli.catch", { kind: "AgentRunBusyError", message: e.message });
      showOutput();
      await vscode.window.showWarningMessage(
        `Planstack: ${e.message}`,
      );
      return;
    }
    const msg = e instanceof AgentCliError ? e.message : e instanceof Error ? e.message : String(e);
    traceEvent(tid, "debugCli.catch", { kind: e instanceof AgentCliError ? "AgentCliError" : "Error", message: msg });
    logLine(`debug-cli: exception ${msg}`);
    showOutput();
    await vscode.window.showErrorMessage(
      `Planstack: CLI diagnostic error: ${msg.slice(0, 500)}. See Output → Planstack for details.`,
    );
  }
}
