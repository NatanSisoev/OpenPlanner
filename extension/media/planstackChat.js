(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const createPlanBtn = document.getElementById("createPlan");
  const stopAgentsBtn = document.getElementById("stopAgents");
  const mentionChipsEl = document.getElementById("mentionChips");
  const mentionSuggestEl = document.getElementById("mentionSuggest");

  /** Max characters retained per run in the live <pre> (tail kept). */
  const MAX_AGENT_STREAM_CHARS = 400000;

  /** @type {Map<string, { wrap: HTMLElement; pre: HTMLPreElement; len: number; statusEl: HTMLElement; toggleBtn: HTMLButtonElement; footerTextEl: HTMLElement; collapsed: boolean }>} */
  const agentStreams = new Map();

  /** @type {Map<string, { wrap: HTMLElement; intervalId: ReturnType<typeof setInterval> }>} */
  const animatedStatuses = new Map();
  const MENTION_PATH_RE = /(^|[\s(])@([A-Za-z0-9._\-\/]+)/g;
  let mentionSuggestState = {
    requestId: 0,
    latestHandledRequestId: 0,
    tokenStart: -1,
    tokenEnd: -1,
    tokenQuery: "",
    candidates: [],
    activeIndex: 0,
    open: false,
  };
  let mentionSuggestDebounceTimer = undefined;

  function formatTimestamp(timestampIso) {
    if (!timestampIso || typeof timestampIso !== "string") {
      return "";
    }
    const d = new Date(timestampIso);
    if (Number.isNaN(d.getTime())) {
      return "";
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function appendBubble(role, text, timestampIso) {
    const shouldStick = isNearBottom(messagesEl);
    const wrap = document.createElement("div");
    wrap.className = role === "system" ? "row system" : "row user";
    const bubble = document.createElement("div");
    bubble.className = role === "system" ? "bubble system" : "bubble user";
    const body = document.createElement("div");
    body.className = "bubble-text";
    body.textContent = text;
    bubble.appendChild(body);
    const ts = formatTimestamp(timestampIso);
    if (ts) {
      const meta = document.createElement("div");
      meta.className = "bubble-meta";
      meta.textContent = ts;
      bubble.appendChild(meta);
    }
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    if (shouldStick) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function appendRunSeparator(label) {
    const shouldStick = isNearBottom(messagesEl);
    const row = document.createElement("div");
    row.className = "row system run-separator-row";
    const sep = document.createElement("div");
    sep.className = "run-separator";
    const lineA = document.createElement("span");
    lineA.className = "run-separator-line";
    const title = document.createElement("span");
    title.className = "run-separator-label";
    title.textContent = `${label || "Run"} started`;
    const lineB = document.createElement("span");
    lineB.className = "run-separator-line";
    sep.appendChild(lineA);
    sep.appendChild(title);
    sep.appendChild(lineB);
    row.appendChild(sep);
    messagesEl.appendChild(row);
    if (shouldStick) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function isNearBottom(el, thresholdPx = 80) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }

  function setStreamCollapsed(st, collapsed) {
    st.collapsed = !!collapsed;
    st.wrap.classList.toggle("agent-stream-collapsed", st.collapsed);
    st.toggleBtn.textContent = st.collapsed ? "Expand" : "Collapse";
  }

  function setStreamStatus(st, statusLabel, statusClass) {
    st.statusEl.textContent = statusLabel;
    st.statusEl.className = `agent-stream-status ${statusClass}`;
  }

  function capStreamText(pre, state, add) {
    const combined = state.raw + add;
    if (combined.length <= MAX_AGENT_STREAM_CHARS) {
      state.raw = combined;
      state.len = state.raw.length;
      pre.innerHTML = renderAgentMarkdown(state.raw);
      return;
    }
    const tail = combined.slice(-MAX_AGENT_STREAM_CHARS);
    state.raw = tail;
    state.len = tail.length;
    pre.innerHTML = renderAgentMarkdown(state.raw);
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInlineMarkdown(text) {
    if (!text) {
      return "";
    }
    const codeTokens = [];
    let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_m, inner) => {
      const idx = codeTokens.length;
      codeTokens.push(`<code>${inner}</code>`);
      return `@@CODE_TOKEN_${idx}@@`;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/^### (.+)$/gm, "<strong>$1</strong>");
    out = out.replace(/^## (.+)$/gm, "<strong>$1</strong>");
    out = out.replace(/^# (.+)$/gm, "<strong>$1</strong>");
    out = out.replace(/^[-*] (.+)$/gm, "• $1");
    out = out.replace(/^> (.+)$/gm, "› $1");
    out = out.replace(/@@CODE_TOKEN_(\d+)@@/g, (_m, n) => {
      const idx = Number(n);
      return codeTokens[idx] || "";
    });
    return out;
  }

  function renderAgentMarkdown(raw) {
    if (!raw) {
      return "";
    }
    const chunks = [];
    let i = 0;
    while (i < raw.length) {
      const fenceStart = raw.indexOf("```", i);
      if (fenceStart === -1) {
        chunks.push(renderInlineMarkdown(raw.slice(i)));
        break;
      }
      if (fenceStart > i) {
        chunks.push(renderInlineMarkdown(raw.slice(i, fenceStart)));
      }
      const fenceEnd = raw.indexOf("```", fenceStart + 3);
      if (fenceEnd === -1) {
        chunks.push(`<span class="agent-md-fence">${escapeHtml(raw.slice(fenceStart + 3))}</span>`);
        break;
      }
      const fenced = raw.slice(fenceStart + 3, fenceEnd).replace(/^\w+\n/, "");
      chunks.push(`<span class="agent-md-fence">${escapeHtml(fenced)}</span>`);
      i = fenceEnd + 3;
    }
    return chunks.join("");
  }

  function setBusy(busy, source) {
    inputEl.disabled = busy;
    sendBtn.disabled = busy;
    createPlanBtn.disabled = busy;
    stopAgentsBtn.disabled = false;
    if (busy) {
      createPlanBtn.textContent = source === "sendPrompt" ? "Applying edits…" : "Creating plan…";
    } else {
      createPlanBtn.textContent = "Create plan";
    }
    if (busy) {
      closeMentionSuggest();
    }
  }

  function extractMentionPaths(text) {
    const out = [];
    const seen = new Set();
    let match;
    while ((match = MENTION_PATH_RE.exec(text)) !== null) {
      const p = (match[2] || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!p || seen.has(p)) {
        continue;
      }
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  function removeMentionPath(path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`);
    const next = inputEl.value.replace(pattern, " ").replace(/\s{2,}/g, " ").trim();
    inputEl.value = next;
    renderMentionChips();
    requestMentionSuggestForCaret();
    inputEl.focus();
  }

  function renderMentionChips() {
    mentionChipsEl.innerHTML = "";
    const paths = extractMentionPaths(inputEl.value || "");
    if (paths.length === 0) {
      return;
    }
    for (const path of paths) {
      const chip = document.createElement("span");
      chip.className = "mention-chip";
      chip.textContent = `@${path}`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mention-chip-remove";
      removeBtn.title = `Remove @${path}`;
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", () => removeMentionPath(path));
      chip.appendChild(removeBtn);
      mentionChipsEl.appendChild(chip);
    }
  }

  function closeMentionSuggest() {
    mentionSuggestState.open = false;
    mentionSuggestState.candidates = [];
    mentionSuggestState.activeIndex = 0;
    mentionSuggestEl.classList.remove("show");
    mentionSuggestEl.innerHTML = "";
  }

  function renderMentionSuggest() {
    mentionSuggestEl.innerHTML = "";
    if (!mentionSuggestState.open || mentionSuggestState.candidates.length === 0) {
      mentionSuggestEl.classList.remove("show");
      return;
    }
    mentionSuggestEl.classList.add("show");
    mentionSuggestState.candidates.forEach((candidate, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mention-suggest-item${idx === mentionSuggestState.activeIndex ? " active" : ""}`;
      btn.textContent = candidate;
      btn.addEventListener("mouseenter", () => {
        mentionSuggestState.activeIndex = idx;
        renderMentionSuggest();
      });
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyMentionCandidate(candidate);
      });
      mentionSuggestEl.appendChild(btn);
    });
  }

  function applyMentionCandidate(candidate) {
    const start = mentionSuggestState.tokenStart;
    const end = mentionSuggestState.tokenEnd;
    if (start < 0 || end < start) {
      closeMentionSuggest();
      return;
    }
    const text = inputEl.value || "";
    const insertion = `@${candidate} `;
    inputEl.value = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
    const caret = start + insertion.length;
    inputEl.focus();
    inputEl.setSelectionRange(caret, caret);
    closeMentionSuggest();
    renderMentionChips();
  }

  function getActiveMentionToken() {
    const value = inputEl.value || "";
    const caret = inputEl.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = /(^|[\s(])@([A-Za-z0-9._\-\/]*)$/.exec(before);
    if (!match) {
      return null;
    }
    const query = match[2] || "";
    const atIndex = caret - query.length - 1;
    return { query, start: atIndex, end: caret };
  }

  function requestMentionSuggestForCaret() {
    if (mentionSuggestDebounceTimer) {
      clearTimeout(mentionSuggestDebounceTimer);
    }
    mentionSuggestDebounceTimer = setTimeout(() => {
      const token = getActiveMentionToken();
      if (!token) {
        closeMentionSuggest();
        return;
      }
      mentionSuggestState.tokenStart = token.start;
      mentionSuggestState.tokenEnd = token.end;
      mentionSuggestState.tokenQuery = token.query;
      mentionSuggestState.requestId += 1;
      const requestId = String(mentionSuggestState.requestId);
      vscode.postMessage({
        type: "mentionSuggest",
        requestId,
        query: token.query,
      });
    }, 80);
  }

  function shouldSkipMentionRefreshOnKeyup(e) {
    if (!e || typeof e.key !== "string") {
      return false;
    }
    return (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "Enter" ||
      e.key === "Escape" ||
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Alt" ||
      e.key === "Meta"
    );
  }

  // ── Animated status (cooking phrases) ───────────────────────────────────────

  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  function startAnimatedStatus(runId, phrases) {
    if (animatedStatuses.has(runId)) {
      return;
    }

    const shouldStick = isNearBottom(messagesEl);
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
    if (shouldStick) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

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
    const shouldStick = isNearBottom(messagesEl);

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

    // Stats line (same + / − colors as per-file rows below)
    const stats = document.createElement("div");
    stats.className = "run-summary-stats";
    const fc = summary.files.length;
    const prefix = document.createElement("span");
    prefix.className = "run-summary-stats-prefix";
    prefix.textContent = `${fc} file${fc !== 1 ? "s" : ""} · `;
    const diffWrap = document.createElement("span");
    diffWrap.className = "run-summary-file-diff";
    const addTot = document.createElement("span");
    addTot.className = "run-summary-file-diff-add";
    addTot.textContent = `+${summary.totalAdditions}`;
    const sepTot = document.createElement("span");
    sepTot.className = "run-summary-file-diff-sep";
    sepTot.textContent = " / ";
    const delTot = document.createElement("span");
    delTot.className = "run-summary-file-diff-del";
    delTot.textContent = `-${summary.totalDeletions}`;
    diffWrap.appendChild(addTot);
    diffWrap.appendChild(sepTot);
    diffWrap.appendChild(delTot);
    stats.appendChild(prefix);
    stats.appendChild(diffWrap);
    card.appendChild(stats);

    // Per-file rows
    if (summary.files.length > 0) {
      const fileList = document.createElement("div");
      fileList.className = "run-summary-files";

      for (const file of summary.files) {
        const row = document.createElement("div");
        row.className = "run-summary-file-row";
        const openPath = typeof file.path === "string" ? file.path : "";
        const displayPath =
          typeof file.displayPath === "string" && file.displayPath.trim().length > 0
            ? file.displayPath
            : openPath;

        const pathEl = document.createElement("span");
        pathEl.className = "run-summary-file-path";
        pathEl.textContent = displayPath;
        pathEl.title = displayPath;

        const diffEl = document.createElement("span");
        diffEl.className = "run-summary-file-diff";
        const addEl = document.createElement("span");
        addEl.className = "run-summary-file-diff-add";
        addEl.textContent = `+${file.additions}`;
        const sepEl = document.createElement("span");
        sepEl.className = "run-summary-file-diff-sep";
        sepEl.textContent = " / ";
        const delEl = document.createElement("span");
        delEl.className = "run-summary-file-diff-del";
        delEl.textContent = `-${file.deletions}`;
        diffEl.appendChild(addEl);
        diffEl.appendChild(sepEl);
        diffEl.appendChild(delEl);

        const diffBtn = document.createElement("button");
        diffBtn.className = "run-summary-diff-btn";
        diffBtn.textContent = "↗ diff";
        diffBtn.title = `Open diff for ${displayPath}`;
        diffBtn.disabled = !openPath;
        diffBtn.addEventListener("click", () => {
          if (!openPath) {
            return;
          }
          vscode.postMessage({ type: "openFileDiff", filePath: openPath });
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
    if (shouldStick) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function renderRunFailure(runId, failure) {
    clearAnimatedStatus(runId);
    const shouldStick = isNearBottom(messagesEl);
    const wrap = document.createElement("div");
    wrap.className = "row system run-summary-row";
    const card = document.createElement("div");
    card.className = "run-summary-card run-failure-card";

    const header = document.createElement("div");
    header.className = "run-summary-header";
    header.textContent = `✗ ${failure.phaseLabel} · ${failure.durationSec}s`;
    card.appendChild(header);

    const stats = document.createElement("div");
    stats.className = "run-summary-stats";
    stats.textContent = failure.summary || "Run failed.";
    card.appendChild(stats);

    if (failure.details) {
      const details = document.createElement("pre");
      details.className = "run-failure-details";
      details.textContent = failure.details;
      card.appendChild(details);
    }

    const actions = document.createElement("div");
    actions.className = "run-failure-actions";

    const mkBtn = (label, onClick) => {
      const btn = document.createElement("button");
      btn.className = "run-summary-diff-btn";
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      return btn;
    };

    actions.appendChild(
      mkBtn("Retry", () => {
        if (typeof failure.retryPrompt === "string" && failure.retryPrompt.trim()) {
          vscode.postMessage({ type: "retryPrompt", prompt: failure.retryPrompt });
        }
      }),
    );
    actions.appendChild(mkBtn("Open Output", () => vscode.postMessage({ type: "openOutput" })));
    actions.appendChild(mkBtn("Debug CLI", () => vscode.postMessage({ type: "debugCliConnection" })));
    actions.appendChild(mkBtn("Open Source Control", () => vscode.postMessage({ type: "openScm" })));
    actions.appendChild(
      mkBtn("Copy details", () => {
        const text = `${failure.summary}\n${failure.details || ""}`.trim();
        if (!text) {
          return;
        }
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).catch(() => {
            vscode.postMessage({ type: "copyText", text });
          });
        } else {
          vscode.postMessage({ type: "copyText", text });
        }
      }),
    );
    card.appendChild(actions);
    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    if (shouldStick) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ── Input / buttons ──────────────────────────────────────────────────────────

  function send() {
    const t = (inputEl.value || "").trim();
    if (!t) {
      return;
    }
    inputEl.value = "";
    closeMentionSuggest();
    renderMentionChips();
    vscode.postMessage({ type: "send", text: t });
  }

  function createPlan() {
    const t = (inputEl.value || "").trim();
    if (!t) {
      return;
    }
    vscode.postMessage({ type: "createPlan", text: t });
    closeMentionSuggest();
    renderMentionChips();
  }

  function stopAgents() {
    vscode.postMessage({ type: "stopAgents" });
  }

  sendBtn.addEventListener("click", send);
  createPlanBtn.addEventListener("click", createPlan);
  stopAgentsBtn.addEventListener("click", stopAgents);
  inputEl.addEventListener("input", () => {
    renderMentionChips();
    requestMentionSuggestForCaret();
  });
  inputEl.addEventListener("click", requestMentionSuggestForCaret);
  inputEl.addEventListener("keyup", (e) => {
    if (shouldSkipMentionRefreshOnKeyup(e)) {
      return;
    }
    requestMentionSuggestForCaret();
  });
  inputEl.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== mentionSuggestEl) {
        closeMentionSuggest();
      }
    }, 120);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (mentionSuggestState.open && mentionSuggestState.candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionSuggestState.activeIndex =
          (mentionSuggestState.activeIndex + 1) % mentionSuggestState.candidates.length;
        renderMentionSuggest();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionSuggestState.activeIndex =
          (mentionSuggestState.activeIndex - 1 + mentionSuggestState.candidates.length) %
          mentionSuggestState.candidates.length;
        renderMentionSuggest();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const chosen = mentionSuggestState.candidates[mentionSuggestState.activeIndex];
        if (chosen) {
          applyMentionCandidate(chosen);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentionSuggest();
        return;
      }
    }
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
      setBusy(!!msg.busy, typeof msg.source === "string" ? msg.source : "");
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
          appendBubble(m.role, m.text, typeof m.timestampIso === "string" ? m.timestampIso : "");
        }
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    if (msg.type === "append" && typeof msg.text === "string") {
      const role = msg.role === "system" ? "system" : "user";
      appendBubble(role, msg.text, typeof msg.timestampIso === "string" ? msg.timestampIso : "");
      return;
    }

    if (msg.type === "mentionSuggestResult" && typeof msg.requestId === "string" && Array.isArray(msg.candidates)) {
      const id = Number(msg.requestId);
      if (!Number.isFinite(id) || id < mentionSuggestState.latestHandledRequestId) {
        return;
      }
      mentionSuggestState.latestHandledRequestId = id;
      const prevActive = mentionSuggestState.candidates[mentionSuggestState.activeIndex] || "";
      mentionSuggestState.candidates = msg.candidates.filter((x) => typeof x === "string").slice(0, 12);
      const preservedIdx = prevActive ? mentionSuggestState.candidates.indexOf(prevActive) : -1;
      mentionSuggestState.activeIndex = preservedIdx >= 0 ? preservedIdx : 0;
      mentionSuggestState.open = mentionSuggestState.candidates.length > 0;
      renderMentionSuggest();
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
    if (msg.type === "runFailure" && typeof msg.runId === "string" && msg.failure) {
      renderRunFailure(msg.runId, msg.failure);
      return;
    }

    // ── Agent stream ───────────────────────────────────────────────────────────
    if (msg.type === "agentStreamStart" && typeof msg.runId === "string") {
      const runId = msg.runId;
      clearAnimatedStatus(runId);
      if (agentStreams.has(runId)) {
        return;
      }
      appendRunSeparator(typeof msg.label === "string" ? msg.label : "Run");
      const shouldStick = isNearBottom(messagesEl);
      const wrap = document.createElement("div");
      wrap.className = "row system agent-stream-row";
      wrap.dataset.runId = runId;

      const header = document.createElement("div");
      header.className = "agent-stream-header";

      const headerMain = document.createElement("div");
      headerMain.className = "agent-stream-header-main";
      const label = typeof msg.label === "string" ? msg.label : "Agent";
      const src =
        msg.source === "createPlan"
          ? "Create plan"
          : msg.source === "sendPrompt"
            ? "Send"
            : msg.source === "runTask"
              ? "Run task"
            : "Run phase";
      const title = document.createElement("span");
      title.className = "agent-stream-title";
      title.textContent = label;
      const source = document.createElement("span");
      source.className = "agent-stream-source";
      source.textContent = src;
      headerMain.appendChild(title);
      headerMain.appendChild(source);

      const headerActions = document.createElement("div");
      headerActions.className = "agent-stream-header-main";
      headerActions.style.flexShrink = "0";
      const status = document.createElement("span");
      setStreamStatus({ statusEl: status }, "LIVE", "live");
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "agent-stream-toggle";
      toggleBtn.textContent = "Collapse";
      headerActions.appendChild(status);
      headerActions.appendChild(toggleBtn);

      header.appendChild(headerMain);
      header.appendChild(headerActions);

      const pre = document.createElement("pre");
      pre.className = "agent-stream";
      pre.setAttribute("aria-label", "Agent output stream");
      const initial =
        typeof msg.initialLine === "string" && msg.initialLine.trim().length > 0
          ? msg.initialLine
          : "";
      if (initial.length > 0) {
        pre.innerHTML = renderAgentMarkdown(initial);
      }

      const footer = document.createElement("div");
      footer.className = "agent-stream-footer";
      const footerText = document.createElement("span");
      footerText.textContent = "Running…";
      footer.appendChild(footerText);

      wrap.appendChild(header);
      wrap.appendChild(pre);
      wrap.appendChild(footer);
      messagesEl.appendChild(wrap);
      const state = {
        wrap,
        pre,
        len: initial.length,
        raw: initial,
        statusEl: status,
        toggleBtn,
        footerTextEl: footerText,
        collapsed: false,
      };
      toggleBtn.addEventListener("click", () => setStreamCollapsed(state, !state.collapsed));
      agentStreams.set(runId, state);
      if (shouldStick) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      return;
    }

    if (msg.type === "agentStreamAppend" && typeof msg.runId === "string" && typeof msg.text === "string") {
      const st = agentStreams.get(msg.runId);
      if (!st || !msg.text) {
        return;
      }
      const shouldStick = isNearBottom(messagesEl);
      const chunk = msg.stream === "stderr" ? "[stderr] " + msg.text : msg.text;
      capStreamText(st.pre, st, chunk);
      if (!st.collapsed) {
        st.pre.scrollTop = st.pre.scrollHeight;
      }
      if (shouldStick) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      return;
    }

    if (msg.type === "agentStreamEnd" && typeof msg.runId === "string") {
      clearAnimatedStatus(msg.runId);
      const st = agentStreams.get(msg.runId);
      if (!st) {
        return;
      }
      const r = msg.reason;
      if (r === "stopped") {
        setStreamStatus(st, "STOPPED", "stopped");
        st.footerTextEl.textContent = "Stopped.";
        setStreamCollapsed(st, false);
      } else if (r === "error") {
        setStreamStatus(st, "ERROR", "error");
        st.footerTextEl.textContent = "Ended with error.";
        setStreamCollapsed(st, false);
      } else {
        setStreamStatus(st, "FINISHED", "finished");
        st.footerTextEl.textContent = "";
        setStreamCollapsed(st, true);
      }
      agentStreams.delete(msg.runId);
      if (isNearBottom(messagesEl)) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }
  });
  renderMentionChips();
})();
