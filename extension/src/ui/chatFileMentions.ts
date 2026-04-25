import * as vscode from "vscode";

export interface ChatMentionSettings {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalChars: number;
}

export interface ResolvedMentionFile {
  mention: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

export interface ChatMentionError {
  mention: string;
  reason: string;
}

export interface ResolvedMentionContext {
  originalPrompt: string;
  promptForAgent: string;
  files: ResolvedMentionFile[];
  errors: ChatMentionError[];
}

const DEFAULT_SETTINGS: ChatMentionSettings = {
  maxFiles: 6,
  maxFileBytes: 64 * 1024,
  maxTotalChars: 120_000,
};

const MENTION_PATH_RE = /(^|[\s(])@([A-Za-z0-9._\-\/]+)/g;

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function hasNullByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

function sanitizeForFence(text: string): string {
  return text.replace(/```/g, "``\\`");
}

function isLikelySecret(pathLower: string): boolean {
  if (pathLower.endsWith(".env")) {
    return true;
  }
  if (pathLower.endsWith(".pem") || pathLower.endsWith(".key") || pathLower.endsWith(".p12")) {
    return true;
  }
  if (pathLower.endsWith("/id_rsa") || pathLower.endsWith("/id_ed25519")) {
    return true;
  }
  if (pathLower.endsWith("credentials.json")) {
    return true;
  }
  return false;
}

function extractMentionPaths(prompt: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATH_RE.exec(prompt)) !== null) {
    const p = normalizeRelPath(match[2] ?? "");
    if (!p || seen.has(p)) {
      continue;
    }
    seen.add(p);
    paths.push(p);
  }
  return paths;
}

function buildPromptWithFiles(originalPrompt: string, files: ResolvedMentionFile[]): string {
  if (files.length === 0) {
    return originalPrompt;
  }
  const sections = files.map((file) => {
    const trunc = file.truncated ? "\n[Truncated to mention limits]\n" : "\n";
    return [
      `File: ${file.displayPath}`,
      "```text",
      `${sanitizeForFence(file.content)}${trunc}`.trimEnd(),
      "```",
    ].join("\n");
  });
  return [
    originalPrompt,
    "",
    "Attached file context from @ mentions:",
    ...sections,
    "",
    "Use the file context above as read-only reference unless asked to modify those files.",
  ].join("\n");
}

export function getChatMentionSettings(): ChatMentionSettings {
  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const maxFiles = cfg.get<number>("chatMentionsMaxFiles") ?? DEFAULT_SETTINGS.maxFiles;
  const maxFileBytes = cfg.get<number>("chatMentionsMaxFileBytes") ?? DEFAULT_SETTINGS.maxFileBytes;
  const maxTotalChars = cfg.get<number>("chatMentionsMaxTotalChars") ?? DEFAULT_SETTINGS.maxTotalChars;
  return {
    maxFiles: Math.max(1, Math.min(32, Math.floor(maxFiles))),
    maxFileBytes: Math.max(1024, Math.min(2 * 1024 * 1024, Math.floor(maxFileBytes))),
    maxTotalChars: Math.max(2_000, Math.min(2_000_000, Math.floor(maxTotalChars))),
  };
}

export async function buildPromptWithMentionedFiles(
  workspaceRoot: vscode.Uri,
  originalPrompt: string,
  settings: ChatMentionSettings = getChatMentionSettings(),
): Promise<ResolvedMentionContext> {
  const mentionPaths = extractMentionPaths(originalPrompt);
  if (mentionPaths.length === 0) {
    return { originalPrompt, promptForAgent: originalPrompt, files: [], errors: [] };
  }

  const files: ResolvedMentionFile[] = [];
  const errors: ChatMentionError[] = [];
  let totalChars = 0;
  let fileCount = 0;

  for (const mentionPath of mentionPaths) {
    if (fileCount >= settings.maxFiles) {
      errors.push({
        mention: mentionPath,
        reason: `ignored because max mentions per message is ${settings.maxFiles}`,
      });
      continue;
    }
    if (mentionPath.includes("..")) {
      errors.push({ mention: mentionPath, reason: "relative parent segments (..) are not allowed" });
      continue;
    }
    const pathLower = mentionPath.toLowerCase();
    if (isLikelySecret(pathLower)) {
      errors.push({ mention: mentionPath, reason: "blocked because it looks like a secret file" });
      continue;
    }
    const targetUri = vscode.Uri.joinPath(workspaceRoot, ...mentionPath.split("/"));
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(targetUri);
    } catch {
      errors.push({ mention: mentionPath, reason: "file not found in workspace" });
      continue;
    }
    if (stat.type !== vscode.FileType.File) {
      errors.push({ mention: mentionPath, reason: "path is not a file" });
      continue;
    }
    if (stat.size > settings.maxFileBytes) {
      errors.push({
        mention: mentionPath,
        reason: `file too large (${stat.size} bytes > ${settings.maxFileBytes} bytes limit)`,
      });
      continue;
    }
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(targetUri);
    } catch {
      errors.push({ mention: mentionPath, reason: "failed to read file" });
      continue;
    }
    if (hasNullByte(raw)) {
      errors.push({ mention: mentionPath, reason: "binary-like file blocked" });
      continue;
    }
    let text = decodeUtf8(raw);
    let truncated = false;
    if (totalChars + text.length > settings.maxTotalChars) {
      const remaining = Math.max(0, settings.maxTotalChars - totalChars);
      text = text.slice(0, remaining);
      truncated = true;
    }
    if (!text) {
      errors.push({ mention: mentionPath, reason: "no room left in total mention context budget" });
      continue;
    }
    files.push({
      mention: mentionPath,
      displayPath: mentionPath,
      content: text,
      truncated,
    });
    totalChars += text.length;
    fileCount += 1;
    if (totalChars >= settings.maxTotalChars) {
      break;
    }
  }

  return {
    originalPrompt,
    promptForAgent: buildPromptWithFiles(originalPrompt, files),
    files,
    errors,
  };
}

function scoreCandidate(path: string, query: string): number {
  if (!query) {
    return 0;
  }
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (p === q) {
    return 1_000_000;
  }
  if (p.endsWith(`/${q}`)) {
    return 900_000;
  }
  const i = p.indexOf(q);
  if (i >= 0) {
    return 600_000 - i;
  }
  let qPos = 0;
  let gapPenalty = 0;
  for (let i2 = 0; i2 < p.length && qPos < q.length; i2 += 1) {
    if (p[i2] === q[qPos]) {
      qPos += 1;
      continue;
    }
    gapPenalty += 1;
  }
  if (qPos === q.length) {
    return 150_000 - gapPenalty;
  }
  return Number.NEGATIVE_INFINITY;
}

export interface MentionCandidateOptions {
  query: string;
  limit?: number;
}

export async function findMentionCandidates(
  workspaceRoot: vscode.Uri,
  options: MentionCandidateOptions,
): Promise<string[]> {
  const query = normalizeRelPath(options.query.trim());
  const limit = Math.max(1, Math.min(100, options.limit ?? 12));
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, "**/*"),
    "**/{node_modules,.git,dist,out,.next,build,.planstack}/**",
    3000,
  );
  const relPaths = files
    .map((uri) => normalizeRelPath(vscode.workspace.asRelativePath(uri, false)))
    .filter((p) => p.length > 0 && !isLikelySecret(p.toLowerCase()));
  relPaths.sort((a, b) => {
    const sa = scoreCandidate(a, query);
    const sb = scoreCandidate(b, query);
    if (sa !== sb) {
      return sb - sa;
    }
    return a.localeCompare(b);
  });
  return relPaths.slice(0, limit);
}
