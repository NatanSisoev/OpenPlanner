import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

/** Lazily-created shared OutputChannel ("Planstack") for diagnostic logging. */
export function getOutput(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Planstack");
  return channel;
}

/** Append a single line, prefixed with an ISO timestamp. */
export function logLine(line: string): void {
  getOutput().appendLine(`[${new Date().toISOString()}] ${line}`);
}

/** Bring the Output panel forward (passive — does not steal focus). */
export function showOutput(): void {
  getOutput().show(true);
}
