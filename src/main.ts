import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";

// Dynamic import for ESM SDK
let CopilotClient: any;
let approveAll: any;
let client: any;
const sessions = new Map<string, any>();

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

      // Wire up event forwarding to renderer
      session.on("assistant.message_delta", (event: any) => {
        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "delta",
          content: event.data.deltaContent,
        });
      });

      session.on("assistant.message", (event: any) => {
        mainWindow?.webContents.send("copilot:event", {
          sessionId: sid,
          type: "message",
          content: event.data.content,
        });
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
