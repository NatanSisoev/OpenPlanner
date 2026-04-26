(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const createPlanBtn = document.getElementById("createPlan");
  const stopAgentsBtn = document.getElementById("stopAgents");
  const clearChatBtn = document.getElementById("clearChat");
  const executorProfileEl = document.getElementById("executorProfile");
  const mentionChipsEl = document.getElementById("mentionChips");
  const mentionSuggestEl = document.getElementById("mentionSuggest");

  const R = globalThis.__PS_RUN_UI || {
    glyph: "\u25b6",
    chatStreamRunPhase: "Run phase",
    chatStreamRunTask: "Run task",
    chatStreamCreatePlan: "Create plan",
    chatStreamSendPrompt: "Send prompt",
    cliPhaseDefaultStreamLabel: "Run phase",
    streamStartedSuffix: "started",
  };

  function svgIcon(d, extraCls) {
    const ns = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(ns, "svg");
    el.setAttribute("class", "ps-i " + (extraCls || ""));
    el.setAttribute("viewBox", "0 0 16 16");
    el.setAttribute("width", "14");
    el.setAttribute("height", "14");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "1.6");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = d;
    return el;
  }

  const PS_ICON_CHECK = '<path d="M3.5 8.5 L7 12 L12.5 4"/>';
  const PS_ICON_X = '<path d="M4 4 L12 12 M12 4 L4 12"/>';

  /** Max characters retained per run in the live <pre> (tail kept). */
  const MAX_AGENT_STREAM_CHARS = 400000;

  /** @type {Map<string, { wrap: HTMLElement; pre: HTMLPreElement; len: number; statusEl: HTMLElement; toggleBtn: HTMLButtonElement; footerTextEl: HTMLElement; collapsed: boolean }>} */
  const agentStreams = new Map();

  /** @type {Map<string, { wrap: HTMLElement; intervalId: ReturnType<typeof setInterval> }>} */
  const animatedStatuses = new Map();
  const MENTION_RE =
    /(^|[\s(])@(?:symbol:([A-Za-z0-9_$.]+)(?:@([A-Za-z0-9._\-\/]+))?(?::(\d+))?|(phase|task|folder|plan):([A-Za-z0-9._\-\/]+)|([A-Za-z0-9._\-\/]+))/g;
  const ACTIVE_MENTION_RE = /(^|[\s(])@((?:phase:|task:|plan:|symbol:|folder:)?[A-Za-z0-9._\-\/@:$]*)$/;
  let mentionSuggestState = {
    requestId: 0,
    latestHandledRequestId: 0,
    tokenStart: -1,
    tokenEnd: -1,
    tokenQuery: "",
    /** @type {{ kind: "file"|"folder"|"plan"|"phase"|"task"|"symbol"; insertText: string; label: string; detail?: string }[]} */
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

  function streamHeadForSource(source) {
    if (source === "createPlan") {
      return R.chatStreamCreatePlan;
    }
    if (source === "sendPrompt") {
      return R.chatStreamSendPrompt;
    }
    if (source === "runTask") {
      return R.chatStreamRunTask;
    }
    return R.chatStreamRunPhase;
  }

  function appendRunSeparator(label, source) {
    const shouldStick = isNearBottom(messagesEl);
    const row = document.createElement("div");
    row.className = "row system run-separator-row";
    const sep = document.createElement("div");
    sep.className = "run-separator";
    const lineA = document.createElement("span");
    lineA.className = "run-separator-line";
    const title = document.createElement("span");
    title.className = "run-separator-label";
    const head = typeof label === "string" && label.trim() ? label.trim() : streamHeadForSource(source);
    title.textContent = `${head} ${R.streamStartedSuffix}`;
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

  function extractMentions(text) {
    const out = [];
    const seen = new Set();
    let match;
    const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
    while ((match = re.exec(text)) !== null) {
      const symbolName = match[2];
      const symbolFile = match[3];
      const symbolLine = match[4];
      const entityKind = match[5];
      const entityBody = match[6];
      const fileBody = match[7];

      if (symbolName) {
        let raw = `symbol:${symbolName}`;
        if (symbolFile) {
          const cleanFile = symbolFile.replace(/\\/g, "/").replace(/^\.?\//, "");
          if (cleanFile) {
            raw += `@${cleanFile}`;
            if (symbolLine) {
              raw += `:${symbolLine}`;
            }
          }
        }
        if (seen.has(raw)) {
          continue;
        }
        seen.add(raw);
        out.push({ kind: "symbol", raw });
        continue;
      }

      if (entityKind && entityBody) {
        const body = entityBody.replace(/\\/g, "/").replace(/^\.?\//, "");
        if (!body) {
          continue;
        }
        const parts = body.split("/").filter(Boolean);
        if (entityKind === "phase" && parts.length !== 2) {
          continue;
        }
        if (entityKind === "task" && parts.length !== 3) {
          continue;
        }
        if (entityKind === "plan" && parts.length < 1) {
          continue;
        }
        if (entityKind === "folder" && parts.length < 1) {
          continue;
        }
        const raw = `${entityKind}:${body}`;
        if (seen.has(raw)) {
          continue;
        }
        seen.add(raw);
        out.push({ kind: entityKind, raw });
        continue;
      }

      if (fileBody) {
        const body = fileBody.replace(/\\/g, "/").replace(/^\.?\//, "");
        if (!body || seen.has(body)) {
          continue;
        }
        seen.add(body);
        out.push({ kind: "file", raw: body });
      }
    }
    return out;
  }

  function removeMention(raw) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`);
    const next = inputEl.value.replace(pattern, " ").replace(/\s{2,}/g, " ").trim();
    inputEl.value = next;
    renderMentionChips();
    requestMentionSuggestForCaret();
    inputEl.focus();
  }

  function renderMentionChips() {
    mentionChipsEl.innerHTML = "";
    const mentions = extractMentions(inputEl.value || "");
    if (mentions.length === 0) {
      return;
    }
    for (const m of mentions) {
      const chip = document.createElement("span");
      chip.className = `mention-chip mention-chip-${m.kind}`;
      const kindEl = document.createElement("span");
      kindEl.className = "mention-chip-kind";
      kindEl.textContent = m.kind;
      const labelEl = document.createElement("span");
      labelEl.className = "mention-chip-label";
      labelEl.textContent = `@${m.raw}`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mention-chip-remove";
      removeBtn.title = `Remove @${m.raw}`;
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", () => removeMention(m.raw));
      chip.appendChild(kindEl);
      chip.appendChild(labelEl);
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
      btn.className = `mention-suggest-item mention-suggest-${candidate.kind}${
        idx === mentionSuggestState.activeIndex ? " active" : ""
      }`;
      const kindEl = document.createElement("span");
      kindEl.className = "mention-suggest-kind";
      kindEl.textContent = candidate.kind;
      const labelEl = document.createElement("span");
      labelEl.className = "mention-suggest-label";
      labelEl.textContent = candidate.label;
      btn.appendChild(kindEl);
      btn.appendChild(labelEl);
      if (candidate.detail) {
        const detailEl = document.createElement("span");
        detailEl.className = "mention-suggest-detail";
        detailEl.textContent = candidate.detail;
        btn.appendChild(detailEl);
      }
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
    const insert = typeof candidate === "string" ? candidate : candidate.insertText;
    const text = inputEl.value || "";
    const insertion = `@${insert} `;
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
    const match = ACTIVE_MENTION_RE.exec(before);
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

    // Header: status icon + label + duration
    const header = document.createElement("div");
    header.className = "run-summary-header";
    const ok = summary.exitCode === 0;
    header.classList.add(ok ? "is-ok" : "is-failed");
    const dur =
      summary.durationSec >= 60
        ? `~${Math.floor(summary.durationSec / 60)}m ${summary.durationSec % 60}s`
        : `${summary.durationSec}s`;
    header.appendChild(svgIcon(ok ? PS_ICON_CHECK : PS_ICON_X, ok ? "ps-i-ok" : "ps-i-failed"));
    const headerText = document.createElement("span");
    headerText.className = "run-summary-header-text";
    headerText.textContent = `${summary.phaseLabel} · ${dur}`;
    header.appendChild(headerText);
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
    header.className = "run-summary-header is-failed";
    header.appendChild(svgIcon(PS_ICON_X, "ps-i-failed"));
    const headerText = document.createElement("span");
    headerText.className = "run-summary-header-text";
    headerText.textContent = `${failure.phaseLabel} · ${failure.durationSec}s`;
    header.appendChild(headerText);
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
    inputEl.value = "";
    closeMentionSuggest();
    renderMentionChips();
    vscode.postMessage({ type: "createPlan", text: t });
  }

  function stopAgents() {
    vscode.postMessage({ type: "stopAgents" });
  }

  function clearChat() {
    if (!window.confirm("Clear chat history? This cannot be undone.")) {
      return;
    }
    vscode.postMessage({ type: "clearChat" });
  }

  sendBtn.addEventListener("click", send);
  createPlanBtn.addEventListener("click", createPlan);
  stopAgentsBtn.addEventListener("click", stopAgents);
  if (clearChatBtn) {
    clearChatBtn.addEventListener("click", clearChat);
  }
  if (executorProfileEl) {
    executorProfileEl.addEventListener("change", () => {
      vscode.postMessage({ type: "setExecutorProfile", profile: executorProfileEl.value });
    });
  }
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
      if (executorProfileEl && typeof msg.executorProfile === "string") {
        executorProfileEl.value = msg.executorProfile;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    if (msg.type === "executorProfile" && typeof msg.profile === "string") {
      if (executorProfileEl) {
        executorProfileEl.value = msg.profile;
      }
      return;
    }

    if (msg.type === "append" && typeof msg.text === "string") {
      const role = msg.role === "system" ? "system" : "user";
      appendBubble(role, msg.text, typeof msg.timestampIso === "string" ? msg.timestampIso : "");
      return;
    }

    if (msg.type === "mentionSuggestResult" && typeof msg.requestId === "string") {
      const id = Number(msg.requestId);
      if (!Number.isFinite(id) || id < mentionSuggestState.latestHandledRequestId) {
        return;
      }
      mentionSuggestState.latestHandledRequestId = id;
      const incoming = Array.isArray(msg.suggestions)
        ? msg.suggestions
        : Array.isArray(msg.candidates)
        ? msg.candidates.map((c) => (typeof c === "string" ? { kind: "file", insertText: c, label: c } : c))
        : [];
      const cleaned = incoming
        .filter((c) => c && typeof c === "object" && typeof c.insertText === "string" && typeof c.label === "string")
        .map((c) => ({
          kind:
            c.kind === "phase" ||
            c.kind === "task" ||
            c.kind === "plan" ||
            c.kind === "symbol" ||
            c.kind === "folder"
              ? c.kind
              : "file",
          insertText: c.insertText,
          label: c.label,
          detail: typeof c.detail === "string" ? c.detail : undefined,
        }))
        .slice(0, 12);
      const prevActive = mentionSuggestState.candidates[mentionSuggestState.activeIndex];
      const prevKey = prevActive ? `${prevActive.kind}|${prevActive.insertText}` : "";
      mentionSuggestState.candidates = cleaned;
      const preservedIdx = prevKey
        ? cleaned.findIndex((c) => `${c.kind}|${c.insertText}` === prevKey)
        : -1;
      mentionSuggestState.activeIndex = preservedIdx >= 0 ? preservedIdx : 0;
      mentionSuggestState.open = cleaned.length > 0;
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
      appendRunSeparator(typeof msg.label === "string" ? msg.label : "", msg.source);
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
          ? R.chatStreamCreatePlan
          : msg.source === "sendPrompt"
            ? R.chatStreamSendPrompt
            : msg.source === "runTask"
              ? R.chatStreamRunTask
              : R.chatStreamRunPhase;
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
        setStreamCollapsed(st, false);
      }
      agentStreams.delete(msg.runId);
      if (isNearBottom(messagesEl)) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }
  });
  renderMentionChips();
})();
