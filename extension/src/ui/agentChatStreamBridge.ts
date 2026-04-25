/** Live agent stdout/stderr into the Planstack Chat webview (separate from one-line system status). */

export type AgentStreamSource = "runPhase" | "createPlan";

export type AgentStreamEndReason = "complete" | "error" | "stopped";

export interface AgentStreamMeta {
  label: string;
  source: AgentStreamSource;
  /** Shown inside the stream `<pre>` immediately (CLI may buffer for a long time). */
  initialLine?: string;
}

export interface AgentStreamSink {
  onStart(runId: string, meta: AgentStreamMeta): void;
  onChunk(runId: string, stream: "stdout" | "stderr", text: string): void;
  onEnd(runId: string, reason: AgentStreamEndReason): void;
}

let sink: AgentStreamSink | undefined;

const COALESCE_MS = 8;

type PendingBuf = { out: string; err: string; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, PendingBuf>();

export function registerAgentStreamSink(s: AgentStreamSink | undefined): void {
  sink = s;
}

function flushPending(runId: string): void {
  const b = pending.get(runId);
  if (!b) {
    return;
  }
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = undefined;
  }
  pending.delete(runId);
  const s = sink;
  if (!s) {
    return;
  }
  if (b.out) {
    s.onChunk(runId, "stdout", b.out);
  }
  if (b.err) {
    s.onChunk(runId, "stderr", b.err);
  }
}

function scheduleChunk(runId: string, stream: "stdout" | "stderr", text: string): void {
  if (!text || !sink) {
    return;
  }
  let b = pending.get(runId);
  if (!b) {
    b = { out: "", err: "" };
    pending.set(runId, b);
  }
  if (stream === "stdout") {
    b.out += text;
  } else {
    b.err += text;
  }
  if (b.timer) {
    clearTimeout(b.timer);
  }
  b.timer = setTimeout(() => {
    const cur = pending.get(runId);
    if (cur?.timer) {
      cur.timer = undefined;
    }
    flushPending(runId);
  }, COALESCE_MS);
}

/** Call before first chunk. */
export function postAgentStreamStart(runId: string, meta: AgentStreamMeta): void {
  flushPending(runId);
  sink?.onStart(runId, meta);
}

export function postAgentStreamChunk(runId: string, stream: "stdout" | "stderr", text: string): void {
  scheduleChunk(runId, stream, text);
}

/** Flush coalesced bytes then notify end. */
export function postAgentStreamEnd(runId: string, reason: AgentStreamEndReason): void {
  flushPending(runId);
  sink?.onEnd(runId, reason);
}
