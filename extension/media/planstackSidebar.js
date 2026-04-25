(function () {
  const vscode = acquireVsCodeApi();

  let plans = [];
  const expandedPlans = new Set();
  const expandedPhases = new Set();
  let viewMode = "list";
  let activeContextMenu = null;
  let activeSubMenu = null;
  let activeSubMenuAnchor = null;
  let closeSubMenuTimer = null;
  let draggedPlanId = null;
  const PHASE_STATES = ["completed", "in_progress", "pending", "failed", "cancelled"];
  const phaseStatusFilter = new Set(PHASE_STATES);
  const GLOBAL_GRAPH_KEY = "__all_plans__";
  let graphExpanded = false;

  const root = document.getElementById("root");
  const graphViewState = Object.create(null);
  let activeGraphPan = null;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function taskIconHtml(state) {
    const cls = "task-icon icon-" + state;
    const icons = {
      completed:   "✓",
      in_progress: "⟳",
      failed:      "✗",
      cancelled:   "⊘",
      pending:     "○",
    };
    return `<span class="${cls}">${icons[state] || "○"}</span>`;
  }

  function badgeHtml(state) {
    const labels = {
      completed:   "done",
      in_progress: "running",
      pending:     "pending",
      failed:      "failed",
      cancelled:   "cancelled",
    };
    return `<span class="badge badge-${state}">${labels[state] || state}</span>`;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function render() {
    if (!plans.length) {
      root.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-title">No plans loaded</div>
          <div class="empty-hint">Add <code>.planstack/plans/*.json</code> to your workspace, then refresh.</div>
        </div>`;
      return;
    }
    const controls = `
      <div class="view-switcher">
        <button class="view-btn${viewMode === "list" ? " active" : ""}" data-action="switchView" data-view="list"
        >List view</button>
        <button class="view-btn${viewMode === "nodes" ? " active" : ""}" data-action="switchView" data-view="nodes"
        >View as nodes</button>
      </div>
    `;
    const body = viewMode === "nodes"
      ? renderNodesView()
      : plans.map(renderPlan).join("");
    root.innerHTML = controls + body;
    if (viewMode === "nodes") {
      syncGraphScenes();
    }
  }

  function renderNodesView() {
    const graph = buildUnifiedGraph(plans, phaseStatusFilter);
    ensureGraphState(GLOBAL_GRAPH_KEY);
    const legend = `
      <div class="graph-legend">
        <span><span class="graph-legend-dot plan"></span>plan</span>
        <span><span class="graph-legend-dot tone-failed"></span>failed</span>
        <span><span class="graph-legend-dot tone-completed"></span>completed</span>
        <span><span class="graph-legend-dot tone-in_progress"></span>running</span>
        <span><span class="graph-legend-dot tone-pending"></span>pending</span>
        <span><span class="graph-legend-dot tone-cancelled"></span>cancelled</span>
      </div>
    `;
    const filter = `
      <div class="graph-filter-row">
        <span class="graph-filter-label">Filter status</span>
        ${PHASE_STATES.map((state) => {
          const active = phaseStatusFilter.has(state) ? " active" : "";
          return `<button class="graph-filter-chip${active}" data-action="filterStatus" data-status="${state}">${state.replace("_", " ")}</button>`;
        }).join("")}
      </div>
    `;
    const expanded = graph.visiblePhases
      .filter((entry) => expandedPhases.has(entry.plan.id + "::" + entry.phase.id))
      .map((entry) => renderNodePhase(entry.plan, entry.phase))
      .join("");
    return `
      ${legend}
      ${filter}
      <section class="plan-graph-card ${graphExpanded ? "expanded" : ""}">
        <header class="plan-graph-header">
          <div class="plan-graph-title">All plans dependency map</div>
          <div class="plan-graph-meta">${graph.visiblePhases.length}/${graph.totalPhases} phases visible</div>
        </header>
        <div class="graph-viewport" data-graph="${GLOBAL_GRAPH_KEY}">
          <div class="graph-scene" data-graph="${GLOBAL_GRAPH_KEY}" style="width:${graph.width}px;height:${graph.height}px;">
            ${renderGraphEdges(graph)}
            ${graph.nodes.map((node) => renderGraphNode(node, graph)).join("")}
          </div>
        </div>
        <div class="graph-controls">
          <button class="graph-control-btn" data-action="graphZoomIn" data-graph="${GLOBAL_GRAPH_KEY}" title="Zoom in">+</button>
          <button class="graph-control-btn" data-action="graphZoomOut" data-graph="${GLOBAL_GRAPH_KEY}" title="Zoom out">-</button>
          <button class="graph-control-btn" data-action="graphZoomReset" data-graph="${GLOBAL_GRAPH_KEY}" title="Reset view">Reset</button>
          <button class="graph-control-btn" data-action="graphToggleExpand" data-graph="${GLOBAL_GRAPH_KEY}" title="Toggle chart size">${graphExpanded ? "Compact" : "Expand"}</button>
        </div>
        <div class="graph-expanded-details ${expanded ? "" : "empty"}">
          ${expanded || "<div class=\"graph-empty-hint\">Select a phase node to inspect tasks.</div>"}
        </div>
      </section>
    `;
  }

  function renderGraphNode(node, graph) {
    if (node.kind === "plan") {
      return `
        <div class="graph-plan-node tone-${node.tone}"
             style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;">
          <span class="graph-plan-kicker">plan</span>
          <span class="graph-plan-title">${esc(node.title)}</span>
        </div>
      `;
    }
    const pid = esc(node.plan.id);
    const phid = esc(node.phase.id);
    const key = node.plan.id + "::" + node.phase.id;
    const isOpen = expandedPhases.has(key);
    return `
      <div class="graph-phase-node tone-${node.phase.state} ${isOpen ? "expanded" : ""}"
           style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;">
        <button class="graph-phase-main"
                data-action="togglePhase"
                data-plan="${pid}"
                data-phase="${phid}"
                title="${esc(node.phase.title)}">
          <span class="phase-status-dot dot-${node.phase.state}"></span>
          <span class="graph-phase-title">${esc(node.phase.title)}</span>
          ${badgeHtml(node.phase.state)}
        </button>
        <div class="graph-phase-footer">
          <span class="graph-phase-plan">${esc(node.plan.title)}</span>
          <button class="run-btn graph-run-btn"
                  data-action="runPhase"
                  data-plan="${pid}"
                  data-phase="${phid}"
                  title="Run this phase">▶</button>
        </div>
      </div>
    `;
  }

  function renderGraphEdges(graph) {
    const markerId = "graph-arrow-global";
    const lines = graph.edges.map((edge) => {
      const from = graph.nodesById.get(edge.from);
      const to = graph.nodesById.get(edge.to);
      if (!from || !to) {
        return "";
      }
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const bend = Math.max(34, (endX - startX) * 0.45);
      return `<path d="M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}" marker-end="url(#${markerId})" />`;
    }).join("");
    return `
      <svg class="graph-edges" viewBox="0 0 ${graph.width} ${graph.height}" aria-hidden="true">
        <defs>
          <marker id="${markerId}" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
            <path d="M0,0 L10,4 L0,8 z"></path>
          </marker>
        </defs>
        ${lines}
      </svg>
    `;
  }

  function buildUnifiedGraph(allPlans, filterSet) {
    const planOrder = new Map(allPlans.map((plan, idx) => [plan.id, idx]));
    const phaseEntries = [];
    const phaseNodeIdByLocal = new Map();
    const phaseNodeIdsByRawId = new Map();

    allPlans.forEach((plan, planIdx) => {
      const phases = Array.isArray(plan.phases) ? plan.phases : [];
      phases.forEach((phase, phaseIdx) => {
        const nodeId = "phase::" + plan.id + "::" + phase.id;
        phaseEntries.push({ nodeId, plan, phase, planIdx, phaseIdx });
        phaseNodeIdByLocal.set(plan.id + "::" + phase.id, nodeId);
        if (!phaseNodeIdsByRawId.has(phase.id)) {
          phaseNodeIdsByRawId.set(phase.id, []);
        }
        phaseNodeIdsByRawId.get(phase.id).push(nodeId);
      });
    });

    const visiblePhases = phaseEntries.filter((entry) => filterSet.has(entry.phase.state));
    const visiblePhaseIds = new Set(visiblePhases.map((entry) => entry.nodeId));
    const dependencyEdges = [];
    const incoming = new Map();
    const outgoing = new Map();

    visiblePhases.forEach((entry) => {
      incoming.set(entry.nodeId, 0);
      outgoing.set(entry.nodeId, []);
    });

    visiblePhases.forEach((entry) => {
      const deps = Array.isArray(entry.phase.dependsOn) ? entry.phase.dependsOn : [];
      deps.forEach((depId) => {
        let sourceId = phaseNodeIdByLocal.get(entry.plan.id + "::" + depId) || null;
        if (!sourceId) {
          const matches = phaseNodeIdsByRawId.get(depId) || [];
          if (matches.length === 1) {
            sourceId = matches[0];
          }
        }
        if (!sourceId || !visiblePhaseIds.has(sourceId)) {
          return;
        }
        dependencyEdges.push({ from: sourceId, to: entry.nodeId });
        incoming.set(entry.nodeId, (incoming.get(entry.nodeId) || 0) + 1);
        outgoing.get(sourceId).push(entry.nodeId);
      });
    });

    const queue = visiblePhases
      .filter((entry) => (incoming.get(entry.nodeId) || 0) === 0)
      .sort((a, b) => (a.planIdx - b.planIdx) || (a.phaseIdx - b.phaseIdx))
      .map((entry) => entry.nodeId);
    const levels = new Map();
    queue.forEach((nodeId) => levels.set(nodeId, 0));
    while (queue.length) {
      const nodeId = queue.shift();
      const nextLevel = levels.get(nodeId) || 0;
      (outgoing.get(nodeId) || []).forEach((toNodeId) => {
        levels.set(toNodeId, Math.max(levels.get(toNodeId) || 0, nextLevel + 1));
        const remaining = (incoming.get(toNodeId) || 0) - 1;
        incoming.set(toNodeId, remaining);
        if (remaining === 0) {
          queue.push(toNodeId);
        }
      });
    }
    visiblePhases.forEach((entry) => {
      if (!levels.has(entry.nodeId)) {
        levels.set(entry.nodeId, 0);
      }
    });

    const planNodes = allPlans.map((plan) => {
      const { tone } = derivePlanNodeTone(plan);
      return {
        id: "plan::" + plan.id,
        kind: "plan",
        title: plan.title,
        tone,
        plan,
        level: 0,
      };
    });

    const incomingVisibleByPlan = new Map();
    visiblePhases.forEach((entry) => incomingVisibleByPlan.set(entry.nodeId, 0));
    dependencyEdges.forEach((edge) => {
      incomingVisibleByPlan.set(edge.to, (incomingVisibleByPlan.get(edge.to) || 0) + 1);
    });
    const planEdges = [];
    allPlans.forEach((plan) => {
      const roots = visiblePhases.filter(
        (entry) => entry.plan.id === plan.id && (incomingVisibleByPlan.get(entry.nodeId) || 0) === 0,
      );
      roots.forEach((entry) => {
        planEdges.push({ from: "plan::" + plan.id, to: entry.nodeId });
      });
    });

    const phaseNodes = visiblePhases.map((entry) => ({
      id: entry.nodeId,
      kind: "phase",
      plan: entry.plan,
      phase: entry.phase,
      level: 1 + (levels.get(entry.nodeId) || 0),
      planIdx: entry.planIdx,
      phaseIdx: entry.phaseIdx,
    }));

    const allNodes = [...planNodes, ...phaseNodes];
    const buckets = new Map();
    allNodes.forEach((node) => {
      if (!buckets.has(node.level)) {
        buckets.set(node.level, []);
      }
      buckets.get(node.level).push(node);
    });
    const sortedLevels = [...buckets.keys()].sort((a, b) => a - b);
    sortedLevels.forEach((level) => {
      buckets.get(level).sort((a, b) => {
        const aPlan = planOrder.get(a.plan?.id || a.id.replace(/^plan::/, "")) || 0;
        const bPlan = planOrder.get(b.plan?.id || b.id.replace(/^plan::/, "")) || 0;
        const aPhase = a.phaseIdx || 0;
        const bPhase = b.phaseIdx || 0;
        return (aPlan - bPlan) || aPhase - bPhase;
      });
    });

    const nodeWidth = 224;
    const planNodeHeight = 74;
    const phaseNodeHeight = 94;
    const columnGap = 312;
    const rowGap = 132;
    const padding = 44;
    const maxRows = Math.max(1, ...sortedLevels.map((level) => buckets.get(level).length));
    const nodes = [];
    sortedLevels.forEach((level, levelIndex) => {
      const list = buckets.get(level);
      const ySpan = (list.length - 1) * rowGap;
      const yStart = padding + ((maxRows - 1) * rowGap - ySpan) / 2;
      list.forEach((node, idx) => {
        const height = node.kind === "plan" ? planNodeHeight : phaseNodeHeight;
        nodes.push({
          ...node,
          x: padding + levelIndex * columnGap,
          y: yStart + idx * rowGap,
          width: nodeWidth,
          height,
        });
      });
    });

    const levelCount = Math.max(1, sortedLevels.length);
    const width = padding * 2 + (levelCount - 1) * columnGap + nodeWidth;
    const height = padding * 2 + (maxRows - 1) * rowGap + phaseNodeHeight;
    const edges = [...planEdges, ...dependencyEdges];
    return {
      width,
      height,
      nodes,
      edges,
      totalPhases: phaseEntries.length,
      visiblePhases,
      nodesById: new Map(nodes.map((node) => [node.id, node])),
    };
  }

  function ensureGraphState(graphId) {
    if (!graphViewState[graphId]) {
      graphViewState[graphId] = { x: 22, y: 18, scale: 1 };
    }
    return graphViewState[graphId];
  }

  function applyGraphSceneTransform(graphId) {
    const scene = [...document.querySelectorAll(".graph-scene[data-graph]")].find((el) => el.dataset.graph === graphId);
    if (!scene) {
      return;
    }
    const state = ensureGraphState(graphId);
    scene.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  }

  function syncGraphScenes() {
    document.querySelectorAll(".graph-scene[data-graph]").forEach((scene) => {
      const graphId = scene.dataset.graph;
      if (!graphId) {
        return;
      }
      applyGraphSceneTransform(graphId);
    });
  }

  function renderNodePhase(plan, phase) {
    const pid = esc(plan.id);
    const phid = esc(phase.id);
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    return `
      <div class="node-phase-block">
        <div class="phase-header node-phase-header" data-plan="${pid}" data-phase="${phid}">
          <div class="phase-header-left">
            <span class="phase-status-dot dot-${phase.state}"></span>
            <span class="phase-title">${esc(phase.title)}</span>
          </div>
          <div class="phase-header-right">
            ${badgeHtml(phase.state)}
            <button class="run-btn" data-action="runPhase" data-plan="${pid}" data-phase="${phid}" title="Run this phase">▶ Run</button>
          </div>
        </div>
        <div class="phase-tasks node-phase-tasks">
          ${tasks.map((task) => renderTask(plan, phase, task)).join("")}
        </div>
      </div>
    `;
  }

  function derivePlanNodeTone(plan) {
    const phases = Array.isArray(plan.phases) ? plan.phases : [];
    const tasks = phases.flatMap((phase) => (Array.isArray(phase.tasks) ? phase.tasks : []));
    if (!tasks.length) {
      return { tone: "pending" };
    }
    if (tasks.some((task) => task.state === "failed")) {
      return { tone: "failed" };
    }
    if (tasks.every((task) => task.state === "completed")) {
      return { tone: "completed" };
    }
    if (tasks.some((task) => task.state === "in_progress")) {
      return { tone: "in_progress" };
    }
    return { tone: "pending" };
  }

  function renderPlan(plan) {
    const isOpen = expandedPlans.has(plan.id);
    const phases = plan.phases || [];
    const done = phases.filter((p) => p.state === "completed").length;
    const total = phases.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const pid = esc(plan.id);
    const canMergePlan = plan.state === "completed" && !!plan.git?.planBranch;
    const mergeButton = canMergePlan
      ? `<button class="run-btn"
                 data-action="mergePlan"
                 data-plan="${pid}"
                 title="Merge ${esc(plan.git.planBranch)} into ${esc(plan.git?.baseBranch || "main")}">⇢ Merge</button>`
      : "";

    return `
      <div class="plan-card">
        <div class="plan-header" data-action="togglePlan" data-plan="${pid}" draggable="true" title="Drag to reorder">
          <div class="plan-header-left">
            <span class="chevron${isOpen ? " expanded" : ""}">›</span>
            <span class="plan-title">${esc(plan.title)}</span>
          </div>
          <div class="plan-header-right">
            <span class="plan-progress">${done}/${total}</span>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            ${mergeButton}
            <button class="run-btn" data-action="runPlan" data-plan="${pid}" title="Run next phase">▶ Run</button>
          </div>
        </div>
        ${isOpen ? `<div class="plan-phases">${phases.map((ph) => renderPhase(plan, ph)).join("")}</div>` : ""}
      </div>`;
  }

  function blockingDeps(plan, phase) {
    if (!phase.dependsOn || phase.dependsOn.length === 0) {
      return [];
    }
    const byId = new Map((plan.phases || []).map((p) => [p.id, p]));
    return phase.dependsOn.filter((id) => {
      const dep = byId.get(id);
      return !dep || dep.state !== "completed";
    });
  }

  function renderPhase(plan, phase) {
    const key = plan.id + "::" + phase.id;
    const isOpen = expandedPhases.has(key);
    const tasks = phase.tasks || [];
    const hasTasks = tasks.length > 0;
    const pid = esc(plan.id);
    const phid = esc(phase.id);

    const blockers = blockingDeps(plan, phase);
    const isBlocked = blockers.length > 0;
    const blockedTitle = isBlocked ? `Blocked by: ${blockers.join(", ")}` : "Run this phase";

    return `
      <div class="phase-row">
        <div class="phase-header${isBlocked ? " blocked" : ""}" data-plan="${pid}" data-phase="${phid}">
          <div class="phase-header-left"
               ${hasTasks ? `data-action="togglePhase" data-plan="${pid}" data-phase="${phid}"` : ""}>
            ${hasTasks
              ? `<span class="chevron sm${isOpen ? " expanded" : ""}">›</span>`
              : `<span class="chevron-gap"></span>`}
            <span class="phase-status-dot dot-${phase.state}"></span>
            <span class="phase-title">${esc(phase.title)}</span>
            ${isBlocked ? `<span class="phase-blocked-hint">· blocked by ${esc(blockers.join(", "))}</span>` : ""}
          </div>
          <div class="phase-header-right">
            ${badgeHtml(phase.state)}
            <button class="run-btn"
                    data-action="runPhase" data-plan="${pid}" data-phase="${phid}"
                    title="${esc(blockedTitle)}">▶ Run</button>
          </div>
        </div>
        ${hasTasks && isOpen
          ? `<div class="phase-tasks">${tasks.map((t) => renderTask(plan, phase, t)).join("")}</div>`
          : ""}
      </div>`;
  }

  function renderTask(plan, phase, task) {
    const isCancelled = task.state === "cancelled";
    const isCompleted = task.state === "completed";
    const isRunning = task.state === "in_progress";
    const pid = esc(plan.id);
    const phid = esc(phase.id);
    const tid = esc(task.id);

    const btns = [];
    if (!isCompleted && !isCancelled) {
      btns.push(`<button class="task-btn done-btn" data-action="taskStatus"
                   data-plan="${pid}" data-phase="${phid}" data-task="${tid}" data-status="completed"
                   title="Mark done">✓</button>`);
    }
    btns.push(`<button class="task-btn run-task" data-action="taskRun"
                 data-plan="${pid}" data-phase="${phid}" data-task="${tid}"
                 ${isRunning ? "disabled" : ""}
                 title="${isRunning ? "Already running" : "Run task"}">▶</button>`);
    if (!isCompleted && !isCancelled) {
      btns.push(`<button class="task-btn cancel-btn" data-action="taskStatus"
                   data-plan="${pid}" data-phase="${phid}" data-task="${tid}" data-status="cancelled"
                   title="Cancel">✗</button>`);
    }
    if (isCancelled || task.state === "failed") {
      btns.push(`<button class="task-btn reset-btn" data-action="taskStatus"
                   data-plan="${pid}" data-phase="${phid}" data-task="${tid}" data-status="pending"
                   title="Reset">↺</button>`);
    }

    return `
      <div class="task-row" data-plan="${pid}" data-phase="${phid}" data-task="${tid}">
        ${taskIconHtml(task.state)}
        <span class="task-title${isCancelled ? " strike" : ""}">${esc(task.desc)}</span>
        <div class="task-actions">${btns.join("")}</div>
      </div>`;
  }

  // ── Event delegation ─────────────────────────────────────────────────────

  document.addEventListener("click", (e) => {
    hideContextMenu();
    const el = e.target.closest("[data-action]");
    if (!el) {
      return;
    }
    const action = el.dataset.action;
    const planId = el.dataset.plan;
    const phaseId = el.dataset.phase;
    const taskId = el.dataset.task;
    const graphId = el.dataset.graph;

    if (action === "togglePlan") {
      if (expandedPlans.has(planId)) {
        expandedPlans.delete(planId);
      } else {
        expandedPlans.add(planId);
      }
      render();
      return;
    }

    if (action === "switchView") {
      const nextView = el.dataset.view;
      if (nextView === "list" || nextView === "nodes") {
        viewMode = nextView;
        render();
      }
      return;
    }

    if (action === "filterStatus") {
      const status = el.dataset.status;
      if (!PHASE_STATES.includes(status)) {
        return;
      }
      if (phaseStatusFilter.has(status)) {
        if (phaseStatusFilter.size > 1) {
          phaseStatusFilter.delete(status);
        }
      } else {
        phaseStatusFilter.add(status);
      }
      render();
      return;
    }

    if (action === "graphZoomIn" || action === "graphZoomOut" || action === "graphZoomReset") {
      const state = ensureGraphState(graphId || GLOBAL_GRAPH_KEY);
      if (action === "graphZoomReset") {
        state.scale = 1;
        state.x = 22;
        state.y = 18;
      } else {
        const factor = action === "graphZoomIn" ? 1.14 : 0.88;
        state.scale = Math.min(1.95, Math.max(0.55, state.scale * factor));
      }
      applyGraphSceneTransform(graphId || GLOBAL_GRAPH_KEY);
      return;
    }

    if (action === "graphToggleExpand") {
      graphExpanded = !graphExpanded;
      render();
      return;
    }

    if (action === "togglePhase") {
      const key = planId + "::" + phaseId;
      if (expandedPhases.has(key)) {
        expandedPhases.delete(key);
      } else {
        expandedPhases.add(key);
      }
      render();
      return;
    }

    if (action === "runPhase") {
      e.stopPropagation();
      // Optimistic local update + persist phase running state
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      if (phase) {
        phase.state = "in_progress";
        vscode.postMessage({ type: "updatePhase", planId, phaseId, state: "in_progress" });
        render();
      }
      vscode.postMessage({ type: "runPhase", planId, phaseId });
      return;
    }

    if (action === "runPlan") {
      e.stopPropagation();
      const plan = plans.find((p) => p.id === planId);
      const phases = plan?.phases || [];
      const next =
        phases.find((ph) => ph.state !== "completed" && ph.state !== "cancelled") || phases[0];
      if (!next) {
        return;
      }
      next.state = "in_progress";
      vscode.postMessage({ type: "updatePhase", planId, phaseId: next.id, state: "in_progress" });
      render();
      vscode.postMessage({ type: "runPhase", planId, phaseId: next.id });
      return;
    }

    if (action === "mergePlan") {
      e.stopPropagation();
      vscode.postMessage({ type: "mergePlan", planId });
      return;
    }

    if (action === "taskRun") {
      e.stopPropagation();
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      const task = phase?.tasks?.find((t) => t.id === taskId);
      if (task && task.state !== "in_progress") {
        task.state = "in_progress";
        vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, state: "in_progress" });
        render();
      }
      return;
    }

    if (action === "taskStatus") {
      e.stopPropagation();
      const newState = el.dataset.status;
      vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, state: newState });
      // Optimistic local update
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      const task = phase?.tasks?.find((t) => t.id === taskId);
      if (task) {
        task.state = newState;
        render();
      }
    }
  });

  document.addEventListener("wheel", (e) => {
    if (viewMode !== "nodes") {
      return;
    }
    const viewport = e.target.closest(".graph-viewport");
    if (!viewport) {
      return;
    }
    e.preventDefault();
    const graphId = viewport.dataset.graph;
    if (!graphId) {
      return;
    }
    const state = ensureGraphState(graphId);
    const rect = viewport.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const worldX = (cursorX - state.x) / state.scale;
    const worldY = (cursorY - state.y) / state.scale;
    const zoomFactor = e.deltaY < 0 ? 1.09 : 0.91;
    const nextScale = Math.min(1.95, Math.max(0.55, state.scale * zoomFactor));
    state.x = cursorX - worldX * nextScale;
    state.y = cursorY - worldY * nextScale;
    state.scale = nextScale;
    applyGraphSceneTransform(graphId);
  }, { passive: false });

  document.addEventListener("pointerdown", (e) => {
    if (viewMode !== "nodes") {
      return;
    }
    const viewport = e.target.closest(".graph-viewport");
    if (!viewport || e.target.closest("[data-action]")) {
      return;
    }
    const graphId = viewport.dataset.graph;
    if (!graphId) {
      return;
    }
    activeGraphPan = { graphId, startX: e.clientX, startY: e.clientY };
    viewport.classList.add("is-panning");
  });

  document.addEventListener("pointermove", (e) => {
    if (!activeGraphPan) {
      return;
    }
    const state = ensureGraphState(activeGraphPan.graphId);
    state.x += e.clientX - activeGraphPan.startX;
    state.y += e.clientY - activeGraphPan.startY;
    activeGraphPan.startX = e.clientX;
    activeGraphPan.startY = e.clientY;
    applyGraphSceneTransform(activeGraphPan.graphId);
  });

  document.addEventListener("pointerup", () => {
    if (!activeGraphPan) {
      return;
    }
    const viewport = [...document.querySelectorAll(".graph-viewport[data-graph]")]
      .find((el) => el.dataset.graph === activeGraphPan.graphId);
    if (viewport) {
      viewport.classList.remove("is-panning");
    }
    activeGraphPan = null;
  });

  // ── Plan drag & drop ordering ────────────────────────────────────────────

  document.addEventListener("dragstart", (e) => {
    const header = e.target.closest(".plan-header");
    if (!header) {
      return;
    }
    const planId = header.dataset.plan;
    if (!planId) {
      return;
    }
    draggedPlanId = planId;
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", planId);
    } catch {
      // ignore
    }
    header.classList.add("dragging");
  });

  document.addEventListener("dragend", (e) => {
    const header = e.target.closest(".plan-header");
    if (header) {
      header.classList.remove("dragging");
    }
    document.querySelectorAll(".plan-header.drag-over").forEach((el) => el.classList.remove("drag-over"));
    draggedPlanId = null;
  });

  document.addEventListener("dragover", (e) => {
    const header = e.target.closest(".plan-header");
    if (!header || !draggedPlanId || viewMode !== "list") {
      return;
    }
    e.preventDefault();
    header.classList.add("drag-over");
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      // ignore
    }
  });

  document.addEventListener("dragleave", (e) => {
    const header = e.target.closest(".plan-header");
    if (header) {
      header.classList.remove("drag-over");
    }
  });

  document.addEventListener("drop", (e) => {
    const header = e.target.closest(".plan-header");
    if (!header || !draggedPlanId || viewMode !== "list") {
      return;
    }
    e.preventDefault();
    const targetId = header.dataset.plan;
    if (!targetId || targetId === draggedPlanId) {
      header.classList.remove("drag-over");
      return;
    }
    header.classList.remove("drag-over");

    const ids = plans.map((p) => p.id);
    const from = ids.indexOf(draggedPlanId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) {
      return;
    }
    ids.splice(from, 1);
    ids.splice(to, 0, draggedPlanId);

    const byId = new Map(plans.map((p) => [p.id, p]));
    plans = ids.map((id) => byId.get(id)).filter(Boolean);
    render();
    vscode.postMessage({ type: "reorderPlans", orderedPlanIds: ids });
  });

  document.addEventListener("contextmenu", (e) => {
    hideContextMenu();
    if (e.target.closest("button")) {
      return;
    }
    const taskRow = e.target.closest(".task-row");
    if (taskRow) {
      e.preventDefault();
      openTaskContextMenu(e, taskRow);
      return;
    }
    const phaseHeader = e.target.closest(".phase-header");
    if (!phaseHeader) {
      return;
    }
    e.preventDefault();
    openPhaseContextMenu(e, phaseHeader);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();
    }
  });

  function openTaskContextMenu(event, row) {
    const planId = row.dataset.plan;
    const phaseId = row.dataset.phase;
    const taskId = row.dataset.task;
    if (!planId || !phaseId || !taskId) {
      return;
    }
    const task = getTask(planId, phaseId, taskId);
    if (!task) {
      return;
    }

    const stateMenuItems = [
      {
        label: "pending",
        onClick: () => updateTaskState(planId, phaseId, taskId, "pending"),
      },
      {
        label: "in progress",
        onClick: () => updateTaskState(planId, phaseId, taskId, "in_progress"),
      },
      {
        label: "completed",
        onClick: () => updateTaskState(planId, phaseId, taskId, "completed"),
      },
      {
        label: "failed",
        onClick: () => updateTaskState(planId, phaseId, taskId, "failed"),
      },
      {
        label: "cancelled",
        onClick: () => updateTaskState(planId, phaseId, taskId, "cancelled"),
      },
    ];

    const menu = createContextMenu(event.clientX, event.clientY, [
      {
        label: "Open task details",
        onClick: () => vscode.postMessage({ type: "openTaskDetails", planId, phaseId, taskId }),
      },
      {
        label: "Rename task",
        onClick: () => {
          const nextDesc = prompt("Task description", task.desc || "");
          if (nextDesc === null) {
            return;
          }
          const trimmed = nextDesc.trim();
          if (!trimmed) {
            return;
          }
          task.desc = trimmed;
          vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, desc: trimmed });
          render();
        },
      },
      {
        label: task.commit ? "Disable commit requirement" : "Enable commit requirement",
        onClick: () => {
          const nextCommit = !Boolean(task.commit);
          task.commit = nextCommit;
          vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, commit: nextCommit });
          render();
        },
      },
      {
        label: "Edit task prompt",
        onClick: () => {
          const nextPrompt = prompt("Task prompt", task.prompt || "");
          if (nextPrompt === null) {
            return;
          }
          task.prompt = nextPrompt;
          vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, prompt: nextPrompt });
          render();
        },
      },
      {
        label: "Set state",
        submenu: stateMenuItems,
      },
    ]);
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function openPhaseContextMenu(event, phaseHeader) {
    const planId = phaseHeader.dataset.plan;
    const phaseId = phaseHeader.dataset.phase;
    if (!planId || !phaseId) {
      return;
    }
    const phase = getPhase(planId, phaseId);
    if (!phase) {
      return;
    }
    const taskCount = Array.isArray(phase.tasks) ? phase.tasks.length : 0;
    const menu = createContextMenu(event.clientX, event.clientY, [
      {
        label: `Phase info (${phase.state})`,
        onClick: () => vscode.postMessage({ type: "openPhaseDetails", planId, phaseId }),
      },
      {
        label: `Show tasks (${taskCount})`,
        onClick: () => {
          const key = planId + "::" + phaseId;
          expandedPhases.add(key);
          render();
          vscode.postMessage({ type: "openPhaseDetails", planId, phaseId });
        },
      },
      {
        label: expandedPhases.has(planId + "::" + phaseId) ? "Collapse tasks" : "Expand tasks",
        onClick: () => {
          const key = planId + "::" + phaseId;
          if (expandedPhases.has(key)) {
            expandedPhases.delete(key);
          } else {
            expandedPhases.add(key);
          }
          render();
        },
      },
    ]);
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function updateTaskState(planId, phaseId, taskId, newState) {
    const task = getTask(planId, phaseId, taskId);
    if (!task) {
      return;
    }
    task.state = newState;
    vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, state: newState });
    render();
  }

  function getPhase(planId, phaseId) {
    const plan = plans.find((p) => p.id === planId);
    return plan?.phases?.find((ph) => ph.id === phaseId);
  }

  function getTask(planId, phaseId, taskId) {
    const phase = getPhase(planId, phaseId);
    return phase?.tasks?.find((t) => t.id === taskId);
  }

  function hideContextMenu() {
    if (closeSubMenuTimer) {
      clearTimeout(closeSubMenuTimer);
      closeSubMenuTimer = null;
    }
    if (activeSubMenu && activeSubMenu.parentNode) {
      activeSubMenu.parentNode.removeChild(activeSubMenu);
    }
    activeSubMenu = null;
    activeSubMenuAnchor = null;
    if (activeContextMenu && activeContextMenu.parentNode) {
      activeContextMenu.parentNode.removeChild(activeContextMenu);
    }
    activeContextMenu = null;
  }

  function scheduleCloseSubMenu() {
    if (closeSubMenuTimer) {
      clearTimeout(closeSubMenuTimer);
    }
    closeSubMenuTimer = setTimeout(() => {
      if (activeSubMenu && activeSubMenu.parentNode) {
        activeSubMenu.parentNode.removeChild(activeSubMenu);
      }
      activeSubMenu = null;
      activeSubMenuAnchor = null;
      closeSubMenuTimer = null;
    }, 220);
  }

  function cancelCloseSubMenu() {
    if (closeSubMenuTimer) {
      clearTimeout(closeSubMenuTimer);
      closeSubMenuTimer = null;
    }
  }

  function createContextMenu(x, y, items) {
    const menu = document.createElement("div");
    menu.style.position = "fixed";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.style.minWidth = "220px";
    menu.style.maxWidth = "320px";
    menu.style.background = "var(--vscode-menu-background, var(--vscode-editor-background))";
    menu.style.color = "var(--vscode-menu-foreground, var(--vscode-foreground))";
    menu.style.border = "1px solid var(--vscode-menu-border, rgba(127,127,127,0.4))";
    menu.style.borderRadius = "6px";
    menu.style.padding = "4px 0";
    menu.style.zIndex = "9999";
    menu.style.boxShadow = "0 4px 14px rgba(0,0,0,0.35)";
    menu.style.userSelect = "none";

    items.forEach((item) => {
      const line = document.createElement("button");
      line.type = "button";
      line.textContent = item.submenu ? item.label + " \u203a" : item.label;
      line.style.display = "block";
      line.style.width = "100%";
      line.style.textAlign = "left";
      line.style.padding = "6px 10px";
      line.style.background = "transparent";
      line.style.border = "none";
      line.style.color = "inherit";
      line.style.font = "inherit";
      line.style.cursor = "pointer";
      line.addEventListener("mouseenter", () => {
        line.style.background = "var(--vscode-list-hoverBackground, rgba(127,127,127,0.2))";
        if (item.submenu) {
          cancelCloseSubMenu();
          if (activeSubMenu && activeSubMenu.parentNode && activeSubMenuAnchor !== line) {
            activeSubMenu.parentNode.removeChild(activeSubMenu);
            activeSubMenu = null;
          }
          if (!activeSubMenu) {
            const rect = line.getBoundingClientRect();
            activeSubMenu = createContextMenu(rect.right - 1, rect.top, item.submenu);
            activeSubMenu.addEventListener("mouseenter", cancelCloseSubMenu);
            activeSubMenu.addEventListener("mouseleave", scheduleCloseSubMenu);
            document.body.appendChild(activeSubMenu);
          }
          activeSubMenuAnchor = line;
        }
      });
      line.addEventListener("mouseleave", () => {
        line.style.background = "transparent";
        if (item.submenu) {
          scheduleCloseSubMenu();
        }
      });
      line.addEventListener("click", () => {
        if (item.submenu) {
          return;
        }
        hideContextMenu();
        if (typeof item.onClick === "function") {
          item.onClick();
        }
      });
      menu.appendChild(line);
    });
    return menu;
  }

  // ── Message handler ──────────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "setPlans") {
      plans = msg.plans || [];
      plans.forEach((p) => expandedPlans.add(p.id));
      render();
    }
  });
})();
