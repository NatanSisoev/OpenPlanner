/** Push one-line status updates into Planstack Chat when the view is open (e.g. Run phase CLI). */

type SystemSink = (text: string) => void;

let sink: SystemSink | undefined;

export function registerChatSystemSink(fn: SystemSink | undefined): void {
  sink = fn;
}

export function postChatSystemMessage(text: string): void {
  const line = text.trim();
  if (!line) {
    return;
  }
  sink?.(line);
}
