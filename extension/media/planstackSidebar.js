(function () {
  const vscode = acquireVsCodeApi();

  let plans = [];
  const expandedPlans = new Set();
  const expandedPhases = new Set();

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
    root.innerHTML = plans.map(renderPlan).join("");
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
        <div class="plan-header" data-action="togglePlan" data-plan="${pid}">
          <div class="plan-header-left">
            <span class="chevron${isOpen ? " expanded" : ""}">›</span>
            <span class="plan-title">${esc(plan.title)}</span>
          </div>
          <div class="plan-header-right">
            <span class="plan-progress">${done}/${total}</span>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
        </div>
        ${isOpen ? `<div class="plan-phases">${phases.map((ph) => renderPhase(plan, ph)).join("")}</div>` : ""}
      </div>`;
  }

  function renderPhase(plan, phase) {
    const key = plan.id + "::" + phase.id;
    const isOpen = expandedPhases.has(key);
    const tasks = phase.tasks || [];
    const hasTasks = tasks.length > 0;
    const pid = esc(plan.id);
    const phid = esc(phase.id);

    return `
      <div class="phase-row">
        <div class="phase-header">
          <div class="phase-header-left"
               ${hasTasks ? `data-action="togglePhase" data-plan="${pid}" data-phase="${phid}"` : ""}>
            ${hasTasks
              ? `<span class="chevron sm${isOpen ? " expanded" : ""}">›</span>`
              : `<span class="chevron-gap"></span>`}
            <span class="phase-status-dot dot-${phase.state}"></span>
            <span class="phase-title">${esc(phase.title)}</span>
          </div>
          <div class="phase-header-right">
            ${badgeHtml(phase.state)}
            <button class="run-btn"
                    data-action="runPhase" data-plan="${pid}" data-phase="${phid}"
                    title="Run this phase">▶ Run</button>
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
    const pid = esc(plan.id);
    const phid = esc(phase.id);
    const tid = esc(task.id);

    const btns = [];
    if (!isCompleted && !isCancelled) {
      btns.push(`<button class="task-btn done-btn" data-action="taskStatus"
                   data-plan="${pid}" data-phase="${phid}" data-task="${tid}" data-status="completed"
                   title="Mark done">✓</button>`);
    }
    if (task.state === "pending") {
      btns.push(`<button class="task-btn run-task" data-action="taskStatus"
                   data-plan="${pid}" data-phase="${phid}" data-task="${tid}" data-status="in_progress"
                   title="Start">▶</button>`);
    }
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
      <div class="task-row">
        ${taskIconHtml(task.state)}
        <span class="task-title${isCancelled ? " strike" : ""}">${esc(task.desc)}</span>
        <div class="task-actions">${btns.join("")}</div>
      </div>`;
  }

  // ── Event delegation ─────────────────────────────────────────────────────

  document.addEventListener("click", (e) => {
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
      vscode.postMessage({ type: "runPhase", planId, phaseId });
      return;
    }

    if (action === "taskStatus") {
      e.stopPropagation();
      const newState = el.dataset.status;
      vscode.postMessage({ type: "updateTaskStatus", planId, phaseId, taskId, state: newState });
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
