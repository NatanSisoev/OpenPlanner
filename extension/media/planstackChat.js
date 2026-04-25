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
    if (msg.type === "agentStreamStart" && typeof msg.runId === "string") {
      const runId = msg.runId;
      if (agentStreams.has(runId)) {
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "row system agent-stream-row";
      wrap.dataset.runId = runId;

      const header = document.createElement("div");
      header.className = "agent-stream-header";
      const label = typeof msg.label === "string" ? msg.label : "Agent";
      const src = msg.source === "createPlan" ? "Create plan" : "Run phase";
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
