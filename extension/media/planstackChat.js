(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const createPlanBtn = document.getElementById("createPlan");
  const stopAgentsBtn = document.getElementById("stopAgents");

  /** Max characters retained per run in the live <pre> (tail kept). */
  const MAX_AGENT_STREAM_CHARS = 400000;

  /** @type {Map<string, { wrap: HTMLElement; pre: HTMLPreElement; len: number }>} */
  const agentStreams = new Map();

  /** @type {Map<string, { wrap: HTMLElement; intervalId: ReturnType<typeof setInterval> }>} */
  const animatedStatuses = new Map();

  function appendBubble(role, text) {
    const wrap = document.createElement("div");
    wrap.className = role === "system" ? "row system" : "row user";
    const bubble = document.createElement("div");
    bubble.className = role === "system" ? "bubble system" : "bubble user";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function capStreamText(pre, state, add) {
    const combined = pre.textContent + add;
    if (combined.length <= MAX_AGENT_STREAM_CHARS) {
      pre.appendChild(document.createTextNode(add));
      state.len = combined.length;
      return;
    }
    const tail = combined.slice(-MAX_AGENT_STREAM_CHARS);
    pre.textContent = tail;
    state.len = tail.length;
  }

  function setBusy(busy) {
    inputEl.disabled = busy;
    sendBtn.disabled = busy;
    createPlanBtn.disabled = busy;
    if (busy) {
      createPlanBtn.textContent = "Generating…";
    } else {
      createPlanBtn.textContent = "Create plan";
    }
  }

  // ── Animated status (cooking phrases) ───────────────────────────────────────

  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  function startAnimatedStatus(runId, phrases) {
    if (animatedStatuses.has(runId)) {
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "row system";

    const bubble = document.createElement("div");
    bubble.className = "bubble system animated-status-bubble";

    const spinner = document.createElement("span");
    spinner.className = "animated-spinner";
    spinner.textContent = SPINNER_FRAMES[0];

    const textEl = document.createElement("span");
    textEl.className = "animated-phrase";
    textEl.textContent = phrases[0] || "Working…";

    bubble.appendChild(spinner);
    bubble.appendChild(document.createTextNode(" "));
    bubble.appendChild(textEl);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    let phraseIdx = 0;
    let spinIdx = 0;
    const intervalId = setInterval(() => {
      phraseIdx = (phraseIdx + 1) % phrases.length;
      spinIdx = (spinIdx + 1) % SPINNER_FRAMES.length;
      textEl.textContent = phrases[phraseIdx];
      spinner.textContent = SPINNER_FRAMES[spinIdx];
    }, 1800);

    animatedStatuses.set(runId, { wrap, intervalId });
  }

  function clearAnimatedStatus(runId) {
    const state = animatedStatuses.get(runId);
    if (!state) {
      return;
    }
    clearInterval(state.intervalId);
    state.wrap.remove();
    animatedStatuses.delete(runId);
  }

  // ── Run summary card ─────────────────────────────────────────────────────────

  function renderRunSummary(runId, summary) {
    clearAnimatedStatus(runId);

    const wrap = document.createElement("div");
    wrap.className = "row system run-summary-row";

    const card = document.createElement("div");
    card.className = "run-summary-card";

    // Header: ✓ / ✗ + label + duration
    const header = document.createElement("div");
    header.className = "run-summary-header";
    const icon = summary.exitCode === 0 ? "✓" : "✗";
    const dur =
      summary.durationSec >= 60
        ? `~${Math.floor(summary.durationSec / 60)}m ${summary.durationSec % 60}s`
        : `${summary.durationSec}s`;
    header.textContent = `${icon} ${summary.phaseLabel} · ${dur}`;
    card.appendChild(header);

    // Stats line
    const stats = document.createElement("div");
    stats.className = "run-summary-stats";
    const fc = summary.files.length;
    stats.textContent = `${fc} file${fc !== 1 ? "s" : ""} · +${summary.totalAdditions} / -${summary.totalDeletions}`;
    card.appendChild(stats);

    // Per-file rows
    if (summary.files.length > 0) {
      const fileList = document.createElement("div");
      fileList.className = "run-summary-files";

      for (const file of summary.files) {
        const row = document.createElement("div");
        row.className = "run-summary-file-row";

        const pathEl = document.createElement("span");
        pathEl.className = "run-summary-file-path";
        pathEl.textContent = file.path;
        pathEl.title = file.path;

        const diffEl = document.createElement("span");
        diffEl.className = "run-summary-file-diff";
        diffEl.textContent = `+${file.additions} / -${file.deletions}`;

        const diffBtn = document.createElement("button");
        diffBtn.className = "run-summary-diff-btn";
        diffBtn.textContent = "↗ diff";
        diffBtn.title = `Open diff for ${file.path}`;
        diffBtn.addEventListener("click", () => {
          vscode.postMessage({ type: "openFileDiff", filePath: file.path });
        });

        row.appendChild(pathEl);
        row.appendChild(diffEl);
        row.appendChild(diffBtn);
        fileList.appendChild(row);
      }

      card.appendChild(fileList);
    }

    // Source Control button
    const scmBtn = document.createElement("button");
    scmBtn.className = "run-summary-scm-btn";
    scmBtn.textContent = "Open Source Control";
    scmBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "openScm" });
    });
    card.appendChild(scmBtn);

    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Input / buttons ──────────────────────────────────────────────────────────

  function send() {
    const t = (inputEl.value || "").trim();
    if (!t) {
      return;
    }
    inputEl.value = "";
    vscode.postMessage({ type: "send", text: t });
  }

  function createPlan() {
    const t = (inputEl.value || "").trim();
    if (!t) {
      return;
    }
    vscode.postMessage({ type: "createPlan", text: t });
  }

  function stopAgents() {
    vscode.postMessage({ type: "stopAgents" });
  }

  sendBtn.addEventListener("click", send);
  createPlanBtn.addEventListener("click", createPlan);
  stopAgentsBtn.addEventListener("click", stopAgents);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ── Message dispatch ─────────────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }

    if (msg.type === "busy") {
      setBusy(!!msg.busy);
      return;
    }

    if (msg.type === "init") {
      messagesEl.innerHTML = "";
      agentStreams.clear();
      for (const [, state] of animatedStatuses) {
        clearInterval(state.intervalId);
      }
      animatedStatuses.clear();
      (msg.messages || []).forEach((m) => {
        if (m && (m.role === "user" || m.role === "system") && typeof m.text === "string") {
          appendBubble(m.role, m.text);
        }
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    if (msg.type === "append" && typeof msg.text === "string") {
      const role = msg.role === "system" ? "system" : "user";
      appendBubble(role, msg.text);
      return;
    }

    // ── Animated status ────────────────────────────────────────────────────────
    if (msg.type === "animatedStatus" && typeof msg.runId === "string" && Array.isArray(msg.phrases)) {
      startAnimatedStatus(msg.runId, msg.phrases);
      return;
    }

    // ── Run summary card ───────────────────────────────────────────────────────
    if (msg.type === "runSummary" && typeof msg.runId === "string" && msg.summary) {
      renderRunSummary(msg.runId, msg.summary);
      return;
    }

    // ── Agent stream ───────────────────────────────────────────────────────────
    if (msg.type === "agentStreamStart" && typeof msg.runId === "string") {
      const runId = msg.runId;
      clearAnimatedStatus(runId);
      if (agentStreams.has(runId)) {
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "row system agent-stream-row";
      wrap.dataset.runId = runId;

      const header = document.createElement("div");
      header.className = "agent-stream-header";
      const label = typeof msg.label === "string" ? msg.label : "Agent";
      const src =
        msg.source === "createPlan"
          ? "Create plan"
          : msg.source === "sendPrompt"
            ? "Send"
            : "Run phase";
      header.textContent = `${label} · ${src} · live`;

      const pre = document.createElement("pre");
      pre.className = "agent-stream";
      pre.setAttribute("aria-label", "Agent output stream");
      const defaultWait =
        "Waiting for agent stdout/stderr…\n\nIf this stays empty for a long time, the Cursor CLI may be buffering output until the run completes. Full log still goes to Output → Planstack.\n\n";
      const initial =
        typeof msg.initialLine === "string" && msg.initialLine.trim().length > 0
          ? msg.initialLine
          : defaultWait;
      pre.appendChild(document.createTextNode(initial));

      wrap.appendChild(header);
      wrap.appendChild(pre);
      messagesEl.appendChild(wrap);
      agentStreams.set(runId, { wrap, pre, len: initial.length });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    if (msg.type === "agentStreamAppend" && typeof msg.runId === "string" && typeof msg.text === "string") {
      const st = agentStreams.get(msg.runId);
      if (!st || !msg.text) {
        return;
      }
      const chunk = msg.stream === "stderr" ? "[stderr] " + msg.text : msg.text;
      capStreamText(st.pre, st, chunk);
      st.pre.scrollTop = st.pre.scrollHeight;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    if (msg.type === "agentStreamEnd" && typeof msg.runId === "string") {
      clearAnimatedStatus(msg.runId);
      const st = agentStreams.get(msg.runId);
      if (!st) {
        return;
      }
      st.wrap.classList.add("agent-stream-ended");
      const foot = document.createElement("div");
      foot.className = "agent-stream-footer";
      const r = msg.reason;
      foot.textContent =
        r === "stopped" ? "Stopped." : r === "error" ? "Ended with error." : "Finished.";
      st.wrap.appendChild(foot);
      agentStreams.delete(msg.runId);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
})();
