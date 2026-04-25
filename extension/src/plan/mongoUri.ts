import * as vscode from "vscode";
import { PlanSyncError } from "./planSyncError";

/** Secret storage key. Stable across versions; do not rename. */
export const PLANSTACK_MONGODB_URI_SECRET = "planstack.mongodb.connectionString";

/** Parse MONGODB_URI=... from a single-line .env style buffer (workspace root .env). */
function parseMongoUriFromDotEnvText(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const m = /^\s*MONGODB_URI\s*=\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1).trim();
    }
    if (v.length > 0) {
      return v;
    }
  }
  return undefined;
}

async function readMongoUriFromWorkspaceDotEnv(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const envUri = vscode.Uri.joinPath(folder.uri, ".env");
  try {
    const bytes = await vscode.workspace.fs.readFile(envUri);
    const text = Buffer.from(bytes).toString("utf8");
    return parseMongoUriFromDotEnvText(text);
  } catch {
    return undefined;
  }
}

export async function resolveMongoConnectionString(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const fromSecret = (await context.secrets.get(PLANSTACK_MONGODB_URI_SECRET))?.trim();
  if (fromSecret) {
    return fromSecret;
  }
  const fromEnv = process.env.MONGODB_URI?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return readMongoUriFromWorkspaceDotEnv();
}

export async function requireMongoUriOrThrow(context: vscode.ExtensionContext): Promise<string> {
  const uri = await resolveMongoConnectionString(context);
  if (!uri) {
    throw new PlanSyncError(
      'MongoDB URI is not set. Use command "Planstack: Set MongoDB connection string", set environment variable MONGODB_URI (e.g. in launch.json envFile for F5), or add MONGODB_URI=... to a .env file in the workspace root.',
    );
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new PlanSyncError("MongoDB URI must start with mongodb:// or mongodb+srv://");
  }
  return uri;
}
