import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";

// Dynamic import for ESM SDK
let CopilotClient: any;
let approveAll: any;
let client: any;
const sessions = new Map<string, any>();

// --- Usage Tracking ---
interface SessionUsage {
  contextTokensUsed: number;
  contextTokensTotal: number;
  messagesCount: number;
}
const sessionUsage = new Map<string, SessionUsage>();

interface PremiumUsage {
  premiumRequestsUsed: number;
  premiumRequestsTotal: number;
  resetAt: string | null;
}
let premiumUsage: PremiumUsage = {
  premiumRequestsUsed: 0,
  premiumRequestsTotal: 0,
  resetAt: null,
};

// Rough token estimation: ~4 chars per token for mixed CJK/English
function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK chars ≈ 1-2 tokens each, ASCII ≈ 0.25 tokens per char
  let tokens = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) {
      tokens += 1.5; // CJK characters
    } else {
      tokens += 0.25; // ASCII/Latin
    }
  }
  return Math.ceil(tokens);
}

function getDefaultContextLimit(model: string): number {
  const modelLower = (model || "").toLowerCase();
  if (modelLower.includes("gpt-5")) return 256000;
  if (modelLower.includes("gpt-4.1")) return 1048576;
  if (modelLower.includes("claude-sonnet-4.5")) return 200000;
  if (modelLower.includes("claude-sonnet-4")) return 200000;
  if (modelLower.includes("claude")) return 200000;
  return 128000;
}

async function loadSDK() {
  const sdk = await import("@github/copilot-sdk");
  CopilotClient = sdk.CopilotClient;
  approveAll = sdk.approveAll;
}

// In Electron, process.execPath is the Electron binary, not Node.js.
// The SDK's getBundledCliPath() finds a .js file and tries to run it with
// process.execPath (Electron), which doesn't work. We find the standalone
// copilot CLI binary instead so the SDK spawns it directly.
function findCopilotCli(): string | undefined {
  // 1. Explicit env var
  if (process.env.COPILOT_CLI_PATH && existsSync(process.env.COPILOT_CLI_PATH)) {
    return process.env.COPILOT_CLI_PATH;
  }
  // 2. Project-local node_modules (installed as dependency)
  const localBin = path.join(__dirname, "..", "node_modules", ".bin", "copilot");
  if (existsSync(localBin)) return localBin;
  // 3. `which copilot`
  try {
    const p = execSync("which copilot", { encoding: "utf-8" }).trim();
    if (p && existsSync(p)) return p;
  } catch {}
  // 4. Common paths on macOS
  const candidates = [
    "/opt/homebrew/bin/copilot",
    "/usr/local/bin/copilot",
    path.join(app.getPath("home"), ".npm-global", "bin", "copilot"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#1a1a2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

// --- Copilot SDK IPC Handlers ---

ipcMain.handle("copilot:init", async () => {
  try {
    await loadSDK();

    const cliPath = findCopilotCli();
    console.log("[copilot-desktop] CLI path:", cliPath ?? "(auto-detect)");

    const opts: any = {};
    if (cliPath) opts.cliPath = cliPath;

    client = new CopilotClient(opts);
    await client.start();
    console.log("[copilot-desktop] Client started successfully");
    return { success: true };
  } catch (err: any) {
    console.error("Failed to init Copilot:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("copilot:list-models", async () => {
  try {
    if (!client) throw new Error("Client not initialized");
    const models = await client.listModels();
    return { success: true, models };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle(
  "copilot:create-session",
  async (_event, { model, cwd }: { model?: string; cwd?: string }) => {
    try {
      if (!client) throw new Error("Client not initialized");

      const sessionConfig: any = {
        model: model || "claude-sonnet-4.5",
        streaming: true,
        onPermissionRequest: approveAll,
      };

      if (cwd) {
        sessionConfig.cwd = cwd;
      }

      const session = await client.createSession(sessionConfig);
      const sid = session.sessionId;
      sessions.set(sid, session);

      // Initialize usage tracking for this session
      const contextLimit = getDefaultContextLimit(model || "claude-sonnet-4.5");
      sessionUsage.set(sid, {
        contextTokensUsed: 0,
        contextTokensTotal: contextLimit,
        messagesCount: 0,
      });

      // Wire up event forwarding to renderer
      session.on("assistant.message_delta", (event: any) => {
        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "delta",
          content: event.data.deltaContent,
        });
      });

      session.on("assistant.message", (event: any) => {
        // Track assistant message tokens
        const usage = sessionUsage.get(sid);
        if (usage && event.data.content) {
          usage.contextTokensUsed += estimateTokens(event.data.content);
          usage.messagesCount++;
        }

        // Check for token usage in event data (SDK may provide it)
        const tokenUsage = event.data?.usage || event.data?.tokenUsage;
        if (tokenUsage && usage) {
          // Prefer prompt_tokens + completion_tokens; fall back to total_tokens
          if (tokenUsage.prompt_tokens !== undefined && tokenUsage.completion_tokens !== undefined) {
            usage.contextTokensUsed = tokenUsage.prompt_tokens + tokenUsage.completion_tokens;
          } else if (tokenUsage.total_tokens) {
            usage.contextTokensUsed = tokenUsage.total_tokens;
          }
        }

        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "message",
          content: event.data.content,
        });

        // Forward updated usage info
        if (usage) {
          mainWindow?.webContents.send("copilot:event", {
            sessionId: sid,
            type: "usage_update",
            context: {
              used: usage.contextTokensUsed,
              total: usage.contextTokensTotal,
            },
          });
        }
      });

      session.on("tool.execution_start", (event: any) => {
        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "tool_start",
          tool: event.data?.toolName || event.data?.name || "tool",
          input: event.data?.input,
        });
      });

      session.on("tool.execution_complete", (event: any) => {
        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "tool_complete",
          tool: event.data?.toolName || event.data?.name || "tool",
        });
      });

      session.on("session.idle", () => {
        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "idle",
        });
      });

      return { success: true, sessionId: sid };
    } catch (err: any) {
      console.error("Failed to create session:", err);
      return { success: false, error: err.message };
    }
  }
);

ipcMain.handle(
  "copilot:send",
  async (_event, { sessionId, prompt }: { sessionId: string; prompt: string }) => {
    try {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Session not found");

      // Track user message tokens
      const usage = sessionUsage.get(sessionId);
      if (usage) {
        usage.contextTokensUsed += estimateTokens(prompt);
        usage.messagesCount++;
      }

      // Track premium request usage
      premiumUsage.premiumRequestsUsed++;

      await session.send({ prompt });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
);

ipcMain.handle("copilot:abort", async (_event, { sessionId }: { sessionId: string }) => {
  try {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    await session.abort();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("copilot:list-sessions", async () => {
  try {
    if (!client) throw new Error("Client not initialized");
    const list = await client.listSessions();
    return { success: true, sessions: list };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("copilot:get-usage", async (_event, { sessionId }: { sessionId?: string }) => {
  try {
    const contextUsage = sessionId ? sessionUsage.get(sessionId) : null;

    // Try to get premium usage from client if available
    if (client && typeof client.getUsage === "function") {
      try {
        const sdkUsage = await client.getUsage();
        if (sdkUsage) {
          // Prefer premiumRequestsLimit; fall back to calculating from remaining
          if (sdkUsage.premiumRequestsLimit !== undefined) {
            premiumUsage.premiumRequestsTotal = sdkUsage.premiumRequestsLimit;
          } else if (sdkUsage.premiumRequestsRemaining !== undefined) {
            premiumUsage.premiumRequestsTotal =
              sdkUsage.premiumRequestsRemaining + (premiumUsage.premiumRequestsUsed || 0);
          }
          if (sdkUsage.premiumRequestsUsed !== undefined) {
            premiumUsage.premiumRequestsUsed = sdkUsage.premiumRequestsUsed;
          }
          if (sdkUsage.resetAt) {
            premiumUsage.resetAt = sdkUsage.resetAt;
          }
        }
      } catch {}
    }

    return {
      success: true,
      context: contextUsage
        ? {
            used: contextUsage.contextTokensUsed,
            total: contextUsage.contextTokensTotal,
            messagesCount: contextUsage.messagesCount,
          }
        : null,
      premium: {
        used: premiumUsage.premiumRequestsUsed,
        total: premiumUsage.premiumRequestsTotal,
        resetAt: premiumUsage.resetAt,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// --- Chat History Persistence ---
const HISTORY_DIR = path.join(app.getPath("home"), ".copilot-desktop", "history");

function ensureHistoryDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

ipcMain.handle("history:list", async () => {
  try {
    ensureHistoryDir();
    const files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
    const items: any[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(path.join(HISTORY_DIR, file), "utf-8");
        const data = JSON.parse(raw);
        items.push({
          id: data.id,
          title: data.title || "未命名对话",
          model: data.model,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messageCount: data.messages?.length || 0,
        });
      } catch {}
    }
    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { success: true, items };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("history:load", async (_event, { id }: { id: string }) => {
  try {
    ensureHistoryDir();
    const filePath = path.join(HISTORY_DIR, `${id}.json`);
    if (!existsSync(filePath)) throw new Error("History not found");
    const raw = readFileSync(filePath, "utf-8");
    return { success: true, data: JSON.parse(raw) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("history:save", async (_event, { data }: { data: any }) => {
  try {
    ensureHistoryDir();
    const filePath = path.join(HISTORY_DIR, `${data.id}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("history:delete", async (_event, { id }: { id: string }) => {
  try {
    ensureHistoryDir();
    const filePath = path.join(HISTORY_DIR, `${id}.json`);
    if (existsSync(filePath)) unlinkSync(filePath);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("dialog:open-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle("copilot:stop", async () => {
  for (const [, session] of sessions) {
    try {
      await session.disconnect();
    } catch {}
  }
  sessions.clear();
  sessionUsage.clear();
  if (client) {
    try {
      await client.stop();
    } catch {}
    client = null;
  }
  return { success: true };
});

// --- App Lifecycle ---

app.whenReady().then(createWindow);

app.on("window-all-closed", async () => {
  for (const [, session] of sessions) {
    try { await session.disconnect(); } catch {}
  }
  if (client) {
    try { await client.stop(); } catch {}
  }
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
