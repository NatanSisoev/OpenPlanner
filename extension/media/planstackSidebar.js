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
  let wizardState = null;
  const PHASE_STATES = ["completed", "in_progress", "pending", "failed", "cancelled"];
  const phaseStatusFilter = new Set(PHASE_STATES);
  const GLOBAL_GRAPH_KEY = "__all_plans__";
  let graphExpanded = false;
  let selectedPhaseKey = null;

  const root = document.getElementById("root");
  const wizardOverlay = document.getElementById("wizardOverlay");
  const wizardTitle = document.getElementById("wizardTitle");
  const wizardStep = document.getElementById("wizardStep");
  const wizardBody = document.getElementById("wizardBody");
  const wizardError = document.getElementById("wizardError");
  const wizardPrimary = document.getElementById("wizardPrimary");
  const wizardSecondary = document.getElementById("wizardSecondary");
  const graphViewState = Object.create(null);
  let activeGraphPan = null;
  let mutationSeq = 0;
  const pendingMutations = new Map();

  // ── Helpers ─────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const STATE_CYCLE = ["pending", "in_progress", "completed", "failed", "cancelled"];
  function nextStateInCycle(state) {
    const i = STATE_CYCLE.indexOf(state);
    return STATE_CYCLE[(i === -1 ? 0 : i + 1) % STATE_CYCLE.length];
  }

  function taskIconHtml(state, planId, phaseId, taskId) {
    const cls = "task-icon icon-" + state;
    const icons = {
      completed:   "✓",
      in_progress: "⟳",
      failed:      "✗",
      cancelled:   "⊘",
      pending:     "○",
    };
    const symbol = icons[state] || "○";
    const next = nextStateInCycle(state);
    return `<span class="${cls}" role="button" tabindex="0" data-action="cycleTaskState" data-plan="${planId}" data-phase="${phaseId}" data-task="${taskId}" title="Click to set: ${next.replace("_", " ")}">${symbol}</span>`;
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

  function nextMutationId() {
    mutationSeq += 1;
    return "m" + mutationSeq;
  }

  function sendTaskStateMutation(planId, phaseId, taskId, nextState) {
    const plan = plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    const task = phase?.tasks?.find((t) => t.id === taskId);
    if (!task) {
      return;
    }
    const prevState = task.state;
    task.state = nextState;
    const requestId = nextMutationId();
    pendingMutations.set(requestId, { kind: "task", planId, phaseId, taskId, prevState });
    vscode.postMessage({ type: "updateTask", requestId, planId, phaseId, taskId, state: nextState });
    render();
  }

  function sendPhaseStateMutation(planId, phaseId, nextState) {
    const plan = plans.find((p) => p.id === planId);
    const phase = plan?.phases?.find((ph) => ph.id === phaseId);
    if (!phase) {
      return;
    }
    const prevState = phase.state;
    phase.state = nextState;
    const requestId = nextMutationId();
    pendingMutations.set(requestId, { kind: "phase", planId, phaseId, prevState });
    vscode.postMessage({ type: "updatePhase", requestId, planId, phaseId, state: nextState });
    render();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function render() {
    if (!plans.length) {
      root.innerHTML = `
        ${renderToolbar(true)}
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-title">No plans loaded</div>
          <div class="empty-hint">Create your first plan or add <code>.planstack/plans/*.json</code> to your workspace.</div>
        </div>`;
      return;
    }
    const controls = renderToolbar(false);
    const body = viewMode === "nodes"
      ? renderNodesView()
      : plans.map(renderPlan).join("");
    root.innerHTML = controls + body;
    if (viewMode === "nodes") {
      syncGraphScenes();
    }
  }

  function renderToolbar(onlyCreate) {
    const createButtons = `
      <div class="toolbar-group">
        <button class="quick-btn" data-action="quickCreatePlan">+ Plan</button>
        <button class="quick-btn" data-action="quickCreatePhase">+ Phase</button>
        <button class="quick-btn" data-action="quickCreateTask">+ Task</button>
      </div>
    `;
    if (onlyCreate) {
      return `<div class="top-toolbar">${createButtons}</div>`;
    }
    return `
      <div class="top-toolbar">
        ${createButtons}
        <div class="toolbar-divider"></div>
        <div class="toolbar-row">
          <div class="toolbar-group">
            <button class="view-btn${viewMode === "list" ? " active" : ""}" data-action="switchView" data-view="list">List view</button>
            <button class="view-btn${viewMode === "nodes" ? " active" : ""}" data-action="switchView" data-view="nodes">View as nodes</button>
          </div>
          <div class="toolbar-group toolbar-group-right">
            <button class="view-btn" data-action="syncPull" title="Pull all plans from remote server">Pull</button>
            <button class="view-btn" data-action="syncPush" title="Push all plans to remote server">Push</button>
          </div>
        </div>
      </div>
    `;
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
        <span><span class="graph-legend-line"></span>dependency</span>
        <span><span class="graph-legend-line selected"></span>selected phase's deps</span>
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
    const visibleKeys = new Set(graph.visiblePhases.map((e) => e.plan.id + "::" + e.phase.id));
    if (selectedPhaseKey && !visibleKeys.has(selectedPhaseKey)) {
      selectedPhaseKey = null;
    }
    const selectedEntry = selectedPhaseKey
      ? graph.visiblePhases.find((e) => (e.plan.id + "::" + e.phase.id) === selectedPhaseKey)
      : null;
    const expanded = selectedEntry ? renderNodePhase(selectedEntry.plan, selectedEntry.phase) : "";
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
          ${selectedPhaseKey ? `<button class="graph-control-btn" data-action="graphClearSelection" title="Show all dependencies again">Clear selection</button>` : ""}
          <button class="graph-control-btn" data-action="graphZoomIn" data-graph="${GLOBAL_GRAPH_KEY}" title="Zoom in">+</button>
          <button class="graph-control-btn" data-action="graphZoomOut" data-graph="${GLOBAL_GRAPH_KEY}" title="Zoom out">-</button>
          <button class="graph-control-btn" data-action="graphZoomReset" data-graph="${GLOBAL_GRAPH_KEY}" title="Reset view">Reset</button>
          <button class="graph-control-btn" data-action="graphToggleExpand" data-graph="${GLOBAL_GRAPH_KEY}" title="Toggle chart size">${graphExpanded ? "Compact" : "Expand"}</button>
        </div>
        <div class="graph-expanded-details ${expanded ? "" : "empty"}">
          ${expanded || "<div class=\"graph-empty-hint\">Click a phase node to view its tasks here. Select another node to switch.</div>"}
        </div>
      </section>
    `;
  }

  function renderGraphNode(node, graph) {
    if (node.kind === "plan") {
      const pid = esc(node.plan.id);
      return `
        <div class="graph-plan-node tone-${node.tone}"
             style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;">
          <span class="graph-node-stripe tone-${node.tone}" aria-hidden="true"></span>
          <div class="graph-plan-body">
            <div class="graph-plan-row">
              <span class="graph-plan-kicker">PLAN</span>
              <button class="run-btn graph-run-btn graph-plan-run-btn"
                      data-action="runPlanFromGraph"
                      data-plan="${pid}"
                      title="Run all phases in order">▶ Run</button>
            </div>
            <span class="graph-plan-title">${esc(node.title)}</span>
            <code class="graph-node-id">${pid}</code>
          </div>
        </div>
      `;
    }
    const pid = esc(node.plan.id);
    const phid = esc(node.phase.id);
    const key = node.plan.id + "::" + node.phase.id;
    const isSelected = selectedPhaseKey === key;
    const depSummary = phaseDependencySummary(node.plan, node.phase);
    const state = node.phase.state;
    return `
      <div class="graph-phase-node tone-${state} ${isSelected ? "selected" : ""}"
           style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;">
        <span class="graph-node-stripe tone-${state}" aria-hidden="true"></span>
        <button class="graph-phase-main"
                data-action="selectGraphPhase"
                data-plan="${pid}"
                data-phase="${phid}"
                title="Click to highlight its dependencies. Click again to deselect.">
          <header class="graph-phase-head">
            <code class="graph-node-id">${phid}</code>
            ${badgeHtml(state)}
          </header>
          <div class="graph-phase-title">${esc(node.phase.title)}</div>
          ${depSummary.short
            ? `<div class="graph-phase-deps-chip" title="${esc(depSummary.title)}"><span class="chip-glyph">⇠</span>${esc(depSummary.short)}</div>`
            : ""}
        </button>
        <footer class="graph-phase-footer">
          <span class="graph-phase-plan" title="${esc(node.plan.title)}">${esc(node.plan.title)}</span>
          <button class="run-btn graph-run-btn"
                  data-action="runPhaseFromGraph"
                  data-plan="${pid}"
                  data-phase="${phid}"
                  title="Run this phase">▶ Run</button>
        </footer>
      </div>
    `;
  }

  function renderGraphEdges(graph) {
    const markerId = "graph-arrow-global";
    const markerHighlightId = "graph-arrow-highlight-global";
    const hasSelection = !!selectedPhaseKey;
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
      const d = `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
      // Selection-aware highlighting:
      //   - Default (no selection): every dependency arrow is muted grey.
      //   - With a selected phase: arrows feeding INTO it (the phases it
      //     depends on, drawn dep -> dependent) are highlighted; everything
      //     else is dimmed further so the dependency set pops out.
      let stateClass = "";
      if (hasSelection) {
        const selectedNodeId = "phase::" + selectedPhaseKey;
        const isIncomingToSelection = edge.to === selectedNodeId && edge.kind !== "plan";
        stateClass = isIncomingToSelection ? " selected" : " dimmed";
      }
      const baseClass = edge.kind === "cross-plan"
        ? "cross-plan"
        : edge.kind === "phase"
          ? "phase-dep"
          : "plan-dep";
      const marker = stateClass.includes("selected") ? markerHighlightId : markerId;
      const label = edge.kind === "cross-plan"
        ? `<text class="graph-edge-label${stateClass}" x="${(startX + endX) / 2}" y="${(startY + endY) / 2 - 6}">${esc(edge.label || "cross-plan")}</text>`
        : "";
      return `<path class="${baseClass}${stateClass}" d="${d}" marker-end="url(#${marker})" />${label}`;
    }).join("");
    return `
      <svg class="graph-edges" viewBox="0 0 ${graph.width} ${graph.height}">
        <defs>
          <marker id="${markerId}" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
            <path d="M0,0 L10,4 L0,8 z"></path>
          </marker>
          <marker id="${markerHighlightId}" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
            <path d="M0,0 L10,4 L0,8 z"></path>
          </marker>
        </defs>
        ${lines}
      </svg>
    `;
  }

  function parsePhaseDependencyRef(ref) {
    const parts = String(ref).split("/").map((part) => part.trim());
    if (parts.some((part) => !part)) return null;
    if (parts.length === 1) return { phaseId: parts[0] };
    if (parts.length === 2) return { planId: parts[0], phaseId: parts[1] };
    return null;
  }

  function resolvePhaseDependency(plan, ref, allPlans) {
    const parsed = parsePhaseDependencyRef(ref);
    if (!parsed) return null;
    const targetPlan = parsed.planId ? allPlans.find((p) => p.id === parsed.planId) : plan;
    const targetPhase = targetPlan?.phases?.find((phase) => phase.id === parsed.phaseId);
    return targetPlan && targetPhase ? { plan: targetPlan, phase: targetPhase } : null;
  }

  function shortPlanTitle(plan) {
    const words = String(plan.title || plan.id).split(/\s+/).filter(Boolean);
    return words.slice(0, 2).join(" ") || plan.id;
  }

  function phaseDependencySummary(plan, phase) {
    const refs = Array.isArray(phase.dependsOn) ? phase.dependsOn : [];
    if (!refs.length) return { short: "", title: "" };
    const labels = refs.map((ref) => {
      const resolved = resolvePhaseDependency(plan, ref, plans);
      if (!resolved) return ref;
      return `${resolved.plan.title} / ${resolved.phase.title}`;
    });
    return {
      short: `needs ${refs.length}`,
      title: labels.join("\n"),
    };
  }

  function buildUnifiedGraph(allPlans, filterSet) {
    // Layout: each plan gets its own horizontal swimlane (a "band"). Within a
    // band, the plan node sits at the leftmost column and its phases flow to
    // the right, grouped by dependency depth. Plans never share rows, so a
    // phase from plan B can never sit directly across from plan A's node.
    const padding = 30;
    const nodeWidth = 232;
    const planNodeHeight = 96;
    const phaseNodeHeight = 124;
    const colGap = 76;
    const rowGap = 144;
    const bandGap = 58;

    const totalPhases = allPlans.reduce(
      (s, p) => s + (Array.isArray(p.phases) ? p.phases.length : 0),
      0,
    );

    // Per-plan layouts: filtered phases, dependency depth, depth buckets.
    const planLayouts = allPlans.map((plan) => {
      const allPhases = Array.isArray(plan.phases) ? plan.phases : [];
      const phases = allPhases.filter((ph) => filterSet.has(ph.state));
      const phaseById = new Map(phases.map((ph) => [ph.id, ph]));
      const depthMemo = new Map();
      function depthOf(phase, stack) {
        if (depthMemo.has(phase.id)) return depthMemo.get(phase.id);
        if (stack && stack.has(phase.id)) return 0; // cycle guard
        const guard = stack ? new Set(stack) : new Set();
        guard.add(phase.id);
        const deps = (Array.isArray(phase.dependsOn) ? phase.dependsOn : [])
          .map((depRef) => parsePhaseDependencyRef(depRef))
          .filter((dep) => dep && (!dep.planId || dep.planId === plan.id) && phaseById.has(dep.phaseId))
          .map((dep) => dep.phaseId);
        const d = deps.length === 0
          ? 0
          : 1 + Math.max(...deps.map((depId) => depthOf(phaseById.get(depId), guard)));
        depthMemo.set(phase.id, d);
        return d;
      }
      phases.forEach((ph) => depthOf(ph, null));
      const byDepth = new Map();
      phases.forEach((ph) => {
        const d = depthMemo.get(ph.id) || 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d).push(ph);
      });
      const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);
      const rowsInBand = Math.max(1, ...[0, ...byDepth.values().map((list) => list.length)]);
      return { plan, phases, byDepth, sortedDepths, rowsInBand };
    });

    const maxPhaseColumns = planLayouts.reduce(
      (m, l) => Math.max(m, l.sortedDepths.length),
      0,
    );

    const nodes = [];
    const nodesById = new Map();
    const edges = [];
    let yCursor = padding;

    planLayouts.forEach((layout) => {
      const { plan, byDepth, sortedDepths, rowsInBand } = layout;
      const bandTop = yCursor;
      const bandHeight = (rowsInBand - 1) * rowGap + phaseNodeHeight;
      // Vertically center the plan node within the band.
      const planY = bandTop + Math.max(0, (bandHeight - planNodeHeight) / 2);
      const planNode = {
        id: "plan::" + plan.id,
        kind: "plan",
        title: plan.title,
        tone: derivePlanNodeTone(plan).tone,
        plan,
        x: padding,
        y: planY,
        width: nodeWidth,
        height: planNodeHeight,
      };
      nodes.push(planNode);
      nodesById.set(planNode.id, planNode);

      sortedDepths.forEach((depth) => {
        const list = byDepth.get(depth);
        const ySpan = (list.length - 1) * rowGap;
        const yStart = bandTop + Math.max(0, (bandHeight - (ySpan + phaseNodeHeight)) / 2);
        list.forEach((phase, idx) => {
          const x = padding + nodeWidth + colGap + depth * (nodeWidth + colGap);
          const y = yStart + idx * rowGap;
          const node = {
            id: "phase::" + plan.id + "::" + phase.id,
            kind: "phase",
            plan,
            phase,
            x,
            y,
            width: nodeWidth,
            height: phaseNodeHeight,
          };
          nodes.push(node);
          nodesById.set(node.id, node);
        });
      });

      // Edge: plan node → its depth-0 phases.
      (byDepth.get(0) || []).forEach((phase) => {
        edges.push({
          from: "plan::" + plan.id,
          to: "phase::" + plan.id + "::" + phase.id,
          kind: "plan",
        });
      });

      yCursor = bandTop + bandHeight + bandGap;
    });

    // Phase dependency edges. Cross-plan refs use plan-id/phase-id so they stay
    // readable in JSON and visually explicit in the graph.
    planLayouts.forEach((layout) => {
      layout.phases.forEach((phase) => {
        const deps = Array.isArray(phase.dependsOn) ? phase.dependsOn : [];
        deps.forEach((depRef) => {
          const resolved = resolvePhaseDependency(layout.plan, depRef, allPlans);
          if (!resolved) return;
          const fromId = "phase::" + resolved.plan.id + "::" + resolved.phase.id;
          const toId = "phase::" + layout.plan.id + "::" + phase.id;
          if (!nodesById.has(fromId) || !nodesById.has(toId)) return;
          const crossPlan = resolved.plan.id !== layout.plan.id;
          edges.push({
            from: fromId,
            to: toId,
            kind: crossPlan ? "cross-plan" : "phase",
            label: crossPlan ? `${shortPlanTitle(resolved.plan)} -> ${shortPlanTitle(layout.plan)}` : "depends",
          });
        });
      });
    });

    const width = padding + nodeWidth + maxPhaseColumns * (nodeWidth + colGap) + padding;
    const height = Math.max(padding * 2 + phaseNodeHeight, yCursor - bandGap + padding);
    const visiblePhases = planLayouts.flatMap((l) =>
      l.phases.map((ph) => ({ plan: l.plan, phase: ph })),
    );

    return {
      width,
      height,
      nodes,
      edges,
      totalPhases,
      visiblePhases,
      nodesById,
    };
  }

  function ensureGraphState(graphId) {
    if (!graphViewState[graphId]) {
      graphViewState[graphId] = {
        x: 0,
        y: 0,
        scale: 1,
        userAdjusted: false,
        lastW: -1,
        lastH: -1,
      };
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

  function fitGraphToView(graphId) {
    const scene = [...document.querySelectorAll(".graph-scene[data-graph]")].find((el) => el.dataset.graph === graphId);
    if (!scene) {
      return;
    }
    const viewport = scene.parentElement;
    if (!viewport) {
      return;
    }
    const sceneW = parseFloat(scene.style.width) || 0;
    const sceneH = parseFloat(scene.style.height) || 0;
    if (!sceneW || !sceneH) {
      return;
    }
    const margin = 12;
    const availW = Math.max(80, viewport.clientWidth - margin * 2);
    const availH = Math.max(80, viewport.clientHeight - margin * 2);
    // Minimum readable scale — below this the run buttons get unusably small.
    // Users can still pan/zoom past it, but the initial fit stays legible.
    const minReadableScale = 0.65;
    const fitScale = Math.min(availW / sceneW, availH / sceneH, 1.5);
    const scale = Math.max(fitScale, minReadableScale);
    const state = ensureGraphState(graphId);
    state.scale = scale;
    state.x = margin + Math.max(0, (availW - sceneW * scale) / 2);
    state.y = margin + Math.max(0, (availH - sceneH * scale) / 2);
    state.lastW = sceneW;
    state.lastH = sceneH;
    state.userAdjusted = false;
    applyGraphSceneTransform(graphId);
  }

  function syncGraphScenes() {
    document.querySelectorAll(".graph-scene[data-graph]").forEach((scene) => {
      const graphId = scene.dataset.graph;
      if (!graphId) {
        return;
      }
      const sceneW = parseFloat(scene.style.width) || 0;
      const sceneH = parseFloat(scene.style.height) || 0;
      const state = ensureGraphState(graphId);
      const dimsChanged = state.lastW !== sceneW || state.lastH !== sceneH;
      if (dimsChanged && !state.userAdjusted) {
        fitGraphToView(graphId);
      } else {
        if (dimsChanged) {
          state.lastW = sceneW;
          state.lastH = sceneH;
        }
        applyGraphSceneTransform(graphId);
      }
    });
  }

  function renderNodePhase(plan, phase) {
    const pid = esc(plan.id);
    const phid = esc(phase.id);
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    const depSummary = phaseDependencySummary(plan, phase);
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
        ${depSummary.short ? `<div class="node-phase-deps"><strong>Depends on</strong>: ${esc(depSummary.title).replace(/\n/g, "<br>")}</div>` : ""}
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
    return phase.dependsOn.flatMap((ref) => {
      const resolved = resolvePhaseDependency(plan, ref, plans);
      if (!resolved) return [`unknown ${ref}`];
      return resolved.phase.state === "completed"
        ? []
        : [`${resolved.plan.id}/${resolved.phase.id} (${resolved.phase.state})`];
    });
  }

  // Tasks no longer carry dependencies — only phases do — so there's no
  // task-level blocking computation. The phase-level helpers above are
  // sufficient.

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
            <span class="phase-status-dot dot-${phase.state}" role="button" tabindex="0"
                  data-action="cyclePhaseState" data-plan="${pid}" data-phase="${phid}"
                  title="Click to set: ${nextStateInCycle(phase.state).replace("_", " ")}"></span>
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
    const isRunning = task.state === "in_progress";
    const pid = esc(plan.id);
    const phid = esc(phase.id);
    const tid = esc(task.id);
    // A task inherits its blocked state from its parent phase's dependsOn:
    // if the phase has unmet phase deps, surfacing it on the task is honest
    // (the run flow blocks the same way) but we keep the message short.
    const phaseBlockers = blockingDeps(plan, phase);
    const isBlocked = phaseBlockers.length > 0;
    const runTitle = isRunning
      ? "Already running"
      : isBlocked
        ? `Phase blocked by: ${phaseBlockers.join(", ")}`
        : "Run task";

    const runBtn = `<button class="task-btn run-task" data-action="taskRun"
                 data-plan="${pid}" data-phase="${phid}" data-task="${tid}"
                 ${isRunning ? "disabled" : ""}
                 title="${esc(runTitle)}">▶</button>`;

    return `
      <div class="task-row${isBlocked ? " blocked" : ""}" data-plan="${pid}" data-phase="${phid}" data-task="${tid}">
        ${taskIconHtml(task.state, pid, phid, tid)}
        <span class="task-title${isCancelled ? " strike" : ""}">${esc(task.desc)}</span>
        <div class="task-actions">${runBtn}</div>
      </div>`;
  }

  // ── Event delegation ─────────────────────────────────────────────────────

  // Toggling plan/phase expansion is deferred briefly so a double-click on the
  // title can cancel it (see the dblclick handler below) and open the details
  // panel without first flashing the expand/collapse animation.
  const TOGGLE_DBLCLICK_DELAY_MS = 220;
  const togglePlanTimers = new Map(); // planId -> timeoutId
  const togglePhaseTimers = new Map(); // "planId::phaseId" -> timeoutId

  function applyTogglePlan(planId) {
    if (expandedPlans.has(planId)) {
      expandedPlans.delete(planId);
    } else {
      expandedPlans.add(planId);
    }
    render();
  }
  function applyTogglePhase(planId, phaseId) {
    const key = planId + "::" + phaseId;
    if (expandedPhases.has(key)) {
      expandedPhases.delete(key);
    } else {
      expandedPhases.add(key);
    }
    render();
  }

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
      const existing = togglePlanTimers.get(planId);
      if (existing) clearTimeout(existing);
      togglePlanTimers.set(planId, setTimeout(() => {
        togglePlanTimers.delete(planId);
        applyTogglePlan(planId);
      }, TOGGLE_DBLCLICK_DELAY_MS));
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

    if (action === "quickCreatePlan") {
      openWizard("plan");
      return;
    }

    if (action === "quickCreatePhase") {
      openWizard("phase");
      return;
    }

    if (action === "quickCreateTask") {
      openWizard("task");
      return;
    }

    if (action === "syncPull") {
      vscode.postMessage({ type: "syncPullAll" });
      return;
    }

    if (action === "syncPush") {
      vscode.postMessage({ type: "syncPushAll" });
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
      const id = graphId || GLOBAL_GRAPH_KEY;
      if (action === "graphZoomReset") {
        fitGraphToView(id);
      } else {
        const state = ensureGraphState(id);
        const factor = action === "graphZoomIn" ? 1.14 : 0.88;
        state.scale = Math.min(1.95, Math.max(0.4, state.scale * factor));
        state.userAdjusted = true;
        applyGraphSceneTransform(id);
      }
      return;
    }

    if (action === "graphClearSelection") {
      e.stopPropagation();
      selectedPhaseKey = null;
      render();
      return;
    }

    if (action === "selectGraphPhase") {
      e.stopPropagation();
      if (planId && phaseId) {
        const key = planId + "::" + phaseId;
        // Click again to deselect — easier than hunting the Clear button.
        selectedPhaseKey = selectedPhaseKey === key ? null : key;
        render();
      }
      return;
    }

    if (action === "runPhaseFromGraph") {
      e.stopPropagation();
      if (planId && phaseId) {
        // Auto-select the phase so its tasks pop up below the graph as it runs.
        selectedPhaseKey = planId + "::" + phaseId;
        render();
        vscode.postMessage({ type: "runPhase", planId, phaseId });
      }
      return;
    }

    if (action === "runPlanFromGraph") {
      e.stopPropagation();
      if (planId) {
        vscode.postMessage({ type: "runPlanFully", planId });
      }
      return;
    }

    if (action === "graphToggleExpand") {
      graphExpanded = !graphExpanded;
      render();
      return;
    }

    if (action === "togglePhase") {
      const key = planId + "::" + phaseId;
      const existing = togglePhaseTimers.get(key);
      if (existing) clearTimeout(existing);
      togglePhaseTimers.set(key, setTimeout(() => {
        togglePhaseTimers.delete(key);
        applyTogglePhase(planId, phaseId);
      }, TOGGLE_DBLCLICK_DELAY_MS));
      return;
    }

    if (action === "runPhase") {
      e.stopPropagation();
      // Auto-expand the phase in the list view so the user can watch tasks
      // sequentially turn green below it as the agent works through them.
      if (planId && phaseId) {
        expandedPhases.add(planId + "::" + phaseId);
        // Make sure the parent plan is expanded too — otherwise the phase
        // (and its newly-revealed tasks) wouldn't actually be visible.
        expandedPlans.add(planId);
        render();
      }
      vscode.postMessage({ type: "runPhase", planId, phaseId });
      return;
    }

    if (action === "runPlan") {
      e.stopPropagation();
      // Sequential plan run: the backend chains every phase one after the
      // other, prompting for the branch decision once. Phases turn green
      // in the list (and graph) as each finishes.
      if (planId) {
        expandedPlans.add(planId);
        render();
        vscode.postMessage({ type: "runPlanFully", planId });
      }
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
      if (!task || task.state === "in_progress") {
        return;
      }
      // Optimistic local state for instant feedback while the backend dispatches.
      task.state = "in_progress";
      render();
      // Real per-task dispatch — backend builds a task-only prompt and runs it
      // via the agent CLI, then marks the task completed/failed on its own.
      vscode.postMessage({ type: "runTask", planId, phaseId, taskId });
      return;
    }

    if (action === "taskStatus") {
      e.stopPropagation();
      const newState = el.dataset.status;
      sendTaskStateMutation(planId, phaseId, taskId, newState);
      return;
    }

    if (action === "cycleTaskState") {
      e.stopPropagation();
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      const task = phase?.tasks?.find((t) => t.id === taskId);
      if (task) {
        const next = nextStateInCycle(task.state);
        sendTaskStateMutation(planId, phaseId, taskId, next);
      }
      return;
    }

    if (action === "cyclePhaseState") {
      e.stopPropagation();
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      if (phase) {
        const next = nextStateInCycle(phase.state);
        sendPhaseStateMutation(planId, phaseId, next);
      }
      return;
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
    const nextScale = Math.min(1.95, Math.max(0.4, state.scale * zoomFactor));
    state.x = cursorX - worldX * nextScale;
    state.y = cursorY - worldY * nextScale;
    state.scale = nextScale;
    state.userAdjusted = true;
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
    state.userAdjusted = true;
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

  document.addEventListener("dblclick", (e) => {
    const taskTitle = e.target.closest(".task-title");
    if (taskTitle) {
      const row = taskTitle.closest(".task-row");
      const planId = row?.dataset.plan;
      const phaseId = row?.dataset.phase;
      const taskId = row?.dataset.task;
      if (planId && phaseId && taskId) {
        e.preventDefault();
        vscode.postMessage({ type: "openTaskDetails", planId, phaseId, taskId });
      }
      return;
    }
    const phaseTitle = e.target.closest(".phase-title");
    if (phaseTitle) {
      const header = phaseTitle.closest(".phase-header");
      const planId = header?.dataset.plan;
      const phaseId = header?.dataset.phase;
      if (planId && phaseId) {
        const key = planId + "::" + phaseId;
        const t = togglePhaseTimers.get(key);
        if (t) {
          clearTimeout(t);
          togglePhaseTimers.delete(key);
        }
        e.preventDefault();
        vscode.postMessage({ type: "openPhaseDetails", planId, phaseId });
      }
      return;
    }
    const planTitle = e.target.closest(".plan-title");
    if (planTitle) {
      const header = planTitle.closest(".plan-header");
      const planId = header?.dataset.plan;
      if (planId) {
        const t = togglePlanTimers.get(planId);
        if (t) {
          clearTimeout(t);
          togglePlanTimers.delete(planId);
        }
        e.preventDefault();
        vscode.postMessage({ type: "openPlanDetails", planId });
      }
    }
  });

  document.addEventListener("contextmenu", (e) => {
    hideContextMenu();
    const btn = e.target.closest("button");
    // Allow right-click menus on the plan nodes view (which uses <button>).
    if (btn && !btn.classList.contains("plan-node")) {
      return;
    }
    const taskRow = e.target.closest(".task-row");
    if (taskRow) {
      e.preventDefault();
      openTaskContextMenu(e, taskRow);
      return;
    }
    const phaseHeader = e.target.closest(".phase-header");
    if (phaseHeader) {
      e.preventDefault();
      openPhaseContextMenu(e, phaseHeader);
      return;
    }
    const planHeader = e.target.closest(".plan-header");
    if (planHeader) {
      e.preventDefault();
      openPlanContextMenu(e, planHeader);
      return;
    }
    const planNode = e.target.closest(".plan-node");
    if (!planNode) {
      return;
    }
    e.preventDefault();
    openPlanNodeContextMenu(e, planNode);
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
    const menu = createContextMenu(event.clientX, event.clientY, [
      {
        label: "Delete task",
        onClick: () => vscode.postMessage({ type: "deleteTask", planId, phaseId, taskId }),
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
    const menu = createContextMenu(event.clientX, event.clientY, [
      {
        label: "Delete phase",
        onClick: () => vscode.postMessage({ type: "deletePhase", planId, phaseId }),
      },
    ]);
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function openPlanContextMenu(event, planHeader) {
    const planId = planHeader.dataset.plan;
    if (!planId) {
      return;
    }
    const menu = createContextMenu(event.clientX, event.clientY, [
      {
        label: "Delete plan",
        onClick: () => vscode.postMessage({ type: "deletePlan", planId }),
      },
    ]);
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function openPlanNodeContextMenu(event, planNodeBtn) {
    const planId = planNodeBtn.dataset.plan;
    if (!planId) {
      return;
    }
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
      return;
    }
    const phases = Array.isArray(plan.phases) ? plan.phases : [];
    const menu = createContextMenu(event.clientX, event.clientY, [
      {
        label: `Plan info (${plan.state})`,
        onClick: () => vscode.postMessage({ type: "openPlanDetails", planId }),
      },
      {
        label: expandedPlans.has(planId) ? "Hide phases" : `Show phases (${phases.length})`,
        onClick: () => {
          if (expandedPlans.has(planId)) {
            expandedPlans.delete(planId);
          } else {
            expandedPlans.add(planId);
          }
          render();
        },
      },
    ]);
    document.body.appendChild(menu);
    activeContextMenu = menu;
  }

  function openWizard(kind) {
    if (kind !== "plan" && !plans.length) {
      return;
    }
    wizardState = {
      kind,
      step: 1,
      planId: plans[0]?.id || "",
      phaseId: "",
    };
    if (kind === "phase" && plans.length === 1) {
      wizardState.planId = plans[0].id;
      wizardState.step = 2;
    }
    if (kind === "task") {
      if (plans.length === 1) {
        wizardState.planId = plans[0].id;
        const phases = Array.isArray(plans[0].phases) ? plans[0].phases : [];
        if (phases.length === 0) {
          showWizardError("This plan has no phases yet. Create a phase first.");
        } else if (phases.length === 1) {
          wizardState.phaseId = phases[0].id;
          wizardState.step = 3;
        } else {
          wizardState.step = 2;
        }
      }
    }
    wizardOverlay.style.display = "flex";
    renderWizard();
  }

  function closeWizard() {
    wizardState = null;
    wizardOverlay.style.display = "none";
    wizardBody.innerHTML = "";
    wizardError.textContent = "";
  }

  function showWizardError(message) {
    wizardError.textContent = message || "";
  }

  function renderWizard() {
    if (!wizardState) return;
    showWizardError("");
    const kind = wizardState.kind;
    if (kind === "plan") {
      wizardTitle.textContent = "Create Plan";
      wizardStep.textContent = "Step 1 of 1";
      wizardBody.innerHTML = `
        <div class="wizard-field">
          <label class="wizard-label">Plan title</label>
          <input class="wizard-input" id="wizPlanTitle" placeholder="E.g. Launch onboarding MVP" />
        </div>
        <div class="wizard-field">
          <label class="wizard-label">Description (optional)</label>
          <textarea class="wizard-textarea" id="wizPlanDescription" placeholder="What is this plan about?"></textarea>
        </div>
      `;
      wizardSecondary.textContent = "Cancel";
      wizardPrimary.textContent = "Create plan";
      setTimeout(() => document.getElementById("wizPlanTitle")?.focus(), 0);
      return;
    }
    if (kind === "phase") {
      if (wizardState.step === 1) {
        wizardTitle.textContent = "Create Phase";
        wizardStep.textContent = "Step 1 of 2";
        wizardBody.innerHTML = `
          <div class="wizard-field">
            <label class="wizard-label">Select plan</label>
            <select class="wizard-select" id="wizPlanSelect">
              ${plans.map((p) => `<option value="${esc(p.id)}"${p.id === wizardState.planId ? " selected" : ""}>${esc(p.title)}</option>`).join("")}
            </select>
          </div>
        `;
        wizardSecondary.textContent = "Cancel";
        wizardPrimary.textContent = "Continue";
        return;
      }
      wizardTitle.textContent = "Create Phase";
      wizardStep.textContent = "Step 2 of 2";
      wizardBody.innerHTML = `
        <div class="wizard-field">
          <label class="wizard-label">Phase title</label>
          <input class="wizard-input" id="wizPhaseTitle" placeholder="E.g. API implementation" />
        </div>
        <div class="wizard-field">
          <label class="wizard-label">Description (optional)</label>
          <textarea class="wizard-textarea" id="wizPhaseDescription" placeholder="Describe what this phase includes"></textarea>
        </div>
      `;
      wizardSecondary.textContent = "Back";
      wizardPrimary.textContent = "Create phase";
      setTimeout(() => document.getElementById("wizPhaseTitle")?.focus(), 0);
      return;
    }
    if (wizardState.step === 1) {
      wizardTitle.textContent = "Create Task";
      wizardStep.textContent = "Step 1 of 3";
      wizardBody.innerHTML = `
        <div class="wizard-field">
          <label class="wizard-label">Select plan</label>
          <select class="wizard-select" id="wizPlanSelect">
            ${plans.map((p) => `<option value="${esc(p.id)}"${p.id === wizardState.planId ? " selected" : ""}>${esc(p.title)}</option>`).join("")}
          </select>
        </div>
      `;
      wizardSecondary.textContent = "Cancel";
      wizardPrimary.textContent = "Continue";
      return;
    }
    if (wizardState.step === 2) {
      wizardTitle.textContent = "Create Task";
      wizardStep.textContent = "Step 2 of 3";
      const selectedPlan = plans.find((p) => p.id === wizardState.planId);
      const phases = Array.isArray(selectedPlan?.phases) ? selectedPlan.phases : [];
      wizardBody.innerHTML = `
        <div class="wizard-field">
          <label class="wizard-label">Select phase</label>
          <select class="wizard-select" id="wizPhaseSelect">
            ${phases.map((ph) => `<option value="${esc(ph.id)}"${ph.id === wizardState.phaseId ? " selected" : ""}>${esc(ph.title)}</option>`).join("")}
          </select>
        </div>
      `;
      wizardSecondary.textContent = "Back";
      wizardPrimary.textContent = "Continue";
      return;
    }
    wizardTitle.textContent = "Create Task";
    wizardStep.textContent = "Step 3 of 3";
    wizardBody.innerHTML = `
      <div class="wizard-field">
        <label class="wizard-label">Task title</label>
        <input class="wizard-input" id="wizTaskDesc" placeholder="E.g. Build login endpoint" />
      </div>
      <div class="wizard-field">
        <label class="wizard-label">Prompt for executor (optional)</label>
        <textarea class="wizard-textarea" id="wizTaskPrompt" placeholder="Extra implementation instructions"></textarea>
      </div>
      <label class="wizard-check">
        <input type="checkbox" id="wizTaskCommit" />
        <span>Require commit when task completes</span>
      </label>
    `;
    wizardSecondary.textContent = "Back";
    wizardPrimary.textContent = "Create task";
    setTimeout(() => document.getElementById("wizTaskDesc")?.focus(), 0);
  }

  function handleWizardSecondary() {
    if (!wizardState) return;
    if (wizardState.kind === "plan") {
      closeWizard();
      return;
    }
    if (wizardState.step === 1) {
      closeWizard();
      return;
    }
    wizardState.step -= 1;
    renderWizard();
  }

  function handleWizardPrimary() {
    if (!wizardState) return;
    showWizardError("");
    if (wizardState.kind === "plan") {
      const title = document.getElementById("wizPlanTitle")?.value?.trim() || "";
      const description = document.getElementById("wizPlanDescription")?.value?.trim() || "";
      if (!title) {
        showWizardError("Plan title is required.");
        return;
      }
      vscode.postMessage({ type: "createPlan", title, description });
      closeWizard();
      return;
    }
    if (wizardState.kind === "phase") {
      if (wizardState.step === 1) {
        const planId = document.getElementById("wizPlanSelect")?.value || "";
        if (!planId) {
          showWizardError("Select a plan.");
          return;
        }
        wizardState.planId = planId;
        wizardState.step = 2;
        renderWizard();
        return;
      }
      const title = document.getElementById("wizPhaseTitle")?.value?.trim() || "";
      const description = document.getElementById("wizPhaseDescription")?.value?.trim() || "";
      if (!title) {
        showWizardError("Phase title is required.");
        return;
      }
      if (!wizardState.planId) {
        showWizardError("Select a plan.");
        return;
      }
      vscode.postMessage({ type: "createPhase", planId: wizardState.planId, title, description });
      closeWizard();
      return;
    }

    if (wizardState.step === 1) {
      const planId = document.getElementById("wizPlanSelect")?.value || "";
      if (!planId) {
        showWizardError("Select a plan.");
        return;
      }
      const plan = plans.find((p) => p.id === planId);
      const phases = Array.isArray(plan?.phases) ? plan.phases : [];
      if (!phases.length) {
        showWizardError("This plan has no phases. Create one first.");
        return;
      }
      wizardState.planId = planId;
      wizardState.phaseId = phases[0].id;
      wizardState.step = 2;
      renderWizard();
      return;
    }
    if (wizardState.step === 2) {
      const phaseId = document.getElementById("wizPhaseSelect")?.value || "";
      if (!phaseId) {
        showWizardError("Select a phase.");
        return;
      }
      wizardState.phaseId = phaseId;
      wizardState.step = 3;
      renderWizard();
      return;
    }
    const desc = document.getElementById("wizTaskDesc")?.value?.trim() || "";
    const prompt = document.getElementById("wizTaskPrompt")?.value?.trim() || "";
    const commit = Boolean(document.getElementById("wizTaskCommit")?.checked);
    if (!desc) {
      showWizardError("Task title is required.");
      return;
    }
    if (!wizardState.planId || !wizardState.phaseId) {
      showWizardError("Select plan and phase.");
      return;
    }
    vscode.postMessage({
      type: "createTask",
      planId: wizardState.planId,
      phaseId: wizardState.phaseId,
      desc,
      prompt,
      commit,
    });
    closeWizard();
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
      return;
    }
    if (msg.type === "mutationAck" && typeof msg.requestId === "string") {
      const pending = pendingMutations.get(msg.requestId);
      if (!pending) {
        return;
      }
      pendingMutations.delete(msg.requestId);
      if (msg.ok) {
        return;
      }
      if (pending.kind === "task") {
        const plan = plans.find((p) => p.id === pending.planId);
        const phase = plan?.phases?.find((ph) => ph.id === pending.phaseId);
        const task = phase?.tasks?.find((t) => t.id === pending.taskId);
        if (task) {
          task.state = pending.prevState;
        }
      } else if (pending.kind === "phase") {
        const plan = plans.find((p) => p.id === pending.planId);
        const phase = plan?.phases?.find((ph) => ph.id === pending.phaseId);
        if (phase) {
          phase.state = pending.prevState;
        }
      }
      render();
    }
  });

  wizardSecondary?.addEventListener("click", handleWizardSecondary);
  wizardPrimary?.addEventListener("click", handleWizardPrimary);
  wizardOverlay?.addEventListener("click", (e) => {
    if (e.target === wizardOverlay) {
      closeWizard();
    }
  });
})();
