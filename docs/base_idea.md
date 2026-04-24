# Plan orchestration for coding agents

## Problem

Coding agents increasingly rely on **plans**: structured breakdowns of work before or during implementation. In practice, plans are hard to manage at scale. Users lose visibility when many plans exist, cannot see how plans relate to each other, and cannot run **only part** of a large plan (for example, “do phase 2 now, defer the rest”) without rewriting or shrinking the plan manually.

## Core limitations today

1. **No single view of all plans**  
   Plans live in chat threads, files, or tool output. There is no durable, navigable registry of “what is planned, what is running, what is done” across sessions and tasks.

2. **Dependencies are implicit or lost**  
   Plan B may depend on Plan A, or on a sub-step inside A. Those relationships are usually in natural language or not captured at all, so reordering, pausing, or parallelizing work is error-prone.

3. **Execution is all-or-nothing**  
   Agents tend to execute a **whole** plan in one go, or the user must paste a **reduced** plan that omits later phases. There is no first-class notion of **phases** (milestones, gates) so the user can say: execute phase 1 only, mark phase 2 blocked, resume phase 3 tomorrow.

Together, these gaps make large initiatives fragile: hard to track, hard to slice, and hard to coordinate when multiple plans or people are involved.

## Idea (high level)

Build a **plan layer** on top of agent workflows: plans are first-class objects with **phases**, **status**, and optional **links to other plans**. A dashboard (or API) lists every plan, shows progress per phase, and lets the user **dispatch execution by phase** (or by dependency-ready subgraph) instead of only “run entire prompt.”

The agent runtime would read from this layer: which phase is authorized to run, what outputs from prior phases are inputs to the next, and what is explicitly deferred or cancelled.

## Possible extensions

- **Dependency graph** between plans (and optionally between phases), with cycle detection and “what unblocks this?” views.  
- **Delegation**: assign phases or whole plans to different people or agents and run **in parallel** where the graph allows.  
- **Blockages**: explicit blocked state, reason, and owner so work does not silently stall.  
- **Collaboration**: live sharing of plan state, comments on phases, shared handoffs between human and agent.  
- **Predictive behaviour**: suggest next phase, estimate risk, or flag when a plan diverges from earlier assumptions.  
- **Model routing**: different LLMs or tools per phase or task type (e.g. reasoning-heavy vs. codegen vs. review).

---

*HackUPC concept: turn plans from ephemeral chat text into tracked, phased, dependency-aware work units that agents and humans can execute incrementally.*
