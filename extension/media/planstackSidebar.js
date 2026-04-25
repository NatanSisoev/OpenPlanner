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

  const root = document.getElementById("root");

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
      <div class="view-switcher" style="display:flex;gap:6px;padding:4px 8px 8px;position:sticky;top:0;background:var(--vscode-sideBar-background);z-index:2;">
        <button class="view-btn${viewMode === "list" ? " active" : ""}" data-action="switchView" data-view="list"
                style="font:inherit;font-size:12px;border-radius:999px;border:1px solid rgba(127,127,127,0.35);padding:3px 10px;cursor:pointer;${viewMode === "list" ? "background:var(--vscode-button-background,#0e70c0);color:var(--vscode-button-foreground,#fff);" : "background:transparent;color:inherit;"}">List view</button>
        <button class="view-btn${viewMode === "nodes" ? " active" : ""}" data-action="switchView" data-view="nodes"
                style="font:inherit;font-size:12px;border-radius:999px;border:1px solid rgba(127,127,127,0.35);padding:3px 10px;cursor:pointer;${viewMode === "nodes" ? "background:var(--vscode-button-background,#0e70c0);color:var(--vscode-button-foreground,#fff);" : "background:transparent;color:inherit;"}">View as nodes</button>
      </div>
    `;
    const body = viewMode === "nodes"
      ? renderNodesView()
      : plans.map(renderPlan).join("");
    root.innerHTML = controls + body;
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

    if (action === "togglePlan") {
      if (expandedPlans.has(planId)) {
        expandedPlans.delete(planId);
      } else {
        expandedPlans.add(planId);
      }
      render();
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
    const planHeader = e.target.closest(".plan-header");
    if (planHeader) {
      e.preventDefault();
      openPlanContextMenu(e, planHeader);
      return;
    }
    const phaseHeader = e.target.closest(".phase-header");
    if (!phaseHeader) {
      const planNode = e.target.closest(".plan-node");
      if (!planNode) {
        return;
      }
      e.preventDefault();
      openPlanNodeContextMenu(e, planNode);
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
        label: task.commit ? "Disable commit requirement" : "Enable commit requirement",
        onClick: () => {
          const nextCommit = !Boolean(task.commit);
          task.commit = nextCommit;
          vscode.postMessage({ type: "updateTask", planId, phaseId, taskId, commit: nextCommit });
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

  function openPlanContextMenu(event, planHeader) {
    const planId = planHeader.dataset.plan;
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
        label: expandedPlans.has(planId) ? "Collapse phases" : `Expand phases (${phases.length})`,
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
