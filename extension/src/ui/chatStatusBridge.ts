/** Push one-line status updates into Planstack Chat when the view is open (e.g. Run phase CLI). */

type SystemSink = (text: string) => void;

let sink: SystemSink | undefined;

const pendingLines: string[] = [];
const MAX_PENDING_LINES = 200;

export function registerChatSystemSink(fn: SystemSink | undefined): void {
  sink = fn;
  if (fn && pendingLines.length > 0) {
    for (const line of pendingLines) {
      fn(line);
    }
    pendingLines.length = 0;
  }
}

export function postChatSystemMessage(text: string): void {
  const line = text.trim();
  if (!line) {
    return;
  }
  if (sink) {
    sink(line);
  } else {
    if (pendingLines.length >= MAX_PENDING_LINES) {
      pendingLines.shift();
    }
    pendingLines.push(line);
  }
}
