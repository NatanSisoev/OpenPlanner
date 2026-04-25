import type { Filter } from "mongodb";
import { MongoClient } from "mongodb";
import type { Uri } from "vscode";
import { loadPlansFromWorkspace } from "./loader";
import { alignPlanSyncFromRemote, comparePlanSync, planSyncComparable } from "./planSyncStamp";
import { PlanSyncError } from "./planSyncError";
import type { Plan } from "./types";
import { validatePlanJson } from "./validate";
import { savePlanPreservingFile } from "./writePlan";

const SERVER_SELECTION_MS = 15_000;

type RemotePlanDoc = {
  _id: string;
  updatedAt: Date;
  revision: number;
  payload: unknown;
};

function ensureDate(v: unknown): Date {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v;
  }
  return new Date(0);
}

function ensureRevision(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  return 0;
}

function clonePlan(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan)) as Plan;
}

export type ReconcileMongoPlansResult = {
  reconciled: number;
  failed: string[];
  /** Distinct plan ids in union(local, remote). */
  idsTotal: number;
  localPlanCount: number;
  remoteDocCount: number;
  /** Both sides present and compare equal (no write needed). */
  unchangedCount: number;
};

/**
 * Bidirectional reconcile: for each plan id in union(local, remote), keep the newest
 * version on both disk and MongoDB (compare sync.updatedAt + revision).
 */
export async function reconcileAllPlansWithMongo(
  workspaceRoot: Uri,
  uri: string,
  database: string,
  collection: string,
  report: (message: string, increment?: number) => void,
): Promise<ReconcileMongoPlansResult> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_MS });
  const failed: string[] = [];
  let reconciled = 0;
  let unchangedCount = 0;

  try {
    await client.connect();
    const coll = client.db(database).collection<Record<string, unknown>>(collection);
    const localPlans = await loadPlansFromWorkspace();
    const localById = new Map(localPlans.map((p) => [p.id, p]));

    const remoteById = new Map<string, RemotePlanDoc>();
    const cursor = coll.find({}, { projection: { _id: 1, updatedAt: 1, revision: 1, payload: 1 } });
    for await (const doc of cursor) {
      const id = typeof doc._id === "string" ? doc._id : String(doc._id ?? "");
      if (!id) {
        continue;
      }
      remoteById.set(id, {
        _id: id,
        updatedAt: ensureDate(doc.updatedAt),
        revision: ensureRevision(doc.revision),
        payload: doc.payload,
      });
    }

    const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);
    const ids = [...allIds].sort();
    const total = ids.length;
    if (total === 0) {
      return {
        reconciled: 0,
        failed: [],
        idsTotal: 0,
        localPlanCount: localPlans.length,
        remoteDocCount: remoteById.size,
        unchangedCount: 0,
      };
    }

    let i = 0;
    for (const id of ids) {
      i += 1;
      report(`${i}/${total} · ${id}`, 100 / total);
      try {
        const local = localById.get(id);
        const remote = remoteById.get(id);

        if (!remote) {
          if (!local) {
            continue;
          }
          const plan = clonePlan(local);
          if (!plan.sync?.updatedAt) {
            const c = planSyncComparable(plan);
            alignPlanSyncFromRemote(plan, new Date(c.ms), c.revision);
            await savePlanPreservingFile(plan, workspaceRoot, { skipSyncStamp: true });
          }
          const replacementOnlyLocal: Record<string, unknown> = {
            _id: id,
            payload: plan,
            updatedAt: new Date(plan.sync!.updatedAt),
            revision: plan.sync!.revision ?? 0,
          };
          await coll.replaceOne({ _id: id } as unknown as Filter<Record<string, unknown>>, replacementOnlyLocal, {
            upsert: true,
          });
          reconciled += 1;
          continue;
        }

        if (!local) {
          const validated = validatePlanJson(remote.payload);
          if (validated.id !== id) {
            throw new PlanSyncError(`Remote payload id "${validated.id}" does not match _id "${id}".`);
          }
          alignPlanSyncFromRemote(validated, remote.updatedAt, remote.revision);
          await savePlanPreservingFile(validated, workspaceRoot, { skipSyncStamp: true });
          reconciled += 1;
          continue;
        }

        const lc = planSyncComparable(local);
        const rc = { ms: remote.updatedAt.getTime(), revision: remote.revision };
        const cmp = comparePlanSync(lc, rc);
        if (cmp > 0) {
          const plan = clonePlan(local);
          if (!plan.sync?.updatedAt) {
            const c = planSyncComparable(plan);
            alignPlanSyncFromRemote(plan, new Date(c.ms), c.revision);
            await savePlanPreservingFile(plan, workspaceRoot, { skipSyncStamp: true });
          }
          const replacementLocal: Record<string, unknown> = {
            _id: id,
            payload: plan,
            updatedAt: new Date(plan.sync!.updatedAt),
            revision: plan.sync!.revision ?? 0,
          };
          await coll.replaceOne({ _id: id } as unknown as Filter<Record<string, unknown>>, replacementLocal, {
            upsert: true,
          });
          reconciled += 1;
        } else if (cmp < 0) {
          const validated = validatePlanJson(remote.payload);
          if (validated.id !== id) {
            throw new PlanSyncError(`Remote payload id "${validated.id}" does not match _id "${id}".`);
          }
          alignPlanSyncFromRemote(validated, remote.updatedAt, remote.revision);
          await savePlanPreservingFile(validated, workspaceRoot, { skipSyncStamp: true });
          reconciled += 1;
        } else {
          unchangedCount += 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${id}: ${msg}`);
      }
    }

    return {
      reconciled,
      failed,
      idsTotal: total,
      localPlanCount: localPlans.length,
      remoteDocCount: remoteById.size,
      unchangedCount,
    };
  } catch (e) {
    if (e instanceof PlanSyncError) {
      throw e;
    }
    throw new PlanSyncError(e instanceof Error ? e.message : String(e));
  } finally {
    await client.close().catch(() => {});
  }
}
