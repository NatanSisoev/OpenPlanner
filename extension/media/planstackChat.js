(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const createPlanBtn = document.getElementById("createPlan");

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

  sendBtn.addEventListener("click", send);
  createPlanBtn.addEventListener("click", createPlan);
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
    }
  });
})();
