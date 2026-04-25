import { randomBytes } from "crypto";
import { logLine } from "../log";

/** Correlation id for grep-friendly Output → Planstack traces. */
export function newTraceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function traceEvent(traceId: string, event: string, payload: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = String(payload);
  }
  logLine(`trace[${traceId}] ${event} ${body}`);
}

/** Log full multiline text with BEGIN/END markers (e.g. prompts). */
export function traceMultiline(traceId: string, label: string, text: string): void {
  logLine(`trace[${traceId}] ${label} BEGIN`);
  for (const line of text.split("\n")) {
    logLine(`trace[${traceId}] ${label} | ${line}`);
  }
  logLine(`trace[${traceId}] ${label} END`);
}
