// @ts-check
/// <reference types="../../../node_modules/electron" />

/**
 * Copilot Desktop - Renderer
 * @typedef {{ init: () => Promise<any>, listModels: () => Promise<any>, createSession: (opts: any) => Promise<any>, send: (opts: any) => Promise<any>, abort: (opts: any) => Promise<any>, listSessions: () => Promise<any>, stop: () => Promise<any>, openFolder: () => Promise<string|null>, onEvent: (cb: (e: any) => void) => () => void }} CopilotAPI
 */

/** @type {CopilotAPI} */
const api = /** @type {any} */ (window).copilot;

// --- State ---
let currentSessionId = null;
let currentCwd = null;
let isProcessing = false;
let streamingContent = "";
let streamingEl = null;

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

  // Clear input
  $input.value = "";
  autoResize();

  // Add typing indicator
  const typingEl = addTypingIndicator();

  // Send to Copilot
  const result = await api.send({ sessionId: currentSessionId, prompt });
  if (!result.success) {
    typingEl?.remove();
    isProcessing = false;
    updateInputState();
    showError("发送失败: " + result.error);
  }
}

// --- Event Handling ---
api.onEvent((event) => {
  if (event.sessionId !== currentSessionId) return;

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

// --- Slash Commands ---
const $slashPopup = document.getElementById("slash-popup");
const $slashList = document.getElementById("slash-list");
let slashSelectedIndex = 0;

/** @type {Array<{command: string, label: string, description: string, handler: () => void}>} */
const slashCommands = [
  {
    command: "/help",
    label: "帮助",
    description: "显示所有可用的斜杠命令",
    handler() {
      ensureMessagesVisible();
      const lines = slashCommands.map((c) => `**${c.command}** — ${c.description}`).join("\n");
      addMessage("assistant", "");
      const el = $messages.lastElementChild?.querySelector(".message-content");
      if (el) updateMessageContent(el, "📋 **可用命令：**\n\n" + lines);
      scrollToBottom();
    },
  },
  {
    command: "/clear",
    label: "清除",
    description: "清除当前对话的消息记录",
    handler() {
      if ($messages.style.display !== "none") {
        $messages.innerHTML = "";
        streamingEl = null;
        streamingContent = "";
      }
    },
  },
  {
    command: "/new",
    label: "新建对话",
    description: "开始一个全新的对话",
    handler() {
      $newChatBtn.click();
    },
  },
  {
    command: "/model",
    label: "切换模型",
    description: "切换到下一个可用的 AI 模型",
    handler() {
      const options = Array.from($modelSelect.options);
      if (options.length === 0) return;
      const currentIdx = $modelSelect.selectedIndex;
      const nextIdx = (currentIdx + 1) % options.length;
      $modelSelect.selectedIndex = nextIdx;
      ensureMessagesVisible();
      addMessage("assistant", "");
      const el = $messages.lastElementChild?.querySelector(".message-content");
      if (el) updateMessageContent(el, `🔄 模型已切换为 **${options[nextIdx].textContent}**`);
      scrollToBottom();
    },
  },
  {
    command: "/compact",
    label: "总结对话",
    description: "请求 Copilot 总结当前对话",
    handler() {
      const prompt = "请简要总结我们到目前为止的对话内容，列出关键要点。";
      sendMessage(prompt);
    },
  },
  {
    command: "/status",
    label: "状态",
    description: "显示当前连接和会话状态",
    handler() {
      ensureMessagesVisible();
      const statusInfo = [
        `**连接状态：** ${$statusText.textContent}`,
        `**当前会话：** ${currentSessionId ? currentSessionId.slice(0, 12) + "..." : "无"}`,
        `**工作目录：** ${currentCwd || "未设置"}`,
        `**当前模型：** ${$modelSelect.options[$modelSelect.selectedIndex]?.textContent || "未知"}`,
      ].join("\n");
      addMessage("assistant", "");
      const el = $messages.lastElementChild?.querySelector(".message-content");
      if (el) updateMessageContent(el, "ℹ️ **当前状态**\n\n" + statusInfo);
      scrollToBottom();
    },
  },
];

function ensureMessagesVisible() {
  if ($messages.style.display === "none") {
    $welcome.style.display = "none";
    $messages.style.display = "flex";
  }
}

function getFilteredCommands(query) {
  const q = query.toLowerCase();
  return slashCommands.filter(
    (c) => c.command.includes(q) || c.label.includes(q) || c.description.includes(q)
  );
}

function showSlashPopup(filter) {
  const filtered = getFilteredCommands(filter);
  if (filtered.length === 0) {
    hideSlashPopup();
    return;
  }
  slashSelectedIndex = 0;
  renderSlashList(filtered);
  $slashPopup.style.display = "block";
}

function hideSlashPopup() {
  $slashPopup.style.display = "none";
  slashSelectedIndex = 0;
}

function renderSlashList(filtered) {
  $slashList.innerHTML = "";
  filtered.forEach((cmd, idx) => {
    const item = document.createElement("div");
    item.className = "slash-item" + (idx === slashSelectedIndex ? " selected" : "");
    item.innerHTML = `
      <span class="slash-cmd">${escapeHtml(cmd.command)}</span>
      <span class="slash-label">${escapeHtml(cmd.label)}</span>
      <span class="slash-desc">${escapeHtml(cmd.description)}</span>
    `;
    item.addEventListener("mouseenter", () => {
      slashSelectedIndex = idx;
      renderSlashList(filtered);
    });
    item.addEventListener("click", (e) => {
      e.preventDefault();
      executeSlashCommand(cmd);
    });
    $slashList.appendChild(item);
  });
}

function executeSlashCommand(cmd) {
  hideSlashPopup();
  $input.value = "";
  autoResize();
  cmd.handler();
  $input.focus();
}

function handleSlashInput() {
  const val = $input.value;
  if (val.startsWith("/")) {
    showSlashPopup(val);
  } else {
    hideSlashPopup();
  }
}

function handleSlashKeydown(e) {
  if ($slashPopup.style.display === "none") return false;

  const filtered = getFilteredCommands($input.value);
  if (filtered.length === 0) return false;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    slashSelectedIndex = (slashSelectedIndex + 1) % filtered.length;
    renderSlashList(filtered);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    slashSelectedIndex = (slashSelectedIndex - 1 + filtered.length) % filtered.length;
    renderSlashList(filtered);
    return true;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    executeSlashCommand(filtered[slashSelectedIndex]);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    hideSlashPopup();
    return true;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    $input.value = filtered[slashSelectedIndex].command + " ";
    handleSlashInput();
    return true;
  }
  return false;
}

// --- Event Listeners ---
$input.addEventListener("input", () => {
  autoResize();
  handleSlashInput();
});

$input.addEventListener("keydown", (e) => {
  if (handleSlashKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const val = $input.value.trim();
    // Check if input matches a slash command exactly
    const exactCmd = slashCommands.find((c) => val === c.command || val.startsWith(c.command + " "));
    if (exactCmd) {
      hideSlashPopup();
      $input.value = "";
      autoResize();
      exactCmd.handler();
      return;
    }
    sendMessage($input.value);
  }
});

// Close slash popup on outside click
document.addEventListener("click", (e) => {
  if (!$slashPopup.contains(e.target) && e.target !== $input) {
    hideSlashPopup();
  }
});

$sendBtn.addEventListener("click", () => {
  const val = $input.value.trim();
  const exactCmd = slashCommands.find((c) => val === c.command || val.startsWith(c.command + " "));
  if (exactCmd) {
    hideSlashPopup();
    $input.value = "";
    autoResize();
    exactCmd.handler();
    return;
  }
  sendMessage($input.value);
});

$abortBtn.addEventListener("click", async () => {
  if (currentSessionId) {
    await api.abort({ sessionId: currentSessionId });
  }
});

$newChatBtn.addEventListener("click", async () => {
  currentSessionId = null;
  streamingEl = null;
  streamingContent = "";
  isProcessing = false;
  updateInputState();
  $messages.style.display = "none";
  $messages.innerHTML = "";
  $welcome.style.display = "flex";
  $sessionInfo.textContent = "新对话";
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

// --- Start ---
init();
