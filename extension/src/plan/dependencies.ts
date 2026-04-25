import type { Phase, Plan, WorkState } from "./types";

export interface PhaseDependencyRefParts {
  planId?: string;
  phaseId: string;
}

export interface ResolvedPhaseDependency {
  plan: Plan;
  phase: Phase;
}

export type PhaseDependencyResolution =
  | { ok: true; target: ResolvedPhaseDependency }
  | { ok: false; reason: "malformed" | "missing"; message: string };

export interface PhaseDependencyBlocker {
  ref: string;
  label: string;
  reason: "malformed" | "missing" | "self" | "incomplete";
  state?: WorkState;
  /** Resolved dependency target (only present when reason === "incomplete"). */
  target?: ResolvedPhaseDependency;
}

export function parsePhaseDependencyRef(ref: string): PhaseDependencyRefParts | undefined {
  const parts = ref.split("/").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  if (parts.length === 1) {
    return { phaseId: parts[0]! };
  }
  if (parts.length === 2) {
    return { planId: parts[0]!, phaseId: parts[1]! };
  }
  return undefined;
}

export function formatPhaseDependencyTarget(target: ResolvedPhaseDependency): string {
  return `${target.plan.id}/${target.phase.id}`;
}

export function resolvePhaseDependencyRef(
  allPlans: readonly Plan[],
  currentPlan: Plan,
  ref: string,
): PhaseDependencyResolution {
  const parsed = parsePhaseDependencyRef(ref);
  if (!parsed) {
    return {
      ok: false,
      reason: "malformed",
      message: `malformed phase dependency "${ref}"`,
    };
  }

  const plan = parsed.planId ? allPlans.find((p) => p.id === parsed.planId) : currentPlan;
  const phase = plan?.phases.find((ph) => ph.id === parsed.phaseId);
  if (!plan || !phase) {
    return {
      ok: false,
      reason: "missing",
      message: `unknown phase dependency "${ref}"`,
    };
  }
  return { ok: true, target: { plan, phase } };
}

function samePhase(
  left: ResolvedPhaseDependency,
  right: { plan: Plan; phase: Phase },
): boolean {
  return left.plan.id === right.plan.id && left.phase.id === right.phase.id;
}

export function blockingPhaseDependencies(
  allPlans: readonly Plan[],
  plan: Plan,
  phase: Phase,
): PhaseDependencyBlocker[] {
  const blockers: PhaseDependencyBlocker[] = [];
  for (const ref of phase.dependsOn ?? []) {
    const resolved = resolvePhaseDependencyRef(allPlans, plan, ref);
    if (!resolved.ok) {
      blockers.push({
        ref,
        label: resolved.message,
        reason: resolved.reason,
      });
      continue;
    }
    const targetLabel = formatPhaseDependencyTarget(resolved.target);
    if (samePhase(resolved.target, { plan, phase })) {
      blockers.push({
        ref,
        label: `${targetLabel} (self)`,
        reason: "self",
      });
      continue;
    }
    if (resolved.target.phase.state !== "completed") {
      blockers.push({
        ref,
        label: `${targetLabel} (${resolved.target.phase.state})`,
        reason: "incomplete",
        state: resolved.target.phase.state,
        target: resolved.target,
      });
    }
  }
  return blockers;
}

export function formatPhaseDependencyBlockers(blockers: readonly PhaseDependencyBlocker[]): string {
  return blockers.map((blocker) => blocker.label).join(", ");
}
