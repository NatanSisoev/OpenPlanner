import * as vscode from "vscode";
import type { Phase, Plan, Task, WorkState } from "../plan/types";
import { validatePlanJson } from "../plan/validate";

/** Build / vendor dirs excluded from workspace-wide @ file discovery; plan JSON under `.planstack/plans/` is always merged in separately. */
const MENTION_FIND_FILES_EXCLUDE = "**/{node_modules,.git,dist,out,.next,build}/**";

export type MentionKind = "file" | "folder" | "plan" | "phase" | "task" | "symbol";

export interface ChatMentionSettings {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalChars: number;
  maxEntities: number;
  maxSymbols: number;
  maxSymbolChars: number;
}

export interface ResolvedMentionFile {
  mention: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

export interface ResolvedMentionFolder {
  mention: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

/** Resolved @plan:… mention (summary for the agent, not the full Plan JSON type). */
export interface ResolvedMentionPlan {
  raw: string;
  planId: string;
  title: string;
  description: string;
  state: WorkState;
  phaseCount: number;
  phaseOutline: string;
  gitSummary?: string;
}

export interface ResolvedMentionPhase {
  raw: string;
  planId: string;
  phaseId: string;
  title: string;
  description: string;
  state: WorkState;
  dependsOn: string[];
  taskCount: number;
}

export interface ResolvedMentionTask {
  raw: string;
  planId: string;
  phaseId: string;
  taskId: string;
  desc: string;
  prompt?: string;
  state: WorkState;
  commit: boolean;
}

export interface ResolvedMentionSymbol {
  raw: string;
  name: string;
  kindLabel: string;
  filePath: string;
  startLine: number;
  endLine: number;
  containerName?: string;
  language: string;
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
  folders: ResolvedMentionFolder[];
  plans: ResolvedMentionPlan[];
  phases: ResolvedMentionPhase[];
  tasks: ResolvedMentionTask[];
  symbols: ResolvedMentionSymbol[];
  errors: ChatMentionError[];
}

export interface ParsedMention {
  kind: MentionKind;
  raw: string;
  filePath?: string;
  planId?: string;
  phaseId?: string;
  taskId?: string;
  symbolName?: string;
  filePathHint?: string;
  lineHint?: number;
}

export interface MentionSuggestion {
  kind: MentionKind;
  /** Text to insert after the leading `@` (e.g. `phase:planId/phaseId`). */
  insertText: string;
  /** Primary label rendered in the suggestion list. */
  label: string;
  /** Optional secondary text (title / description / state). */
  detail?: string;
}

const DEFAULT_SETTINGS: ChatMentionSettings = {
  maxFiles: 6,
  maxFileBytes: 64 * 1024,
  maxTotalChars: 120_000,
  maxEntities: 12,
  maxSymbols: 6,
  maxSymbolChars: 16_000,
};

/**
 * Regex captures one of:
 *  - `@symbol:Name(@filePathHint(:lineHint)?)?` (groups 2,3,4)
 *  - `@phase:body` / `@task:body` / `@folder:body` / `@plan:body` (groups 5,6)
 *  - `@bareFilePath` (group 7)
 */
const MENTION_RE =
  /(^|[\s(])@(?:symbol:([A-Za-z0-9_$.]+)(?:@([A-Za-z0-9._\-\/]+))?(?::(\d+))?|(phase|task|folder|plan):([A-Za-z0-9._\-\/]+)|([A-Za-z0-9._\-\/]+))/g;

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

export function parseMentions(prompt: string): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(prompt)) !== null) {
    const symbolName = match[2];
    const symbolFile = match[3];
    const symbolLine = match[4];
    const entityKind = match[5] as "phase" | "task" | "folder" | "plan" | undefined;
    const entityBody = match[6];
    const fileBody = match[7];

    if (symbolName) {
      const filePathHint = symbolFile ? normalizeRelPath(symbolFile) : undefined;
      const lineHint = symbolLine ? parseInt(symbolLine, 10) : undefined;
      let raw = `symbol:${symbolName}`;
      if (filePathHint) {
        raw += `@${filePathHint}`;
        if (lineHint !== undefined && Number.isFinite(lineHint)) {
          raw += `:${lineHint}`;
        }
      }
      if (seen.has(raw)) {
        continue;
      }
      seen.add(raw);
      out.push({
        kind: "symbol",
        raw,
        symbolName,
        filePathHint,
        lineHint: lineHint !== undefined && Number.isFinite(lineHint) ? lineHint : undefined,
      });
      continue;
    }

    if (entityKind && entityBody) {
      const body = normalizeRelPath(entityBody);
      if (!body) {
        continue;
      }
      const raw = `${entityKind}:${body}`;
      if (seen.has(raw)) {
        continue;
      }
      const parts = body.split("/").filter(Boolean);
      seen.add(raw);
      if (entityKind === "phase") {
        if (parts.length === 2) {
          out.push({ kind: "phase", raw, planId: parts[0], phaseId: parts[1] });
        } else {
          out.push({ kind: "phase", raw });
        }
      } else if (entityKind === "task") {
        if (parts.length === 3) {
          out.push({
            kind: "task",
            raw,
            planId: parts[0],
            phaseId: parts[1],
            taskId: parts[2],
          });
        } else {
          out.push({ kind: "task", raw });
        }
      } else if (entityKind === "plan") {
        out.push({ kind: "plan", raw, planId: body });
      } else {
        out.push({ kind: "folder", raw, filePath: body });
      }
      continue;
    }

    if (fileBody) {
      const body = normalizeRelPath(fileBody);
      if (!body || seen.has(body)) {
        continue;
      }
      seen.add(body);
      out.push({ kind: "file", raw: body, filePath: body });
    }
  }
  return out;
}

function buildPromptSections(
  files: ResolvedMentionFile[],
  folders: ResolvedMentionFolder[],
  plans: ResolvedMentionPlan[],
  phases: ResolvedMentionPhase[],
  tasks: ResolvedMentionTask[],
  symbols: ResolvedMentionSymbol[],
): string[] {
  const sections: string[] = [];
  for (const file of files) {
    const trunc = file.truncated ? "\n[Truncated to mention limits]\n" : "\n";
    sections.push(
      [
        `File: ${file.displayPath}`,
        "```text",
        `${sanitizeForFence(file.content)}${trunc}`.trimEnd(),
        "```",
      ].join("\n"),
    );
  }
  for (const folder of folders) {
    const trunc = folder.truncated ? "\n[Truncated to mention limits]\n" : "\n";
    sections.push(
      [
        `Folder: ${folder.displayPath}/`,
        "```text",
        `${sanitizeForFence(folder.content)}${trunc}`.trimEnd(),
        "```",
      ].join("\n"),
    );
  }
  for (const plan of plans) {
    const lines = [
      `Plan: ${plan.title} (id: ${plan.planId})`,
      `State: ${plan.state}`,
    ];
    if (plan.description) {
      lines.push(`Description: ${plan.description}`);
    }
    if (plan.gitSummary) {
      lines.push(`Git: ${plan.gitSummary}`);
    }
    lines.push(`Phases (${plan.phaseCount}):`);
    lines.push(plan.phaseOutline);
    sections.push(lines.join("\n"));
  }
  for (const phase of phases) {
    const lines = [
      `Phase: ${phase.title} (id: ${phase.phaseId}, plan: ${phase.planId})`,
      `State: ${phase.state}`,
    ];
    if (phase.description) {
      lines.push(`Description: ${phase.description}`);
    }
    if (phase.dependsOn.length > 0) {
      lines.push(`Depends on: ${phase.dependsOn.join(", ")}`);
    }
    lines.push(`Tasks: ${phase.taskCount}`);
    sections.push(lines.join("\n"));
  }
  for (const task of tasks) {
    const lines = [
      `Task: ${task.desc} (id: ${task.taskId}, phase: ${task.phaseId}, plan: ${task.planId})`,
      `State: ${task.state}`,
      `Commit: ${task.commit ? "yes" : "no"}`,
    ];
    if (task.prompt) {
      lines.push(`Prompt: ${task.prompt}`);
    }
    sections.push(lines.join("\n"));
  }
  for (const symbol of symbols) {
    const trunc = symbol.truncated ? "\n[Truncated to mention limits]\n" : "\n";
    const containerSuffix = symbol.containerName ? ` (in ${symbol.containerName})` : "";
    const header =
      `Symbol: ${symbol.name} [${symbol.kindLabel}]${containerSuffix} - ` +
      `${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`;
    sections.push(
      [
        header,
        "```" + symbol.language,
        `${sanitizeForFence(symbol.content)}${trunc}`.trimEnd(),
        "```",
      ].join("\n"),
    );
  }
  return sections;
}

function buildExpandedPrompt(
  originalPrompt: string,
  files: ResolvedMentionFile[],
  folders: ResolvedMentionFolder[],
  plans: ResolvedMentionPlan[],
  phases: ResolvedMentionPhase[],
  tasks: ResolvedMentionTask[],
  symbols: ResolvedMentionSymbol[],
): string {
  const sections = buildPromptSections(files, folders, plans, phases, tasks, symbols);
  if (sections.length === 0) {
    return originalPrompt;
  }
  return [
    originalPrompt,
    "",
    "Attached context from @ mentions:",
    ...sections,
    "",
    "Use the context above as read-only reference unless asked to modify those entities.",
  ].join("\n");
}

export function getChatMentionSettings(): ChatMentionSettings {
  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const maxFiles = cfg.get<number>("chatMentionsMaxFiles") ?? DEFAULT_SETTINGS.maxFiles;
  const maxFileBytes = cfg.get<number>("chatMentionsMaxFileBytes") ?? DEFAULT_SETTINGS.maxFileBytes;
  const maxTotalChars = cfg.get<number>("chatMentionsMaxTotalChars") ?? DEFAULT_SETTINGS.maxTotalChars;
  const maxEntities = cfg.get<number>("chatMentionsMaxEntities") ?? DEFAULT_SETTINGS.maxEntities;
  const maxSymbols = cfg.get<number>("chatMentionsMaxSymbols") ?? DEFAULT_SETTINGS.maxSymbols;
  const maxSymbolChars = cfg.get<number>("chatMentionsMaxSymbolChars") ?? DEFAULT_SETTINGS.maxSymbolChars;
  return {
    maxFiles: Math.max(1, Math.min(32, Math.floor(maxFiles))),
    maxFileBytes: Math.max(1024, Math.min(2 * 1024 * 1024, Math.floor(maxFileBytes))),
    maxTotalChars: Math.max(2_000, Math.min(2_000_000, Math.floor(maxTotalChars))),
    maxEntities: Math.max(1, Math.min(64, Math.floor(maxEntities))),
    maxSymbols: Math.max(1, Math.min(32, Math.floor(maxSymbols))),
    maxSymbolChars: Math.max(1_024, Math.min(200_000, Math.floor(maxSymbolChars))),
  };
}

function describePhase(phase: Phase): string {
  if (phase.description?.trim()) {
    return phase.description.trim();
  }
  return phase.title;
}

function describeTask(task: Task): string {
  return task.desc;
}

function describePlan(plan: Plan): string {
  if (plan.description?.trim()) {
    return plan.description.trim();
  }
  return plan.title;
}

function gitLineForPlan(plan: Plan): string | undefined {
  const g = plan.git;
  if (!g) {
    return undefined;
  }
  const parts: string[] = [];
  if (g.baseBranch) {
    parts.push(`base ${g.baseBranch}`);
  }
  if (g.planBranch) {
    parts.push(`plan branch ${g.planBranch}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

const PLAN_PHASE_OUTLINE_MAX = 40;

function buildPlanPhaseOutline(plan: Plan): string {
  const lines: string[] = [];
  let i = 0;
  for (const ph of plan.phases) {
    if (i >= PLAN_PHASE_OUTLINE_MAX) {
      lines.push(`… and ${plan.phases.length - PLAN_PHASE_OUTLINE_MAX} more phase(s)`);
      break;
    }
    lines.push(`- ${ph.id}: ${ph.title} [${ph.state}] (${ph.tasks.length} task(s))`);
    i += 1;
  }
  return lines.length > 0 ? lines.join("\n") : "(no phases)";
}

async function loadMentionPlansFromWorkspace(): Promise<Plan[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  const out: Plan[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/.planstack/plans/*.json"),
      MENTION_FIND_FILES_EXCLUDE,
      600,
    );
    for (const uri of uris) {
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const parsed: unknown = JSON.parse(decodeUtf8(raw));
        const plan = validatePlanJson(parsed);
        if (seen.has(plan.id)) {
          continue;
        }
        seen.add(plan.id);
        out.push(plan);
      } catch {
        // Ignore malformed/unreadable plan files in mention suggestions.
      }
    }
  }
  return out;
}

function symbolKindLabel(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.Class:
      return "class";
    case vscode.SymbolKind.Method:
      return "method";
    case vscode.SymbolKind.Function:
      return "function";
    case vscode.SymbolKind.Constructor:
      return "constructor";
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.Enum:
      return "enum";
    case vscode.SymbolKind.EnumMember:
      return "enum-member";
    case vscode.SymbolKind.Namespace:
      return "namespace";
    case vscode.SymbolKind.Module:
      return "module";
    case vscode.SymbolKind.Property:
      return "property";
    case vscode.SymbolKind.Field:
      return "field";
    case vscode.SymbolKind.Variable:
      return "variable";
    case vscode.SymbolKind.Constant:
      return "constant";
    case vscode.SymbolKind.Struct:
      return "struct";
    case vscode.SymbolKind.TypeParameter:
      return "type";
    default:
      return "symbol";
  }
}

const SYMBOL_KIND_ALLOW = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.TypeParameter,
]);

function fenceLanguageForFile(relPath: string): string {
  const ext = relPath.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cc: "cpp",
    cs: "csharp",
    php: "php",
    lua: "lua",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    toml: "toml",
  };
  return map[ext] ?? "text";
}

async function executeWorkspaceSymbolsRaced(query: string): Promise<vscode.SymbolInformation[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const symbolsPromise = Promise.resolve(
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query,
      ),
    ).catch(() => [] as vscode.SymbolInformation[]);
    const timeoutPromise = new Promise<vscode.SymbolInformation[]>((resolve) => {
      timer = setTimeout(() => resolve([]), 600);
    });
    const result = await Promise.race([symbolsPromise, timeoutPromise]);
    return Array.isArray(result) ? result : [];
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function symbolRelPath(symbol: vscode.SymbolInformation): string {
  return normalizeRelPath(vscode.workspace.asRelativePath(symbol.location.uri, false));
}

async function resolveFileMention(
  workspaceRoot: vscode.Uri,
  mention: string,
  budget: { remainingChars: number },
  settings: ChatMentionSettings,
): Promise<{ file?: ResolvedMentionFile; error?: ChatMentionError }> {
  if (mention.includes("..")) {
    return { error: { mention, reason: "relative parent segments (..) are not allowed" } };
  }
  const pathLower = mention.toLowerCase();
  if (isLikelySecret(pathLower)) {
    return { error: { mention, reason: "blocked because it looks like a secret file" } };
  }
  const targetUri = vscode.Uri.joinPath(workspaceRoot, ...mention.split("/"));
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(targetUri);
  } catch {
    return { error: { mention, reason: "file not found in workspace" } };
  }
  if (stat.type !== vscode.FileType.File) {
    return { error: { mention, reason: "path is not a file" } };
  }
  if (stat.size > settings.maxFileBytes) {
    return {
      error: {
        mention,
        reason: `file too large (${stat.size} bytes > ${settings.maxFileBytes} bytes limit)`,
      },
    };
  }
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(targetUri);
  } catch {
    return { error: { mention, reason: "failed to read file" } };
  }
  if (hasNullByte(raw)) {
    return { error: { mention, reason: "binary-like file blocked" } };
  }
  let text = decodeUtf8(raw);
  let truncated = false;
  if (text.length > budget.remainingChars) {
    text = text.slice(0, Math.max(0, budget.remainingChars));
    truncated = true;
  }
  if (!text) {
    return { error: { mention, reason: "no room left in total mention context budget" } };
  }
  budget.remainingChars -= text.length;
  return {
    file: {
      mention,
      displayPath: mention,
      content: text,
      truncated,
    },
  };
}

const FOLDER_TREE_SKIP_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".next",
  "build",
]);

const FOLDER_TREE_MAX_DEPTH = 5;
const FOLDER_TREE_MAX_LINES = 500;
const FOLDER_LISTING_CHAR_CAP = 32_000;

interface FolderTreeState {
  lines: string[];
  lineCount: number;
  truncated: boolean;
}

async function appendFolderTreeLines(
  dirUri: vscode.Uri,
  state: FolderTreeState,
  depth: number,
  maxDepth: number,
): Promise<void> {
  if (state.lineCount >= FOLDER_TREE_MAX_LINES || depth > maxDepth) {
    return;
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return;
  }
  const sorted = [...entries]
    .filter(([name]) => !FOLDER_TREE_SKIP_NAMES.has(name))
    .sort((a, b) => {
      const da = a[1] === vscode.FileType.Directory;
      const db = b[1] === vscode.FileType.Directory;
      if (da !== db) {
        return da ? -1 : 1;
      }
      return a[0].localeCompare(b[0]);
    });
  const indent = "  ".repeat(depth);
  for (const [name, type] of sorted) {
    if (state.lineCount >= FOLDER_TREE_MAX_LINES) {
      state.truncated = true;
      state.lines.push(`${indent}[… subtree omitted: line cap]`);
      break;
    }
    const isDir = type === vscode.FileType.Directory;
    state.lines.push(`${indent}${isDir ? "+ " : "- "}${name}${isDir ? "/" : ""}`);
    state.lineCount += 1;
    if (isDir && depth < maxDepth) {
      await appendFolderTreeLines(vscode.Uri.joinPath(dirUri, name), state, depth + 1, maxDepth);
    }
  }
}

async function resolveFolderMention(
  workspaceRoot: vscode.Uri,
  relPath: string,
  rawForError: string,
  budget: { remainingChars: number },
): Promise<{ folder?: ResolvedMentionFolder; error?: ChatMentionError }> {
  if (relPath.includes("..")) {
    return { error: { mention: rawForError, reason: "relative parent segments (..) are not allowed" } };
  }
  const pathLower = relPath.toLowerCase();
  if (isLikelySecret(pathLower)) {
    return { error: { mention: rawForError, reason: "blocked because it looks like a secret path" } };
  }
  const targetUri = vscode.Uri.joinPath(workspaceRoot, ...relPath.split("/"));
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(targetUri);
  } catch {
    return { error: { mention: rawForError, reason: "folder not found in workspace" } };
  }
  if (stat.type !== vscode.FileType.Directory) {
    return {
      error: {
        mention: rawForError,
        reason: "path is not a directory (use a bare @path for files, or @folder:… for folders)",
      },
    };
  }
  const state: FolderTreeState = { lines: [], lineCount: 0, truncated: false };
  await appendFolderTreeLines(targetUri, state, 0, FOLDER_TREE_MAX_DEPTH);
  let text = state.lines.join("\n");
  if (!text) {
    text = "(empty directory)";
  }
  const maxChars = Math.min(FOLDER_LISTING_CHAR_CAP, budget.remainingChars);
  if (maxChars <= 0) {
    return { error: { mention: rawForError, reason: "no room left in total mention context budget" } };
  }
  let truncated = state.truncated;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  budget.remainingChars -= text.length;
  return {
    folder: {
      mention: rawForError,
      displayPath: relPath,
      content: text,
      truncated,
    },
  };
}

async function resolveSymbolMention(
  parsed: ParsedMention,
  budget: { remainingChars: number },
  settings: ChatMentionSettings,
): Promise<{ symbol?: ResolvedMentionSymbol; error?: ChatMentionError }> {
  const name = parsed.symbolName ?? "";
  const raw = parsed.raw;
  if (!name) {
    return { error: { mention: raw, reason: "symbol mention requires a name (e.g. @symbol:Foo)" } };
  }

  const candidates = await executeWorkspaceSymbolsRaced(name);
  let matches = candidates.filter((s) => s.name === name);
  if (matches.length === 0) {
    matches = candidates.filter(
      (s) => s.name.toLowerCase() === name.toLowerCase() || s.name.endsWith(`.${name}`),
    );
  }
  if (matches.length === 0) {
    return {
      error: { mention: raw, reason: `symbol "${name}" not found in workspace` },
    };
  }

  if (parsed.filePathHint) {
    const hint = parsed.filePathHint.toLowerCase();
    const filtered = matches.filter((s) => symbolRelPath(s).toLowerCase().includes(hint));
    if (filtered.length > 0) {
      matches = filtered;
    }
  }

  let chosen = matches[0];
  if (parsed.lineHint !== undefined && matches.length > 1) {
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const s of matches) {
      const delta = Math.abs(s.location.range.start.line + 1 - parsed.lineHint);
      if (delta < bestDelta) {
        bestDelta = delta;
        chosen = s;
      }
    }
  }

  const ambiguous = matches.length > 1 && !parsed.filePathHint;

  const relPath = symbolRelPath(chosen);
  if (isLikelySecret(relPath.toLowerCase())) {
    return { error: { mention: raw, reason: "blocked because it looks like a secret file" } };
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(chosen.location.uri);
  } catch {
    return { error: { mention: raw, reason: "failed to read source file for symbol" } };
  }
  if (hasNullByte(bytes)) {
    return { error: { mention: raw, reason: "binary-like source file blocked" } };
  }

  const text = decodeUtf8(bytes);
  const lines = text.split(/\r?\n/);
  const startLine = Math.max(0, chosen.location.range.start.line);
  const endLine = Math.min(lines.length - 1, chosen.location.range.end.line);
  let body = lines.slice(startLine, endLine + 1).join("\n");

  let truncated = false;
  const perSymbolCap = Math.min(settings.maxSymbolChars, budget.remainingChars);
  if (perSymbolCap <= 0) {
    return { error: { mention: raw, reason: "no room left in total mention context budget" } };
  }
  if (body.length > perSymbolCap) {
    body = body.slice(0, perSymbolCap);
    truncated = true;
  }
  budget.remainingChars -= body.length;

  const ambiguousNote = ambiguous
    ? ` (ambiguous; picked ${relPath}:${startLine + 1}, used first of ${matches.length} matches)`
    : "";

  return {
    symbol: {
      raw: raw + ambiguousNote,
      name: chosen.name,
      kindLabel: symbolKindLabel(chosen.kind),
      filePath: relPath,
      startLine: startLine + 1,
      endLine: endLine + 1,
      containerName: chosen.containerName || undefined,
      language: fenceLanguageForFile(relPath),
      content: body,
      truncated,
    },
  };
}

export async function buildPromptWithMentions(
  workspaceRoot: vscode.Uri,
  originalPrompt: string,
  settings: ChatMentionSettings = getChatMentionSettings(),
): Promise<ResolvedMentionContext> {
  const mentions = parseMentions(originalPrompt);
  if (mentions.length === 0) {
    return {
      originalPrompt,
      promptForAgent: originalPrompt,
      files: [],
      folders: [],
      plans: [],
      phases: [],
      tasks: [],
      symbols: [],
      errors: [],
    };
  }

  const files: ResolvedMentionFile[] = [];
  const folders: ResolvedMentionFolder[] = [];
  const mentionedPlans: ResolvedMentionPlan[] = [];
  const phases: ResolvedMentionPhase[] = [];
  const tasks: ResolvedMentionTask[] = [];
  const symbols: ResolvedMentionSymbol[] = [];
  const errors: ChatMentionError[] = [];
  const budget = { remainingChars: settings.maxTotalChars };
  let fileCount = 0;
  let entityCount = 0;
  let symbolCount = 0;
  let plansCache: Plan[] | undefined;

  const ensurePlans = async (): Promise<Plan[]> => {
    if (!plansCache) {
      try {
        plansCache = await loadMentionPlansFromWorkspace();
      } catch {
        plansCache = [];
      }
    }
    return plansCache;
  };

  for (const m of mentions) {
    if (m.kind === "file" && m.filePath) {
      if (fileCount >= settings.maxFiles) {
        errors.push({
          mention: m.raw,
          reason: `ignored because max file or folder mentions per message is ${settings.maxFiles}`,
        });
        continue;
      }
      const { file, error } = await resolveFileMention(workspaceRoot, m.filePath, budget, settings);
      if (error) {
        errors.push(error);
        continue;
      }
      if (file) {
        files.push(file);
        fileCount += 1;
      }
      if (budget.remainingChars <= 0) {
        break;
      }
      continue;
    }

    if (m.kind === "folder" && m.filePath) {
      if (fileCount >= settings.maxFiles) {
        errors.push({
          mention: m.raw,
          reason: `ignored because max file or folder mentions per message is ${settings.maxFiles}`,
        });
        continue;
      }
      const { folder, error } = await resolveFolderMention(workspaceRoot, m.filePath, m.raw, budget);
      if (error) {
        errors.push(error);
        continue;
      }
      if (folder) {
        folders.push(folder);
        fileCount += 1;
      }
      if (budget.remainingChars <= 0) {
        break;
      }
      continue;
    }

    if (m.kind === "symbol") {
      if (symbolCount >= settings.maxSymbols) {
        errors.push({
          mention: m.raw,
          reason: `ignored because max symbol mentions per message is ${settings.maxSymbols}`,
        });
        continue;
      }
      const { symbol, error } = await resolveSymbolMention(m, budget, settings);
      if (error) {
        errors.push(error);
        continue;
      }
      if (symbol) {
        symbols.push(symbol);
        symbolCount += 1;
      }
      if (budget.remainingChars <= 0) {
        break;
      }
      continue;
    }

    if (entityCount >= settings.maxEntities) {
      errors.push({
        mention: m.raw,
        reason: `ignored because max entity mentions per message is ${settings.maxEntities}`,
      });
      continue;
    }

    const loadedPlans = await ensurePlans();

    if (m.kind === "plan") {
      if (!m.planId) {
        errors.push({
          mention: m.raw,
          reason: "plan mention requires a plan id (e.g. @plan:my-plan-id)",
        });
        continue;
      }
      const plan = loadedPlans.find((p) => p.id === m.planId);
      if (!plan) {
        errors.push({ mention: m.raw, reason: `plan "${m.planId}" not found` });
        continue;
      }
      mentionedPlans.push({
        raw: m.raw,
        planId: plan.id,
        title: plan.title,
        description: describePlan(plan),
        state: plan.state,
        phaseCount: plan.phases.length,
        phaseOutline: buildPlanPhaseOutline(plan),
        gitSummary: gitLineForPlan(plan),
      });
      entityCount += 1;
      continue;
    }

    if (m.kind === "phase") {
      if (!m.planId || !m.phaseId) {
        errors.push({
          mention: m.raw,
          reason: "phase mention requires planId/phaseId (e.g. @phase:plan-id/phase-id)",
        });
        continue;
      }
      const plan = loadedPlans.find((p) => p.id === m.planId);
      if (!plan) {
        errors.push({ mention: m.raw, reason: `plan "${m.planId}" not found` });
        continue;
      }
      const phase = plan.phases.find((ph) => ph.id === m.phaseId);
      if (!phase) {
        errors.push({
          mention: m.raw,
          reason: `phase "${m.phaseId}" not found in plan "${m.planId}"`,
        });
        continue;
      }
      phases.push({
        raw: m.raw,
        planId: plan.id,
        phaseId: phase.id,
        title: phase.title,
        description: describePhase(phase),
        state: phase.state,
        dependsOn: phase.dependsOn ? [...phase.dependsOn] : [],
        taskCount: phase.tasks.length,
      });
      entityCount += 1;
      continue;
    }

    if (m.kind === "task") {
      if (!m.planId || !m.phaseId || !m.taskId) {
        errors.push({
          mention: m.raw,
          reason: "task mention requires planId/phaseId/taskId (e.g. @task:plan-id/phase-id/task-id)",
        });
        continue;
      }
      const plan = loadedPlans.find((p) => p.id === m.planId);
      if (!plan) {
        errors.push({ mention: m.raw, reason: `plan "${m.planId}" not found` });
        continue;
      }
      const phase = plan.phases.find((ph) => ph.id === m.phaseId);
      if (!phase) {
        errors.push({
          mention: m.raw,
          reason: `phase "${m.phaseId}" not found in plan "${m.planId}"`,
        });
        continue;
      }
      const task = phase.tasks.find((t) => t.id === m.taskId);
      if (!task) {
        errors.push({
          mention: m.raw,
          reason: `task "${m.taskId}" not found in phase "${m.phaseId}"`,
        });
        continue;
      }
      tasks.push({
        raw: m.raw,
        planId: plan.id,
        phaseId: phase.id,
        taskId: task.id,
        desc: describeTask(task),
        prompt: task.prompt,
        state: task.state,
        commit: task.commit,
      });
      entityCount += 1;
      continue;
    }
  }

  return {
    originalPrompt,
    promptForAgent: buildExpandedPrompt(
      originalPrompt,
      files,
      folders,
      mentionedPlans,
      phases,
      tasks,
      symbols,
    ),
    files,
    folders,
    plans: mentionedPlans,
    phases,
    tasks,
    symbols,
    errors,
  };
}

function scoreCandidate(text: string, query: string): number {
  if (!query) {
    return 0;
  }
  const p = text.toLowerCase();
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

/** For multi-word queries, every token must appear somewhere in the haystack. */
function queryTokensMatchHaystack(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return true;
  }
  const h = haystack.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

/**
 * Score a phase for autocomplete: ids, plan title, phase title, and description.
 * Title matches rank above weak id-path fuzzy matches so users can search by name.
 */
function scorePhaseForQuery(plan: Plan, phase: Phase, query: string): number {
  const q = query.trim();
  if (!q) {
    return 0;
  }
  const idPath = `${plan.id}/${phase.id}`;
  const planTitle = plan.title ?? "";
  const phaseTitle = phase.title ?? "";
  const phaseDesc = phase.description ?? "";
  const hay = `${planTitle} ${phaseTitle} ${phaseDesc}`.trim();
  if (!queryTokensMatchHaystack(hay, q)) {
    return Number.NEGATIVE_INFINITY;
  }
  const idScore = scoreCandidate(idPath, q);
  const titleScore = scoreCandidate(phaseTitle, q);
  const descScore = scoreCandidate(phaseDesc, q);
  const planScore = scoreCandidate(planTitle, q);
  const hayScore = scoreCandidate(hay, q);
  let best = idScore;
  if (titleScore > best) {
    best = titleScore + 80_000;
  }
  if (descScore > best) {
    best = descScore + 35_000;
  }
  if (planScore > best) {
    best = planScore + 20_000;
  }
  if (hayScore > best) {
    best = hayScore + 10_000;
  }
  return best;
}

/** Score a whole plan for autocomplete (id, title, description). */
function scorePlanForQuery(plan: Plan, query: string): number {
  const q = query.trim();
  if (!q) {
    return 0;
  }
  const idPath = plan.id;
  const planTitle = plan.title ?? "";
  const planDesc = plan.description ?? "";
  const hay = `${planTitle} ${planDesc} ${idPath}`.trim();
  if (!queryTokensMatchHaystack(hay, q)) {
    return Number.NEGATIVE_INFINITY;
  }
  const idScore = scoreCandidate(idPath, q);
  const titleScore = scoreCandidate(planTitle, q);
  const descScore = scoreCandidate(planDesc, q);
  const hayScore = scoreCandidate(hay, q);
  let best = idScore;
  if (titleScore > best) {
    best = titleScore + 85_000;
  }
  if (descScore > best) {
    best = descScore + 40_000;
  }
  if (hayScore > best) {
    best = hayScore + 12_000;
  }
  return best;
}

function scoreTaskForQuery(plan: Plan, phase: Phase, task: Task, query: string): number {
  const q = query.trim();
  if (!q) {
    return 0;
  }
  const idPath = `${plan.id}/${phase.id}/${task.id}`;
  const planTitle = plan.title ?? "";
  const phaseTitle = phase.title ?? "";
  const taskDesc = task.desc ?? "";
  const taskPrompt = task.prompt ?? "";
  const hay = `${planTitle} ${phaseTitle} ${taskDesc} ${taskPrompt}`.trim();
  if (!queryTokensMatchHaystack(hay, q)) {
    return Number.NEGATIVE_INFINITY;
  }
  const idScore = scoreCandidate(idPath, q);
  const descScore = scoreCandidate(taskDesc, q);
  const promptScore = scoreCandidate(taskPrompt, q);
  const phaseTitleScore = scoreCandidate(phaseTitle, q);
  const planScore = scoreCandidate(planTitle, q);
  const hayScore = scoreCandidate(hay, q);
  let best = idScore;
  if (descScore > best) {
    best = descScore + 85_000;
  }
  if (promptScore > best) {
    best = promptScore + 45_000;
  }
  if (phaseTitleScore > best) {
    best = phaseTitleScore + 30_000;
  }
  if (planScore > best) {
    best = planScore + 15_000;
  }
  if (hayScore > best) {
    best = hayScore + 8_000;
  }
  return best;
}

function fileSuggestion(path: string): MentionSuggestion {
  return { kind: "file", insertText: path, label: path };
}

function folderSuggestion(relPath: string): MentionSuggestion {
  const insertText = `folder:${relPath}`;
  return {
    kind: "folder",
    insertText,
    label: `${relPath}/`,
    detail: "directory",
  };
}

async function listWorkspaceMentionFilePaths(workspaceRoot: vscode.Uri): Promise<string[]> {
  const [general, planJson] = await Promise.all([
    vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceRoot, "**/*"),
      MENTION_FIND_FILES_EXCLUDE,
      3000,
    ),
    vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceRoot, ".planstack/plans/*.json"),
      MENTION_FIND_FILES_EXCLUDE,
      600,
    ),
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const uri of [...general, ...planJson]) {
    const p = normalizeRelPath(vscode.workspace.asRelativePath(uri, false));
    if (p.length === 0 || isLikelySecret(p.toLowerCase()) || seen.has(p)) {
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}

function folderPathsFromFilePaths(relPaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of relPaths) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      dirs.add(parts.slice(0, i + 1).join("/"));
    }
  }
  return [...dirs];
}

function findFileSuggestionsFromPaths(relPaths: string[], query: string, limit: number): MentionSuggestion[] {
  const sorted = [...relPaths].sort((a, b) => {
    const sa = scoreCandidate(a, query);
    const sb = scoreCandidate(b, query);
    if (sa !== sb) {
      return sb - sa;
    }
    return a.localeCompare(b);
  });
  return sorted.slice(0, limit).map((p) => fileSuggestion(p));
}

function findFolderSuggestionsFromPaths(relPaths: string[], query: string, limit: number): MentionSuggestion[] {
  const folders = folderPathsFromFilePaths(relPaths);
  const q = query.trim();
  const rows = folders.map((path) => ({
    suggestion: folderSuggestion(path),
    score: scoreCandidate(path, q),
  }));
  const filtered = q ? rows.filter((r) => r.score !== Number.NEGATIVE_INFINITY) : rows;
  filtered.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  return filtered.slice(0, limit).map((r) => r.suggestion);
}

function phaseSuggestion(plan: Plan, phase: Phase): MentionSuggestion {
  const insertText = `phase:${plan.id}/${phase.id}`;
  return {
    kind: "phase",
    insertText,
    label: `${phase.title} · ${insertText}`,
    detail: `${plan.title} · ${phase.state}`,
  };
}

function taskSuggestion(plan: Plan, phase: Phase, task: Task): MentionSuggestion {
  const insertText = `task:${plan.id}/${phase.id}/${task.id}`;
  return {
    kind: "task",
    insertText,
    label: `${task.desc} · ${insertText}`,
    detail: `${plan.title} · ${phase.title} · ${task.state}`,
  };
}

function planSuggestion(plan: Plan): MentionSuggestion {
  const insertText = `plan:${plan.id}`;
  return {
    kind: "plan",
    insertText,
    label: `${plan.title} · ${insertText}`,
    detail: `${plan.state} · ${plan.phases.length} phase(s)`,
  };
}

function symbolSuggestion(symbol: vscode.SymbolInformation): MentionSuggestion {
  const relPath = symbolRelPath(symbol);
  const line = symbol.location.range.start.line + 1;
  const insertText = `symbol:${symbol.name}@${relPath}:${line}`;
  const kindLabel = symbolKindLabel(symbol.kind);
  const container = symbol.containerName ? ` (${symbol.containerName})` : "";
  return {
    kind: "symbol",
    insertText,
    label: `${symbol.name} [${kindLabel}]${container}`,
    detail: `${relPath}:${line}`,
  };
}

function isAllowedSymbol(symbol: vscode.SymbolInformation): boolean {
  return SYMBOL_KIND_ALLOW.has(symbol.kind);
}

function scoreSymbolForQuery(symbol: vscode.SymbolInformation, query: string): number {
  const q = query.trim();
  if (!q) {
    return 0;
  }
  const nameScore = scoreCandidate(symbol.name, q);
  const containerScore = symbol.containerName ? scoreCandidate(symbol.containerName, q) : Number.NEGATIVE_INFINITY;
  const pathScore = scoreCandidate(symbolRelPath(symbol), q);
  let best = nameScore;
  if (containerScore > best) {
    best = containerScore + 5_000;
  }
  if (pathScore > best) {
    best = pathScore - 50_000;
  }
  return best;
}

async function findSymbolSuggestions(query: string, limit: number): Promise<MentionSuggestion[]> {
  const q = query.trim();
  if (!q) {
    return [];
  }
  const symbols = await executeWorkspaceSymbolsRaced(q);
  if (symbols.length === 0) {
    return [];
  }
  const filtered = symbols.filter(isAllowedSymbol);
  const ranked = filtered
    .map((s) => ({ symbol: s, score: scoreSymbolForQuery(s, q) }))
    .filter((row) => row.score !== Number.NEGATIVE_INFINITY)
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.symbol.name.localeCompare(b.symbol.name);
    });
  const seen = new Set<string>();
  const out: MentionSuggestion[] = [];
  for (const row of ranked) {
    const sug = symbolSuggestion(row.symbol);
    if (seen.has(sug.insertText)) {
      continue;
    }
    seen.add(sug.insertText);
    out.push(sug);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

export interface MentionSuggestionOptions {
  /** Full active token text after the leading `@`, may include typed prefixes such as `phase:` / `task:` / `folder:` / `symbol:`. */
  rawQuery: string;
  limit?: number;
}

async function findFileSuggestions(
  workspaceRoot: vscode.Uri,
  query: string,
  limit: number,
): Promise<MentionSuggestion[]> {
  const relPaths = await listWorkspaceMentionFilePaths(workspaceRoot);
  return findFileSuggestionsFromPaths(relPaths, query, limit);
}

async function findFolderSuggestions(
  workspaceRoot: vscode.Uri,
  query: string,
  limit: number,
): Promise<MentionSuggestion[]> {
  const relPaths = await listWorkspaceMentionFilePaths(workspaceRoot);
  return findFolderSuggestionsFromPaths(relPaths, query, limit);
}

/** Files and folders together (for bare `@` or file-only mode). */
async function findPathSuggestions(
  workspaceRoot: vscode.Uri,
  query: string,
  limit: number,
): Promise<MentionSuggestion[]> {
  const relPaths = await listWorkspaceMentionFilePaths(workspaceRoot);
  const q = query.trim();
  const cand = Math.min(120, Math.max(limit * 4, 24));
  const files = findFileSuggestionsFromPaths(relPaths, query, cand);
  const folders = findFolderSuggestionsFromPaths(relPaths, query, cand);
  const pool: { suggestion: MentionSuggestion; score: number }[] = [];
  for (const s of files) {
    pool.push({ suggestion: s, score: scoreCandidate(s.insertText, q) });
  }
  for (const s of folders) {
    const p = s.insertText.startsWith("folder:") ? s.insertText.slice("folder:".length) : s.insertText;
    let sc = scoreCandidate(p, q);
    if (q && sc !== Number.NEGATIVE_INFINITY && p.toLowerCase().endsWith(`/${q.toLowerCase()}`)) {
      sc += 25_000;
    }
    pool.push({ suggestion: s, score: sc });
  }
  pool.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const ka = `${a.suggestion.kind}|${a.suggestion.insertText}`;
    const kb = `${b.suggestion.kind}|${b.suggestion.insertText}`;
    return ka.localeCompare(kb);
  });
  const seen = new Set<string>();
  const out: MentionSuggestion[] = [];
  for (const row of pool) {
    const key = `${row.suggestion.kind}|${row.suggestion.insertText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(row.suggestion);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function findPhaseSuggestions(plans: Plan[], query: string, limit: number): MentionSuggestion[] {
  const candidates: { suggestion: MentionSuggestion; score: number }[] = [];
  const q = query.trim();
  for (const plan of plans) {
    for (const phase of plan.phases) {
      const scored = q ? scorePhaseForQuery(plan, phase, q) : 0;
      if (q && scored === Number.NEGATIVE_INFINITY) {
        continue;
      }
      candidates.push({ suggestion: phaseSuggestion(plan, phase), score: scored });
    }
  }
  candidates.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  return candidates.slice(0, limit).map((c) => c.suggestion);
}

function findTaskSuggestions(plans: Plan[], query: string, limit: number): MentionSuggestion[] {
  const candidates: { suggestion: MentionSuggestion; score: number }[] = [];
  const q = query.trim();
  for (const plan of plans) {
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        const scored = q ? scoreTaskForQuery(plan, phase, task, q) : 0;
        if (q && scored === Number.NEGATIVE_INFINITY) {
          continue;
        }
        candidates.push({ suggestion: taskSuggestion(plan, phase, task), score: scored });
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  return candidates.slice(0, limit).map((c) => c.suggestion);
}

function findPlanSuggestions(plans: Plan[], query: string, limit: number): MentionSuggestion[] {
  const candidates: { suggestion: MentionSuggestion; score: number }[] = [];
  const q = query.trim();
  for (const plan of plans) {
    const scored = q ? scorePlanForQuery(plan, q) : 0;
    if (q && scored === Number.NEGATIVE_INFINITY) {
      continue;
    }
    candidates.push({ suggestion: planSuggestion(plan), score: scored });
  }
  candidates.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  return candidates.slice(0, limit).map((c) => c.suggestion);
}

/**
 * Merge file + folder + plan + phase + task + symbol suggestions for a bare `@query` token.
 * Scores all buckets on the same scale so strong title matches can outrank weak path matches.
 */
async function mergeBareQuerySuggestions(
  workspaceRoot: vscode.Uri,
  plans: Plan[],
  query: string,
  limit: number,
): Promise<MentionSuggestion[]> {
  const q = query.trim();
  const fileBudget = Math.min(100, Math.max(limit * 4, 24));
  const relPaths = await listWorkspaceMentionFilePaths(workspaceRoot);
  const files = findFileSuggestionsFromPaths(relPaths, q, fileBudget);
  const folderBudget = Math.min(80, Math.max(limit * 2, 16));
  const folders = findFolderSuggestionsFromPaths(relPaths, q, folderBudget);

  const pool: { suggestion: MentionSuggestion; score: number }[] = [];
  for (const s of files) {
    pool.push({ suggestion: s, score: scoreCandidate(s.insertText, q) });
  }
  for (const s of folders) {
    const p = s.insertText.startsWith("folder:") ? s.insertText.slice("folder:".length) : s.insertText;
    let sc = scoreCandidate(p, q);
    if (q && sc !== Number.NEGATIVE_INFINITY && p.toLowerCase().endsWith(`/${q.toLowerCase()}`)) {
      sc += 25_000;
    }
    pool.push({ suggestion: s, score: sc });
  }

  const planRows: { suggestion: MentionSuggestion; score: number }[] = [];
  for (const plan of plans) {
    const sc = scorePlanForQuery(plan, q);
    if (sc === Number.NEGATIVE_INFINITY) {
      continue;
    }
    planRows.push({ suggestion: planSuggestion(plan), score: sc });
  }
  planRows.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  const planKeep = Math.min(40, Math.max(limit * 2, 12));
  for (const row of planRows.slice(0, planKeep)) {
    pool.push(row);
  }

  const phaseRows: { suggestion: MentionSuggestion; score: number }[] = [];
  for (const plan of plans) {
    for (const phase of plan.phases) {
      const sc = scorePhaseForQuery(plan, phase, q);
      if (sc === Number.NEGATIVE_INFINITY) {
        continue;
      }
      phaseRows.push({ suggestion: phaseSuggestion(plan, phase), score: sc });
    }
  }
  phaseRows.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  const phaseKeep = Math.min(100, Math.max(limit * 3, 16));
  for (const row of phaseRows.slice(0, phaseKeep)) {
    pool.push(row);
  }

  const taskRows: { suggestion: MentionSuggestion; score: number }[] = [];
  for (const plan of plans) {
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        const sc = scoreTaskForQuery(plan, phase, task, q);
        if (sc === Number.NEGATIVE_INFINITY) {
          continue;
        }
        taskRows.push({ suggestion: taskSuggestion(plan, phase, task), score: sc });
      }
    }
  }
  taskRows.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
  });
  const taskKeep = Math.min(150, Math.max(limit * 4, 16));
  for (const row of taskRows.slice(0, taskKeep)) {
    pool.push(row);
  }

  try {
    const symbols = await executeWorkspaceSymbolsRaced(q);
    const symbolRows: { suggestion: MentionSuggestion; score: number }[] = [];
    for (const s of symbols) {
      if (!isAllowedSymbol(s)) {
        continue;
      }
      const sc = scoreSymbolForQuery(s, q);
      if (sc === Number.NEGATIVE_INFINITY) {
        continue;
      }
      symbolRows.push({ suggestion: symbolSuggestion(s), score: sc });
    }
    symbolRows.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.suggestion.insertText.localeCompare(b.suggestion.insertText);
    });
    const symbolKeep = Math.min(60, Math.max(limit * 2, 12));
    for (const row of symbolRows.slice(0, symbolKeep)) {
      pool.push(row);
    }
  } catch {
    // Symbol provider unavailable — skip silently.
  }

  pool.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const ka = `${a.suggestion.kind}|${a.suggestion.insertText}`;
    const kb = `${b.suggestion.kind}|${b.suggestion.insertText}`;
    return ka.localeCompare(kb);
  });
  const seen = new Set<string>();
  const out: MentionSuggestion[] = [];
  for (const row of pool) {
    const key = `${row.suggestion.kind}|${row.suggestion.insertText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(row.suggestion);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function classifyActiveQuery(rawQuery: string): { kind: MentionKind | "ambiguous"; body: string } {
  const trimmed = rawQuery.trim();
  if (trimmed.startsWith("plan:")) {
    return { kind: "plan", body: trimmed.slice("plan:".length) };
  }
  if (trimmed.startsWith("phase:")) {
    return { kind: "phase", body: trimmed.slice("phase:".length) };
  }
  if (trimmed.startsWith("task:")) {
    return { kind: "task", body: trimmed.slice("task:".length) };
  }
  if (trimmed.startsWith("folder:")) {
    return { kind: "folder", body: trimmed.slice("folder:".length) };
  }
  if (trimmed.startsWith("symbol:")) {
    // Strip optional `@filePath(:line)` hint when classifying for autocomplete -
    // the dropdown only needs the symbol name to query the LSP.
    const after = trimmed.slice("symbol:".length);
    const at = after.indexOf("@");
    return { kind: "symbol", body: at >= 0 ? after.slice(0, at) : after };
  }
  // Bare @query now surfaces file + folder + plan + phase + task + symbol suggestions together.
  // Selecting a row still inserts its canonical typed token.
  if (trimmed.length > 0) {
    return { kind: "ambiguous", body: trimmed };
  }
  return { kind: "file", body: trimmed };
}

export async function findChatMentionSuggestions(
  workspaceRoot: vscode.Uri,
  options: MentionSuggestionOptions,
): Promise<MentionSuggestion[]> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 12));
  const classified = classifyActiveQuery(options.rawQuery ?? "");

  if (classified.kind === "file") {
    return findPathSuggestions(workspaceRoot, classified.body, limit);
  }

  if (classified.kind === "folder") {
    return findFolderSuggestions(workspaceRoot, classified.body, limit);
  }

  if (classified.kind === "plan") {
    let plans: Plan[] = [];
    try {
      plans = await loadMentionPlansFromWorkspace();
    } catch {
      plans = [];
    }
    return findPlanSuggestions(plans, classified.body, limit);
  }

  if (classified.kind === "phase") {
    let plans: Plan[] = [];
    try {
      plans = await loadMentionPlansFromWorkspace();
    } catch {
      plans = [];
    }
    return findPhaseSuggestions(plans, classified.body, limit);
  }

  if (classified.kind === "task") {
    let plans: Plan[] = [];
    try {
      plans = await loadMentionPlansFromWorkspace();
    } catch {
      plans = [];
    }
    return findTaskSuggestions(plans, classified.body, limit);
  }

  if (classified.kind === "symbol") {
    return findSymbolSuggestions(classified.body, limit);
  }

  let plansResult: Plan[] = [];
  try {
    plansResult = await loadMentionPlansFromWorkspace();
  } catch {
    plansResult = [];
  }
  return mergeBareQuerySuggestions(workspaceRoot, plansResult, classified.body, limit);
}
