import { app } from "electron";
import * as path from "path";
import * as fs from "fs";

// Persistence directory: ~/.copilot-desktop/
function getStoreDir(): string {
  return path.join(app.getPath("home"), ".copilot-desktop");
}

function getSessionsDir(): string {
  return path.join(getStoreDir(), "sessions");
}

function getIndexPath(): string {
  return path.join(getStoreDir(), "sessions-index.json");
}

function ensureDirs(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Types ---

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  model: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionData {
  meta: SessionMeta;
  messages: ChatMessage[];
}

interface SessionIndex {
  sessions: SessionMeta[];
}

// --- Index operations ---

function readIndex(): SessionIndex {
  const p = getIndexPath();
  if (!fs.existsSync(p)) {
    return { sessions: [] };
  }
  try {
    const data = fs.readFileSync(p, "utf-8");
    return JSON.parse(data);
  } catch {
    return { sessions: [] };
  }
}

function writeIndex(index: SessionIndex): void {
  ensureDirs();
  fs.writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), "utf-8");
}

// --- Public API ---

export function listPersistedSessions(): SessionMeta[] {
  const index = readIndex();
  // Sort by updatedAt descending (most recent first)
  return index.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveSession(
  sessionId: string,
  messages: ChatMessage[],
  meta: { model: string; cwd: string | null; title?: string }
): void {
  ensureDirs();

  const now = Date.now();
  const index = readIndex();
  let existing = index.sessions.find((s) => s.sessionId === sessionId);

  const title =
    meta.title ||
    (messages.find((m) => m.role === "user")?.content.slice(0, 50) || "新对话");

  if (existing) {
    existing.updatedAt = now;
    existing.title = title;
    if (meta.model) existing.model = meta.model;
    if (meta.cwd !== undefined) existing.cwd = meta.cwd;
  } else {
    existing = {
      sessionId,
      title,
      model: meta.model,
      cwd: meta.cwd,
      createdAt: now,
      updatedAt: now,
    };
    index.sessions.push(existing);
  }

  writeIndex(index);

  // Write session data file
  const sessionData: SessionData = {
    meta: existing,
    messages,
  };
  const sessionPath = path.join(getSessionsDir(), `${sessionId}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), "utf-8");
}

export function loadSession(sessionId: string): SessionData | null {
  const sessionPath = path.join(getSessionsDir(), `${sessionId}.json`);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(sessionPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function deleteSession(sessionId: string): void {
  // Remove from index
  const index = readIndex();
  index.sessions = index.sessions.filter((s) => s.sessionId !== sessionId);
  writeIndex(index);

  // Remove session file
  const sessionPath = path.join(getSessionsDir(), `${sessionId}.json`);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}
