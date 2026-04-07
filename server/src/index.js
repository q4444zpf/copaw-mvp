import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import {
  getSession,
  upsertSession,
  saveMessage,
  listSessions,
  listMessages,
  listUserChatSessions,
  hasSessionMessages,
} from "./db.js";
import { sendToCopaw, streamToCopaw } from "./copawClient.js";

const app = express();
const port = Number(process.env.PORT || 8787);
const corsOrigin = process.env.CORS_ORIGIN || "*";
const workspaceRoot = path.resolve(
  process.env.COPAW_WORKSPACE_ROOT ||
    path.join(process.env.USERPROFILE || process.cwd(), ".copaw", "workspaces")
);
const fileSearchMaxDepth = Math.max(1, Number(process.env.COPAW_FILE_SEARCH_MAX_DEPTH || 8));
const fileSearchMaxEntries = Math.max(100, Number(process.env.COPAW_FILE_SEARCH_MAX_ENTRIES || 20000));
const previewableExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".html",
  ".htm",
  ".pdf",
  ".csv",
  ".txt",
  ".json",
  ".md",
]);

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "1mb" }));

function authContext(req) {
  const tenantId = req.header("x-tenant-id");
  const userId = req.header("x-user-id");
  if (!tenantId || !userId) {
    return { ok: false, error: "Missing x-tenant-id or x-user-id header" };
  }
  return { ok: true, tenantId, userId };
}

function ensureSession(tenantId, userId, channel) {
  const existing = getSession(tenantId, userId, channel);
  if (existing) {
    return existing;
  }
  const created = uuidv4();
  return upsertSession(tenantId, userId, channel, created);
}

function normalizeLimit(value, fallback = 20, min = 1, max = 500) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), min), max);
}

function normalizeSessionId(value) {
  const sid = String(value || "").trim();
  return sid || "";
}

function normalizeAgentId(body = {}) {
  const v = String(body.agentId || body.modelId || "").trim();
  return v;
}

function formatSessionPreview(text, maxLen = 80) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  if (source.length <= maxLen) return source;
  return `${source.slice(0, Math.max(maxLen - 1, 1))}...`;
}

function parseModelOptions() {
  const configured = String(process.env.COPAW_MODEL_OPTIONS || "").trim();
  const fallbackAgentId =
    String(process.env.COPAW_DEFAULT_AGENT || process.env.COPAW_DEFAULT_MODEL || "").trim() ||
    "default";
  const pairs = configured
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const models = [];
  const seen = new Set();
  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    const rawId = idx >= 0 ? pair.slice(0, idx).trim() : pair;
    const rawLabel = idx >= 0 ? pair.slice(idx + 1).trim() : "";
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    models.push({ id: rawId, label: rawLabel || rawId });
  }

  if (!models.length) {
    models.push({ id: fallbackAgentId, label: fallbackAgentId });
  }

  const defaultModel =
    String(process.env.COPAW_DEFAULT_MODEL || "").trim() || models[0].id || fallbackAgentId;
  if (!seen.has(defaultModel) && defaultModel) {
    models.unshift({ id: defaultModel, label: defaultModel });
  }

  return { defaultModel, models };
}

function parseAgentOptions() {
  const configured = String(
    process.env.COPAW_AGENT_OPTIONS || process.env.COPAW_MODEL_OPTIONS || ""
  ).trim();
  const fallbackAgentId =
    String(process.env.COPAW_DEFAULT_AGENT || process.env.COPAW_DEFAULT_MODEL || "").trim() ||
    "default";
  const pairs = configured
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const agents = [];
  const seen = new Set();
  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    const rawId = idx >= 0 ? pair.slice(0, idx).trim() : pair;
    const rawLabel = idx >= 0 ? pair.slice(idx + 1).trim() : "";
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    agents.push({ id: rawId, label: rawLabel || rawId });
  }

  if (!agents.length) {
    agents.push({ id: fallbackAgentId, label: fallbackAgentId });
  }

  const defaultAgent =
    String(process.env.COPAW_DEFAULT_AGENT || process.env.COPAW_DEFAULT_MODEL || "").trim() ||
    agents[0].id ||
    fallbackAgentId;
  if (!seen.has(defaultAgent) && defaultAgent) {
    agents.unshift({ id: defaultAgent, label: defaultAgent });
  }

  return { defaultAgent, agents };
}

function resolveSessionForRead({ tenantId, userId, channel, requestedSessionId = "" }) {
  const sid = normalizeSessionId(requestedSessionId);
  if (!sid) {
    return { ok: true, sessionId: ensureSession(tenantId, userId, channel), source: "active" };
  }

  const isCurrent = getSession(tenantId, userId, channel) === sid;
  if (isCurrent || hasSessionMessages({ tenantId, userId, channel, sessionId: sid })) {
    upsertSession(tenantId, userId, channel, sid);
    return { ok: true, sessionId: sid, source: "requested" };
  }

  return { ok: false, code: 404, error: "session not found for current user/channel" };
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function tryParseJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function extractToolDataBlocks(messageEvent) {
  if (!messageEvent || !Array.isArray(messageEvent.content)) {
    return [];
  }
  return messageEvent.content
    .filter((item) => item && item.type === "data" && item.data && typeof item.data === "object")
    .map((item) => item.data);
}

function normalizeToolOutput(rawOutput) {
  const parsed = tryParseJson(rawOutput);

  if (Array.isArray(parsed)) {
    const textParts = parsed
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => String(part.text || "").trim())
      .filter(Boolean);
    if (textParts.length) {
      return textParts.join("\n");
    }
    try {
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(rawOutput || "");
    }
  }

  if (parsed && typeof parsed === "object") {
    try {
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(rawOutput || "");
    }
  }

  return String(parsed || "");
}

function isPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPreviewableFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return previewableExtensions.has(ext);
}

function resolveWorkspacePath(rawPath) {
  const input = String(rawPath || "").trim();
  if (!input) return null;

  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) return null;

  const absPath = path.resolve(workspaceRoot, normalized);
  if (!isPathInside(workspaceRoot, absPath)) return null;

  try {
    if (!fs.existsSync(absPath)) return null;
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || !isPreviewableFile(absPath)) return null;
    return absPath;
  } catch {
    return null;
  }
}

function resolveWorkspaceFileByName(rawName) {
  const baseName = path.basename(String(rawName || "").replace(/\\/g, "/").trim());
  if (!baseName) return null;

  if (!fs.existsSync(workspaceRoot)) return null;

  const queue = [{ dir: workspaceRoot, depth: 0 }];
  let visited = 0;
  let bestPath = null;
  let bestMtime = -1;

  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > fileSearchMaxDepth) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > fileSearchMaxEntries) break;

      const absEntry = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < fileSearchMaxDepth) {
          queue.push({ dir: absEntry, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name !== baseName) continue;
      if (!isPreviewableFile(absEntry)) continue;

      let mtime = 0;
      try {
        mtime = fs.statSync(absEntry).mtimeMs;
      } catch {
        mtime = 0;
      }
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        bestPath = absEntry;
      }
    }

    if (visited > fileSearchMaxEntries) break;
  }

  return bestPath;
}

function adminAuth(req) {
  const token = process.env.ADMIN_TOKEN || "";
  if (!token) {
    return { ok: false, code: 503, error: "ADMIN_TOKEN is not configured" };
  }
  const header = req.header("x-admin-token") || "";
  if (!header || header !== token) {
    return { ok: false, code: 401, error: "Invalid x-admin-token" };
  }
  return { ok: true };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "copaw-mvp-server" });
});

app.get("/api/files/content", (req, res) => {
  const name = String(req.query.name || "").trim();
  const relPath = String(req.query.path || "").trim();

  if (!name && !relPath) {
    return res.status(400).json({
      ok: false,
      error: "name or path is required",
    });
  }

  let filePath = null;

  if (relPath) {
    filePath = resolveWorkspacePath(relPath);
  }
  if (!filePath && name) {
    filePath = resolveWorkspaceFileByName(name);
  }

  if (!filePath) {
    return res.status(404).json({
      ok: false,
      error: "file not found under workspace root",
      workspaceRoot,
    });
  }

  res.setHeader("Content-Disposition", `inline; filename=\"${path.basename(filePath)}\"`);
  return res.sendFile(filePath);
});

app.get("/api/admin/sessions", (req, res) => {
  const admin = adminAuth(req);
  if (!admin.ok) {
    return res.status(admin.code).json({ ok: false, error: admin.error });
  }

  const tenantId = String(req.query.tenant_id || "");
  const userId = String(req.query.user_id || "");
  const channel = String(req.query.channel || "");
  const limitRaw = Number(req.query.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 50;

  const items = listSessions({ tenantId, userId, channel, limit });
  return res.json({ ok: true, count: items.length, items });
});

app.post("/api/chat/session", (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }
  const channel = req.body?.channel || "web-chat";
  const sessionId = ensureSession(auth.tenantId, auth.userId, channel);
  return res.json({ ok: true, channel, sessionId });
});

app.get("/api/chat/sessions", (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const channel = String(req.query.channel || "web-chat");
  const limit = normalizeLimit(req.query.limit, 20, 1, 100);
  const activeSessionId = ensureSession(auth.tenantId, auth.userId, channel);
  const items = listUserChatSessions({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    limit,
  }).map((row) => ({
    sessionId: row.session_id,
    messageCount: Number(row.message_count || 0),
    updatedAt: row.updated_at || row.last_created_at || "",
    lastRole: row.last_role || "",
    lastText: row.last_text || "",
    preview: formatSessionPreview(row.last_text || ""),
    active: row.session_id === activeSessionId,
  }));

  return res.json({
    ok: true,
    channel,
    activeSessionId,
    count: items.length,
    items,
  });
});

app.post("/api/chat/session/select", (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const channel = String(req.body?.channel || "web-chat");
  const requestedSessionId = normalizeSessionId(req.body?.sessionId);
  if (!requestedSessionId) {
    return res.status(400).json({ ok: false, error: "sessionId is required" });
  }

  const currentSessionId = getSession(auth.tenantId, auth.userId, channel);
  const exists =
    requestedSessionId === currentSessionId ||
    hasSessionMessages({
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel,
      sessionId: requestedSessionId,
    });

  if (!exists) {
    return res
      .status(404)
      .json({ ok: false, error: "session not found for current user/channel" });
  }

  upsertSession(auth.tenantId, auth.userId, channel, requestedSessionId);
  return res.json({ ok: true, channel, sessionId: requestedSessionId });
});

app.get("/api/chat/models", (_req, res) => {
  const data = parseModelOptions();
  return res.json({
    ok: true,
    defaultModel: data.defaultModel,
    models: data.models,
  });
});

app.get("/api/chat/agents", (_req, res) => {
  const data = parseAgentOptions();
  return res.json({
    ok: true,
    defaultAgent: data.defaultAgent,
    agents: data.agents,
  });
});

app.get("/api/chat/history", (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const channel = String(req.query.channel || "web-chat");
  const limit = normalizeLimit(req.query.limit, 100, 1, 500);
  const selected = resolveSessionForRead({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    requestedSessionId: req.query.session_id,
  });
  if (!selected.ok) {
    return res.status(selected.code).json({ ok: false, error: selected.error });
  }
  const sessionId = selected.sessionId;

  const items = listMessages({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    sessionId,
    limit,
  }).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.direction,
    text: row.content,
    createdAt: row.created_at,
  }));

  return res.json({ ok: true, channel, sessionId, count: items.length, items });
});

app.post("/api/chat/reset", (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }
  const channel = req.body?.channel || "web-chat";
  const sessionId = uuidv4();
  upsertSession(auth.tenantId, auth.userId, channel, sessionId);
  return res.json({ ok: true, channel, sessionId });
});

app.post("/api/chat/message", async (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const channel = req.body?.channel || "web-chat";
  const message = String(req.body?.message || "").trim();
  const metadata = req.body?.metadata || {};
  const requestedSessionId = normalizeSessionId(req.body?.sessionId);
  const agentId = normalizeAgentId(req.body);

  if (!message) {
    return res.status(400).json({ ok: false, error: "message is required" });
  }

  const selected = resolveSessionForRead({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    requestedSessionId,
  });
  if (!selected.ok) {
    return res.status(selected.code).json({ ok: false, error: selected.error });
  }
  const sessionId = selected.sessionId;
  saveMessage({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    sessionId,
    direction: "user",
    content: message,
  });

  try {
    const copaw = await sendToCopaw({
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel,
      sessionId,
      message,
      agentId,
      metadata,
    });

    const assistantText = String(copaw.text || "").trim() || "(empty response)";
    saveMessage({
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel,
      sessionId,
      direction: "assistant",
      content: assistantText,
    });

    return res.json({
      ok: true,
      sessionId,
      reply: assistantText,
      raw: copaw.raw,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      sessionId,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  const auth = authContext(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const channel = req.body?.channel || "web-chat";
  const message = String(req.body?.message || "").trim();
  const metadata = req.body?.metadata || {};
  const requestedSessionId = normalizeSessionId(req.body?.sessionId);
  const agentId = normalizeAgentId(req.body);

  if (!message) {
    return res.status(400).json({ ok: false, error: "message is required" });
  }

  const selected = resolveSessionForRead({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    requestedSessionId,
  });
  if (!selected.ok) {
    return res.status(selected.code).json({ ok: false, error: selected.error });
  }
  const sessionId = selected.sessionId;
  saveMessage({
    tenantId: auth.tenantId,
    userId: auth.userId,
    channel,
    sessionId,
    direction: "user",
    content: message,
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  sseWrite(res, { type: "session", sessionId });

  const messageTypes = new Map();
  const messageNames = new Map();
  let sawAssistantDelta = false;
  let reasoningText = "";

  try {
    const copaw = await streamToCopaw({
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel,
      sessionId,
      message,
      agentId,
      metadata,
      onEvent: (ev) => {
        if (!ev || typeof ev !== "object") return;

        if (ev.object === "message" && ev.id && typeof ev.type === "string") {
          messageTypes.set(ev.id, ev.type);
          const toolName =
            ev.name ||
            ev.tool_name ||
            ev.tool ||
            ev.plugin ||
            ev.function_name ||
            ev.type;
          messageNames.set(ev.id, String(toolName || ev.type));

          if (ev.type !== "reasoning" && ev.type !== "message" && ev.status === "completed") {
            const blocks = extractToolDataBlocks(ev);

            if (ev.type === "plugin_call") {
              const block = blocks[blocks.length - 1] || {};
              sseWrite(res, {
                type: "tool_start",
                msgId: ev.id,
                callId: String(block.call_id || ""),
                toolType: ev.type,
                toolName: String(block.name || toolName || ev.type),
                input: tryParseJson(block.arguments || ev.arguments || ev.input || null),
              });
            } else if (ev.type === "plugin_call_output") {
              const block = blocks[blocks.length - 1] || {};
              sseWrite(res, {
                type: "tool_output",
                msgId: ev.id,
                callId: String(block.call_id || ""),
                toolType: ev.type,
                toolName: String(block.name || toolName || ev.type),
                text: normalizeToolOutput(block.output || ev.output || ""),
              });
            } else if (ev.type !== "plugin_call_output") {
              sseWrite(res, {
                type: "tool_start",
                msgId: ev.id,
                toolType: ev.type,
                toolName: String(toolName || ev.type),
                input: ev.input || ev.args || ev.arguments || null,
              });
            }
          }
          return;
        }

        if (ev.object === "content" && ev.type === "text" && ev.delta === true && ev.msg_id) {
          const msgType = messageTypes.get(ev.msg_id) || "";
          const chunk = String(ev.text || "");
          if (!chunk) return;

          if (msgType === "reasoning") {
            reasoningText += chunk;
            sseWrite(res, { type: "reasoning_delta", text: chunk });
            return;
          }

          if (msgType === "message") {
            sawAssistantDelta = true;
            sseWrite(res, { type: "assistant_delta", text: chunk });
            return;
          }

          if (msgType && msgType !== "reasoning") {
            sseWrite(res, {
              type: "tool_delta",
              msgId: ev.msg_id,
              toolType: msgType,
              toolName: messageNames.get(ev.msg_id) || msgType,
              text: chunk,
            });
          }
        }
      },
    });

    const assistantText = String(copaw.text || "").trim() || "(empty response)";
    if (reasoningText.trim()) {
      saveMessage({
        tenantId: auth.tenantId,
        userId: auth.userId,
        channel,
        sessionId,
        direction: "reasoning",
        content: reasoningText.trim(),
      });
    }
    saveMessage({
      tenantId: auth.tenantId,
      userId: auth.userId,
      channel,
      sessionId,
      direction: "assistant",
      content: assistantText,
    });

    if (!sawAssistantDelta) {
      sseWrite(res, { type: "assistant_final", text: assistantText });
    }
    sseWrite(res, { type: "done", sessionId, raw: copaw.raw });
  } catch (error) {
    sseWrite(res, {
      type: "error",
      error: error instanceof Error ? error.message : "unknown error",
    });
  } finally {
    res.end();
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`copaw-mvp-server running on http://localhost:${port}`);
});
