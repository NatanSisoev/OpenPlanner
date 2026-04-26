# Plan: Add a new red (destructive-style) button
## Phase (run only this): Sidebar markup and styling

Execute only the work described in this phase description and its tasks; do not expand scope to other phases unless blocked.

Add the button next to the existing top-toolbar / create buttons pattern in planstackSidebar.js, with a dedicated CSS class in planstackSidebarWebview.ts. Use var(--vscode-errorForeground) / related theme tokens (or a documented red) so the control reads as “dangerous” without hardcoding a single theme.

### Tasks
- **task-rb-003** [pending] (commit): Insert the button HTML in planstackSidebar.js (same toolbar region as + Plan / view switchers) and add .btn-danger (or similar) rules with hover/focus for accessibility
- **task-rb-004** [pending]: Verify layout in list and node views, and that the new control does not break narrow sidebar widths or graph toolbar overflow

## Version control context
- Current checkout: feat/junie-integration
- Effective work branch (plan): planstack/plan-red-button-001
- Base branch: main

Implement the work in this repository with normal file edits (not JSON-only or plan-file output).

---
*Planstack handoff metadata — safe to delete before sending to Junie.*
planId: plan-red-button-001 · phaseId: phase-rb-002 · title: Add a new red (destructive-style) button › Sidebar markup and styling
