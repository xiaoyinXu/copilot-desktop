// @ts-check
/// <reference types="../../../node_modules/electron" />

/**
 * Copilot Desktop - Renderer
 * @typedef {{ init: () => Promise<any>, listModels: () => Promise<any>, createSession: (opts: any) => Promise<any>, send: (opts: any) => Promise<any>, abort: (opts: any) => Promise<any>, listSessions: () => Promise<any>, stop: () => Promise<any>, openFolder: () => Promise<string|null>, onEvent: (cb: (e: any) => void) => () => void, store: { listSessions: () => Promise<any>, saveSession: (opts: any) => Promise<any>, loadSession: (opts: any) => Promise<any>, deleteSession: (opts: any) => Promise<any> } }} CopilotAPI
 */

/** @type {CopilotAPI} */
const api = /** @type {any} */ (window).copilot;

// --- State ---
let currentSessionId = null;
let currentCwd = null;
let isProcessing = false;
let streamingContent = "";
let streamingEl = null;
/** @type {Array<{role: string, content: string, timestamp: number}>} */
let currentMessages = [];

// --- DOM Elements ---
const $messages = document.getElementById("messages");
const $welcome = document.getElementById("welcome");
const $input = document.getElementById("prompt-input");
const $sendBtn = document.getElementById("send-btn");
const $abortBtn = document.getElementById("abort-btn");
const $statusDot = document.querySelector(".status-dot");
const $statusText = document.querySelector(".status-text");
const $modelSelect = document.getElementById("model-select");
const $cwdLabel = document.getElementById("cwd-label");
const $openFolderBtn = document.getElementById("open-folder-btn");
const $newChatBtn = document.getElementById("new-chat-btn");
const $sessionInfo = document.getElementById("session-info");
const $sessionsList = document.getElementById("sessions-list");

// --- Initialize ---
async function init() {
  setStatus("connecting", "正在连接 Copilot...");
  const result = await api.init();
  if (result.success) {
    setStatus("connected", "已连接");
    // Try to load models
    try {
      const modelsResult = await api.listModels();
      if (modelsResult.success && modelsResult.models) {
        populateModels(modelsResult.models);
      }
    } catch {}
    // Load persisted sessions into sidebar
    await refreshSessionsList();
  } else {
    setStatus("error", `连接失败: ${result.error}`);
    showError(result.error);
  }
}

function populateModels(models) {
  if (!models || !models.length) return;
  $modelSelect.innerHTML = "";
  const preferred = ["claude-sonnet-4.5", "gpt-5", "claude-sonnet-4", "gpt-4.1"];
  const sorted = [...models].sort((a, b) => {
    const aIdx = preferred.indexOf(a.id || a);
    const bIdx = preferred.indexOf(b.id || b);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return 0;
  });
  for (const m of sorted) {
    const id = m.id || m;
    const name = m.name || id;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    $modelSelect.appendChild(opt);
  }
}

function setStatus(state, text) {
  $statusDot.className = "status-dot " + (state === "connected" ? "connected" : state === "error" ? "error" : "");
  $statusText.textContent = text;
}

// --- Session Management ---
async function createSession() {
  const model = $modelSelect.value;
  const opts = { model };
  if (currentCwd) opts.cwd = currentCwd;

  setStatus("connecting", "正在创建会话...");
  const result = await api.createSession(opts);
  if (result.success) {
    currentSessionId = result.sessionId;
    currentMessages = [];
    $sessionInfo.textContent = `会话: ${currentSessionId.slice(0, 8)}...`;
    setStatus("connected", "就绪");
    // Show messages, hide welcome
    $welcome.style.display = "none";
    $messages.style.display = "flex";
    $messages.innerHTML = "";
    return true;
  } else {
    setStatus("error", result.error);
    showError("创建会话失败: " + result.error);
    return false;
  }
}

// --- Sending Messages ---
async function sendMessage(prompt) {
  if (!prompt.trim() || isProcessing) return;

  // Create session if needed
  if (!currentSessionId) {
    const ok = await createSession();
    if (!ok) return;
  }

  isProcessing = true;
  updateInputState();

  // Add user message
  addMessage("user", prompt);
  currentMessages.push({ role: "user", content: prompt, timestamp: Date.now() });
  persistCurrentSession();

  // Clear input
  $input.value = "";
  autoResize();

  // Add typing indicator
  const typingEl = addTypingIndicator();

  // Send to Copilot (use SDK session ID if this is a restored session)
  const sdkSid = sdkSessionMap[currentSessionId] || currentSessionId;
  const result = await api.send({ sessionId: sdkSid, prompt });
  if (!result.success) {
    typingEl?.remove();
    isProcessing = false;
    updateInputState();
    showError("发送失败: " + result.error);
  }
}

// --- Event Handling ---
api.onEvent((event) => {
  // Match event to current session (could be SDK session ID for restored sessions)
  const sdkSid = sdkSessionMap[currentSessionId] || currentSessionId;
  if (event.sessionId !== currentSessionId && event.sessionId !== sdkSid) return;

  switch (event.type) {
    case "delta":
      // Remove typing indicator
      removeTypingIndicator();
      // Append to streaming message
      if (!streamingEl) {
        streamingEl = addMessage("assistant", "");
        streamingContent = "";
      }
      streamingContent += event.content;
      updateMessageContent(streamingEl, streamingContent);
      scrollToBottom();
      break;

    case "message":
      removeTypingIndicator();
      if (streamingEl) {
        // Final message - update with complete content
        updateMessageContent(streamingEl, event.content);
        streamingEl = null;
        streamingContent = "";
      } else {
        addMessage("assistant", event.content);
      }
      // Persist assistant message
      currentMessages.push({ role: "assistant", content: event.content, timestamp: Date.now() });
      persistCurrentSession();
      scrollToBottom();
      break;

    case "tool_start":
      removeTypingIndicator();
      addToolIndicator(event.tool, false);
      scrollToBottom();
      break;

    case "tool_complete":
      markToolComplete(event.tool);
      break;

    case "idle":
      isProcessing = false;
      streamingEl = null;
      streamingContent = "";
      updateInputState();
      removeTypingIndicator();
      break;
  }
});

// --- DOM Helpers ---
function addMessage(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "你" : "Copilot";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  contentEl.textContent = content;

  wrapper.appendChild(label);
  wrapper.appendChild(contentEl);
  $messages.appendChild(wrapper);
  scrollToBottom();
  return contentEl;
}

function updateMessageContent(el, content) {
  if (!el) return;
  // Simple markdown-like rendering for code blocks
  el.innerHTML = renderContent(content);
}

function renderContent(text) {
  if (!text) return "";
  // Escape HTML
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Line breaks
  html = html.replace(/\n/g, "<br>");

  return html;
}

function addTypingIndicator() {
  removeTypingIndicator();
  const el = document.createElement("div");
  el.className = "typing-indicator";
  el.id = "typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  $messages.appendChild(el);
  scrollToBottom();
  return el;
}

function removeTypingIndicator() {
  document.getElementById("typing")?.remove();
}

function addToolIndicator(toolName, done) {
  const el = document.createElement("div");
  el.className = `tool-indicator ${done ? "done" : ""}`;
  el.dataset.tool = toolName;
  el.innerHTML = `
    <div class="spinner"></div>
    <span>🔧 ${escapeHtml(toolName)}</span>
  `;
  $messages.appendChild(el);
  return el;
}

function markToolComplete(toolName) {
  const indicators = $messages.querySelectorAll(`.tool-indicator[data-tool="${toolName}"]:not(.done)`);
  indicators.forEach((el) => {
    el.classList.add("done");
    el.querySelector(".spinner").innerHTML = "✓";
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
}

function updateInputState() {
  $sendBtn.style.display = isProcessing ? "none" : "flex";
  $abortBtn.style.display = isProcessing ? "flex" : "none";
  $sendBtn.disabled = isProcessing;
  $input.disabled = isProcessing;
  if (!isProcessing) $input.focus();
}

function autoResize() {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 200) + "px";
}

function showError(msg) {
  const toast = document.createElement("div");
  toast.className = "error-toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// --- Event Listeners ---
$input.addEventListener("input", autoResize);

$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage($input.value);
  }
});

$sendBtn.addEventListener("click", () => {
  sendMessage($input.value);
});

$abortBtn.addEventListener("click", async () => {
  if (currentSessionId) {
    const sdkSid = sdkSessionMap[currentSessionId] || currentSessionId;
    await api.abort({ sessionId: sdkSid });
  }
});

$newChatBtn.addEventListener("click", async () => {
  currentSessionId = null;
  currentMessages = [];
  streamingEl = null;
  streamingContent = "";
  isProcessing = false;
  updateInputState();
  $messages.style.display = "none";
  $messages.innerHTML = "";
  $welcome.style.display = "flex";
  $sessionInfo.textContent = "新对话";
  highlightActiveSession();
});

$openFolderBtn.addEventListener("click", async () => {
  const folder = await api.openFolder();
  if (folder) {
    currentCwd = folder;
    const parts = folder.split("/");
    $cwdLabel.textContent = parts[parts.length - 1] || folder;
    $cwdLabel.title = folder;
    // If we have an active session, start a new one with the new cwd
    if (currentSessionId) {
      $newChatBtn.click();
    }
  }
});

// Welcome hints
document.querySelectorAll(".hint-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const prompt = btn.dataset.prompt;
    if (prompt) {
      $input.value = prompt;
      sendMessage(prompt);
    }
  });
});

// --- Session Persistence ---

function persistCurrentSession() {
  if (!currentSessionId || currentMessages.length === 0) return;
  const model = $modelSelect.value;
  api.store.saveSession({
    sessionId: currentSessionId,
    messages: currentMessages,
    model,
    cwd: currentCwd,
  }).then(() => refreshSessionsList());
}

async function refreshSessionsList() {
  try {
    const result = await api.store.listSessions();
    if (!result.success) return;
    $sessionsList.innerHTML = "";
    for (const meta of result.sessions) {
      const item = document.createElement("div");
      item.className = "session-item";
      if (meta.sessionId === currentSessionId) {
        item.classList.add("active");
      }
      item.dataset.sessionId = meta.sessionId;
      item.title = meta.title + (meta.cwd ? `\n📂 ${meta.cwd}` : "");

      const titleSpan = document.createElement("span");
      titleSpan.className = "session-item-title";
      titleSpan.textContent = meta.title;

      const dateSpan = document.createElement("span");
      dateSpan.className = "session-item-date";
      dateSpan.textContent = formatDate(meta.updatedAt);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "session-delete-btn";
      deleteBtn.title = "删除会话";
      deleteBtn.innerHTML = "×";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await api.store.deleteSession({ sessionId: meta.sessionId });
        if (currentSessionId === meta.sessionId) {
          $newChatBtn.click();
        }
        await refreshSessionsList();
      });

      item.appendChild(titleSpan);
      item.appendChild(dateSpan);
      item.appendChild(deleteBtn);

      item.addEventListener("click", () => loadPersistedSession(meta.sessionId));
      $sessionsList.appendChild(item);
    }
  } catch {}
}

async function loadPersistedSession(sessionId) {
  try {
    const result = await api.store.loadSession({ sessionId });
    if (!result.success || !result.data) return;

    const { meta, messages } = result.data;

    // Create a new SDK session for this restored conversation
    const model = meta.model || $modelSelect.value;
    $modelSelect.value = model;
    if (meta.cwd) {
      currentCwd = meta.cwd;
      const parts = meta.cwd.split("/");
      $cwdLabel.textContent = parts[parts.length - 1] || meta.cwd;
      $cwdLabel.title = meta.cwd;
    }

    const opts = { model };
    if (currentCwd) opts.cwd = currentCwd;

    setStatus("connecting", "正在恢复会话...");
    const createResult = await api.createSession(opts);
    if (!createResult.success) {
      showError("恢复会话失败: " + createResult.error);
      setStatus("error", createResult.error);
      return;
    }

    // Use original sessionId for persistence continuity
    currentSessionId = sessionId;
    currentMessages = messages;

    // Also track the SDK session mapping
    sdkSessionMap[sessionId] = createResult.sessionId;

    $sessionInfo.textContent = `会话: ${sessionId.slice(0, 8)}...`;
    setStatus("connected", "就绪");

    // Render messages
    $welcome.style.display = "none";
    $messages.style.display = "flex";
    $messages.innerHTML = "";
    for (const msg of messages) {
      const el = addMessage(msg.role, "");
      updateMessageContent(el, msg.content);
    }
    scrollToBottom();
    highlightActiveSession();
  } catch (err) {
    showError("加载会话失败");
  }
}

function highlightActiveSession() {
  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.sessionId === currentSessionId);
  });
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/** Maps persisted sessionId → SDK sessionId for restored sessions */
const sdkSessionMap = {};

// --- Start ---
init();
