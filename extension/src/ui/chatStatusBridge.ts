/** Push one-line status updates into Planstack Chat when the view is open (e.g. Run phase CLI). */

type SystemSink = (text: string) => void;
type UserSink = (text: string) => void;

let sink: SystemSink | undefined;
let userSink: UserSink | undefined;

const pendingLines: string[] = [];
const MAX_PENDING_LINES = 200;
const pendingUserLines: string[] = [];
const MAX_PENDING_USER_LINES = 100;

export function registerChatSystemSink(fn: SystemSink | undefined): void {
  sink = fn;
  if (fn && pendingLines.length > 0) {
    for (const line of pendingLines) {
      fn(line);
    }
    pendingLines.length = 0;
  }
}

export function registerChatUserSink(fn: UserSink | undefined): void {
  userSink = fn;
  if (fn && pendingUserLines.length > 0) {
    for (const line of pendingUserLines) {
      fn(line);
    }
    pendingUserLines.length = 0;
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

export function postChatUserMessage(text: string): void {
  const line = text.trim();
  if (!line) {
    return;
  }
  if (userSink) {
    userSink(line);
  } else {
    if (pendingUserLines.length >= MAX_PENDING_USER_LINES) {
      pendingUserLines.shift();
    }
    pendingUserLines.push(line);
  }
}
