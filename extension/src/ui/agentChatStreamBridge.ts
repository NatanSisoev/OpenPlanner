/** Live agent stdout/stderr into the Planstack Chat webview (separate from one-line system status). */

export type AgentStreamSource = "runPhase" | "runTask" | "createPlan" | "sendPrompt";

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

/** When Chat has not been opened yet, hold stream data until a sink registers (then replay). */
type ReplayBuf = {
  meta: AgentStreamMeta;
  out: string;
  err: string;
  ended?: AgentStreamEndReason;
};
const replayRuns = new Map<string, ReplayBuf>();
const MAX_REPLAY_RUNS = 6;
const MAX_REPLAY_CHARS_PER_RUN = 120_000;

const COALESCE_MS = 8;

type PendingBuf = { out: string; err: string; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, PendingBuf>();

function replayBufferedTo(s: AgentStreamSink): void {
  for (const [runId, rb] of replayRuns) {
    s.onStart(runId, rb.meta);
    if (rb.out) {
      s.onChunk(runId, "stdout", rb.out);
    }
    if (rb.err) {
      s.onChunk(runId, "stderr", rb.err);
    }
    if (rb.ended !== undefined) {
      s.onEnd(runId, rb.ended);
    }
  }
  replayRuns.clear();
}

function appendBounded(prev: string, add: string): string {
  const next = prev + add;
  if (next.length <= MAX_REPLAY_CHARS_PER_RUN) {
    return next;
  }
  return next.slice(-MAX_REPLAY_CHARS_PER_RUN);
}

function enforceReplayRunCap(): void {
  while (replayRuns.size > MAX_REPLAY_RUNS) {
    const oldest = replayRuns.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    replayRuns.delete(oldest);
  }
}

export function registerAgentStreamSink(s: AgentStreamSink | undefined): void {
  sink = s;
  if (s) {
    replayBufferedTo(s);
  }
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
  if (s) {
    if (b.out) {
      s.onChunk(runId, "stdout", b.out);
    }
    if (b.err) {
      s.onChunk(runId, "stderr", b.err);
    }
  } else {
    const rb = replayRuns.get(runId);
    if (rb) {
      rb.out = appendBounded(rb.out, b.out);
      rb.err = appendBounded(rb.err, b.err);
    }
  }
}

function scheduleChunk(runId: string, stream: "stdout" | "stderr", text: string): void {
  if (!text) {
    return;
  }
  if (!sink) {
    const rb = replayRuns.get(runId);
    if (rb) {
      if (stream === "stdout") {
        rb.out = appendBounded(rb.out, text);
      } else {
        rb.err = appendBounded(rb.err, text);
      }
    }
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
  if (sink) {
    sink.onStart(runId, meta);
  } else {
    replayRuns.set(runId, { meta, out: "", err: "" });
    enforceReplayRunCap();
  }
}

export function postAgentStreamChunk(runId: string, stream: "stdout" | "stderr", text: string): void {
  scheduleChunk(runId, stream, text);
}

/** Flush coalesced bytes then notify end. */
export function postAgentStreamEnd(runId: string, reason: AgentStreamEndReason): void {
  flushPending(runId);
  if (sink) {
    sink.onEnd(runId, reason);
  } else {
    const rb = replayRuns.get(runId);
    if (rb) {
      rb.ended = reason;
    }
  }
}
