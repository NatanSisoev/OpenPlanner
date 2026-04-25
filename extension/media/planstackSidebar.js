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

  const root = document.getElementById("root");
  const wizardOverlay = document.getElementById("wizardOverlay");
  const wizardTitle = document.getElementById("wizardTitle");
  const wizardStep = document.getElementById("wizardStep");
  const wizardBody = document.getElementById("wizardBody");
  const wizardError = document.getElementById("wizardError");
  const wizardPrimary = document.getElementById("wizardPrimary");
  const wizardSecondary = document.getElementById("wizardSecondary");

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
        <div class="toolbar-group">
          <button class="view-btn${viewMode === "list" ? " active" : ""}" data-action="switchView" data-view="list">List view</button>
          <button class="view-btn${viewMode === "nodes" ? " active" : ""}" data-action="switchView" data-view="nodes">View as nodes</button>
        </div>
      </div>
    `;
  }

  function renderNodesView() {
    const legend = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;padding:0 8px 8px;font-size:11px;opacity:0.85;">
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;border-radius:50%;border:2px solid #f44747;"></span>failed</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;border-radius:50%;border:2px solid #4ec9b0;"></span>completed</span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;border-radius:50%;border:2px solid #569cd6;"></span>running</span>
      </div>
    `;
    return `
      ${legend}
      <div class="nodes-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:4px 8px 10px;">
        ${plans.map((plan) => renderPlanNode(plan)).join("")}
      </div>
    `;
  }

  function renderPlanNode(plan) {
    const { tone, borderColor, glowColor } = derivePlanNodeTone(plan);
    const isOpen = expandedPlans.has(plan.id);
    const pid = esc(plan.id);
    const phases = Array.isArray(plan.phases) ? plan.phases : [];
    const totalTasks = phases.reduce((acc, ph) => acc + ((ph.tasks && ph.tasks.length) || 0), 0);
    const completedTasks = phases.reduce(
      (acc, ph) => acc + ((ph.tasks || []).filter((t) => t.state === "completed").length),
      0,
    );
    return `
      <div class="node-wrapper">
        <button class="plan-node tone-${tone}"
                data-action="toggleNodeDetails"
                data-plan="${pid}"
                title="${esc(plan.title)}"
                style="
                  width: 132px;
                  height: 132px;
                  border-radius: 50%;
                  border: 3px solid ${borderColor};
                  box-shadow: 0 0 0 2px ${glowColor} inset, 0 6px 14px rgba(0,0,0,0.28);
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  text-align: center;
                  padding: 12px;
                  margin: 0 auto;
                  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.04), rgba(0,0,0,0.18));
                  cursor: pointer;
                ">
          <span class="node-name" style="white-space:normal;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;">${esc(plan.title)}</span>
        </button>
        ${isOpen
          ? `<div class="node-details" style="margin-top:8px;border:1px solid rgba(127,127,127,0.25);border-radius:8px;padding:8px;background:rgba(127,127,127,0.08);">
               <div style="font-size:12px;opacity:0.9;margin-bottom:6px;"><strong>${esc(plan.title)}</strong></div>
               <div style="font-size:11px;opacity:0.8;margin-bottom:8px;">${completedTasks}/${totalTasks} tasks completed · ${phases.length} phases</div>
               ${phases.map((phase) => renderNodePhase(plan, phase)).join("")}
             </div>`
          : ""}
      </div>
    `;
  }

  function renderNodePhase(plan, phase) {
    const pid = esc(plan.id);
    const phid = esc(phase.id);
    const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
    return `
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(127,127,127,0.18);">
        <div class="phase-header" data-plan="${pid}" data-phase="${phid}" style="padding:2px 0;cursor:default;">
          <div class="phase-header-left">
            <span class="phase-status-dot dot-${phase.state}"></span>
            <span class="phase-title">${esc(phase.title)}</span>
          </div>
          <div class="phase-header-right">
            ${badgeHtml(phase.state)}
            <button class="run-btn" data-action="runPhase" data-plan="${pid}" data-phase="${phid}" title="Run this phase">▶ Run</button>
          </div>
        </div>
        <div class="phase-tasks" style="margin:4px 0 0 8px;padding:0 0 0 10px;">
          ${tasks.map((task) => renderTask(plan, phase, task)).join("")}
        </div>
      </div>
    `;
  }

  function derivePlanNodeTone(plan) {
    const phases = Array.isArray(plan.phases) ? plan.phases : [];
    const tasks = phases.flatMap((phase) => (Array.isArray(phase.tasks) ? phase.tasks : []));
    if (tasks.some((task) => task.state === "failed")) {
      return { tone: "failed", borderColor: "#f44747", glowColor: "rgba(244,71,71,0.20)" };
    }
    if (tasks.every((task) => task.state === "completed")) {
      return { tone: "completed", borderColor: "#4ec9b0", glowColor: "rgba(78,201,176,0.20)" };
    }
    if (tasks.some((task) => task.state === "in_progress")) {
      return { tone: "in_progress", borderColor: "#569cd6", glowColor: "rgba(86,156,214,0.20)" };
    }
    return { tone: "pending", borderColor: "#6e6e6e", glowColor: "rgba(110,110,110,0.18)" };
  }

  function renderPlan(plan) {
    const isOpen = expandedPlans.has(plan.id);
    const phases = plan.phases || [];
    const done = phases.filter((p) => p.state === "completed").length;
    const total = phases.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const pid = esc(plan.id);

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

    const runBtn = `<button class="task-btn run-task" data-action="taskRun"
                 data-plan="${pid}" data-phase="${phid}" data-task="${tid}"
                 ${isRunning ? "disabled" : ""}
                 title="${isRunning ? "Already running" : "Run task"}">▶</button>`;

    return `
      <div class="task-row" data-plan="${pid}" data-phase="${phid}" data-task="${tid}">
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

    if (action === "togglePlan") {
      const existing = togglePlanTimers.get(planId);
      if (existing) clearTimeout(existing);
      togglePlanTimers.set(planId, setTimeout(() => {
        togglePlanTimers.delete(planId);
        applyTogglePlan(planId);
      }, TOGGLE_DBLCLICK_DELAY_MS));
      return;
    }

    if (action === "toggleNodeDetails") {
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
      return;
    }

    if (action === "cycleTaskState") {
      e.stopPropagation();
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      const task = phase?.tasks?.find((t) => t.id === taskId);
      if (task) {
        const next = nextStateInCycle(task.state);
        task.state = next;
        vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, state: next });
        render();
      }
      return;
    }

    if (action === "cyclePhaseState") {
      e.stopPropagation();
      const plan = plans.find((p) => p.id === planId);
      const phase = plan?.phases?.find((ph) => ph.id === phaseId);
      if (phase) {
        const next = nextStateInCycle(phase.state);
        phase.state = next;
        vscode.postMessage({ type: "updatePhase", planId, phaseId, state: next });
        render();
      }
      return;
    }
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
