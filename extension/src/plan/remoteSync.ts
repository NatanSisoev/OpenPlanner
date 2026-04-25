import * as vscode from "vscode";
import type { Plan } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SYNC_API_BASE_URL_ENV = "PLANSTACK_SYNC_API_BASE_URL";

export interface RemotePlanIndexEntry {
  id: string;
  updatedAt?: string;
  sizeBytes?: number;
}

export interface RemotePlanPayload {
  id: string;
  payload: unknown;
}

export interface RemotePlanSaveResult {
  id: string;
  updatedAt?: string;
  sizeBytes?: number;
}

export class RemoteSyncError extends Error {
  readonly status?: number;
  readonly details?: string;

  constructor(message: string, status?: number, details?: string) {
    super(message);
    this.name = "RemoteSyncError";
    this.status = status;
    this.details = details;
  }
}

export function resolvePlanSyncApiBaseUrl(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("planstack.cursor");
  const fromConfig = cfg.get<string>("syncApiBaseUrl")?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = process.env[SYNC_API_BASE_URL_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return undefined;
}

export async function fetchRemotePlanIndex(baseUrl: string): Promise<RemotePlanIndexEntry[]> {
  const data = await requestJson<unknown>(baseUrl, "/plans", { method: "GET" });
  if (!Array.isArray(data)) {
    throw new RemoteSyncError("Remote sync failed: GET /plans did not return an array.");
  }
  return data
    .filter((entry) => Boolean(entry && typeof entry === "object"))
    .map((entry) => entry as { id?: unknown; updatedAt?: unknown; sizeBytes?: unknown })
    .filter((entry) => typeof entry.id === "string" && entry.id.trim().length > 0)
    .map((entry) => ({
      id: String(entry.id),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
      sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : undefined,
    }));
}

export async function fetchRemotePlanById(baseUrl: string, planId: string): Promise<RemotePlanPayload> {
  const safeId = encodeURIComponent(planId);
  const data = await requestJson<unknown>(baseUrl, `/plans/${safeId}`, { method: "GET" });
  if (!data || typeof data !== "object") {
    throw new RemoteSyncError(`Remote sync failed: GET /plans/${planId} returned invalid JSON.`);
  }
  const payload = data as { id?: unknown; payload?: unknown };
  if (typeof payload.id !== "string") {
    throw new RemoteSyncError(`Remote sync failed: GET /plans/${planId} is missing string id.`);
  }
  return { id: payload.id, payload: payload.payload };
}

export async function pushRemotePlan(baseUrl: string, plan: Plan): Promise<RemotePlanSaveResult> {
  const safeId = encodeURIComponent(plan.id);
  const data = await requestJson<unknown>(baseUrl, `/plans/${safeId}`, {
    method: "PUT",
    body: JSON.stringify(plan),
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!data || typeof data !== "object") {
    throw new RemoteSyncError(`Remote sync failed: PUT /plans/${plan.id} returned invalid JSON.`);
  }
  const out = data as { id?: unknown; updatedAt?: unknown; sizeBytes?: unknown };
  if (typeof out.id !== "string" || out.id.trim().length === 0) {
    throw new RemoteSyncError(`Remote sync failed: PUT /plans/${plan.id} did not return a valid id.`);
  }
  return {
    id: out.id,
    updatedAt: typeof out.updatedAt === "string" ? out.updatedAt : undefined,
    sizeBytes: typeof out.sizeBytes === "number" ? out.sizeBytes : undefined,
  };
}

export function requiredSyncApiBaseUrlOrThrow(): string {
  const baseUrl = resolvePlanSyncApiBaseUrl();
  if (!baseUrl) {
    throw new RemoteSyncError(
      `Plan sync API base URL is missing. Set planstack.cursor.syncApiBaseUrl or ${SYNC_API_BASE_URL_ENV}.`,
    );
  }
  validateBaseUrl(baseUrl);
  return baseUrl;
}

function validateBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RemoteSyncError(`Invalid plan sync API base URL: ${baseUrl}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new RemoteSyncError(`Invalid plan sync API base URL protocol: ${parsed.protocol}`);
  }
}

function buildUrl(baseUrl: string, path: string): URL {
  validateBaseUrl(baseUrl);
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), normalized);
}

async function requestJson<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const url = buildUrl(baseUrl, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
    const raw = await res.text();
    const parsed = raw ? tryParseJson(raw) : undefined;
    if (!res.ok) {
      const detail = extractErrorMessage(parsed) || raw.slice(0, 300);
      throw new RemoteSyncError(
        `Remote sync request failed (${res.status}) for ${init.method || "GET"} ${url.pathname}.`,
        res.status,
        detail,
      );
    }
    if (parsed === undefined) {
      throw new RemoteSyncError(`Remote sync request returned empty response for ${url.pathname}.`);
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof RemoteSyncError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new RemoteSyncError(`Remote sync request timed out for ${init.method || "GET"} ${url.pathname}.`);
    }
    throw new RemoteSyncError(
      `Remote sync request failed for ${init.method || "GET"} ${url.pathname}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function tryParseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const v = value as { error?: unknown; message?: unknown };
  if (typeof v.error === "string" && v.error.trim().length > 0) {
    return v.error;
  }
  if (typeof v.message === "string" && v.message.trim().length > 0) {
    return v.message;
  }
  return undefined;
}
