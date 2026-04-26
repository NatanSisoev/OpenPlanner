import type { Plan, WorkState } from "./types";

/**
 * Roll a list of child states up into a parent state.
 *
 * Precedence (highest first):
 *   1. any `in_progress` → `in_progress`
 *   2. any `failed`      → `failed`
 *   3. all `completed`   → `completed`
 *   4. all `cancelled`   → `cancelled`
 *   5. otherwise         → `pending`
 */
export function deriveAggregateState(states: readonly WorkState[]): WorkState {
  if (states.length === 0) {
    return "pending";
  }
  if (states.some((s) => s === "in_progress")) {
    return "in_progress";
  }
  if (states.some((s) => s === "failed")) {
    return "failed";
  }
  if (states.every((s) => s === "completed")) {
    return "completed";
  }
  if (states.every((s) => s === "cancelled")) {
    return "cancelled";
  }
  return "pending";
}

/**
 * Recompute phase and plan states from the current task states. Mutates `plan`
 * in place; returns it for chaining.
 */
export function recomputeAggregates(plan: Plan): Plan {
  for (const phase of plan.phases) {
    phase.state = deriveAggregateState(phase.tasks.map((t) => t.state));
  }
  plan.state = deriveAggregateState(plan.phases.map((p) => p.state));
  return plan;
}
