import type { Plan, PlanSyncMeta } from "./types";

function parseIsoMs(iso: string | undefined): number {
  if (!iso || typeof iso !== "string") {
    return 0;
  }
  const t = Date.parse(iso.trim());
  return Number.isFinite(t) ? t : 0;
}

/** Lexicographic compare: (updatedAt ms, revision). */
export function planSyncComparable(plan: Plan): { ms: number; revision: number } {
  const sync = plan.sync;
  const ms = parseIsoMs(sync?.updatedAt) || parseIsoMs(plan.createdAt);
  const revision = typeof sync?.revision === "number" && Number.isFinite(sync.revision) ? sync.revision : 0;
  return { ms, revision };
}

export function comparePlanSync(
  a: { ms: number; revision: number },
  b: { ms: number; revision: number },
): number {
  if (a.ms !== b.ms) {
    return a.ms - b.ms;
  }
  return a.revision - b.revision;
}

/** Bump sync metadata for a normal local save (user or agent edited plan on disk). */
export function stampLocalPlanSync(plan: Plan): void {
  const prevRev =
    typeof plan.sync?.revision === "number" && Number.isFinite(plan.sync.revision) ? plan.sync.revision : 0;
  const next: PlanSyncMeta = {
    updatedAt: new Date().toISOString(),
    revision: prevRev + 1,
  };
  plan.sync = next;
}

/** After remote wins reconcile: align JSON sync with Mongo document fields. */
export function alignPlanSyncFromRemote(plan: Plan, updatedAt: Date, revision: number): void {
  plan.sync = {
    updatedAt: updatedAt.toISOString(),
    revision,
  };
}
