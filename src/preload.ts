import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("copilot", {
  init: () => ipcRenderer.invoke("copilot:init"),
  listModels: () => ipcRenderer.invoke("copilot:list-models"),
  createSession: (opts: { model?: string; cwd?: string }) =>
    ipcRenderer.invoke("copilot:create-session", opts),
  send: (opts: { sessionId: string; prompt: string }) =>
    ipcRenderer.invoke("copilot:send", opts),
  abort: (opts: { sessionId: string }) =>
    ipcRenderer.invoke("copilot:abort", opts),
  listSessions: () => ipcRenderer.invoke("copilot:list-sessions"),
  stop: () => ipcRenderer.invoke("copilot:stop"),
  openFolder: () => ipcRenderer.invoke("dialog:open-folder"),
  onEvent: (callback: (event: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on("copilot:event", handler);
    return () => ipcRenderer.removeListener("copilot:event", handler);
  },
});
