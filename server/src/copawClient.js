function buildHeaders(agentIdOverride) {
  const headers = { "Content-Type": "application/json" };
  const mode = process.env.COPAW_API_MODE || "agent_process";
  if (mode === "agent_process") {
    headers.Accept = "text/event-stream";
  }

  const apiKey = process.env.COPAW_API_KEY;
  if (apiKey) {
    const headerName = process.env.COPAW_API_KEY_HEADER || "Authorization";
    const prefix = process.env.COPAW_API_KEY_PREFIX || "Bearer";
    headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey;
  }

  const agentId = String(
    agentIdOverride ||
      process.env.COPAW_DEFAULT_AGENT ||
      process.env.COPAW_DEFAULT_MODEL ||
      ""
  ).trim();
  if (agentId) {
    headers["X-Agent-Id"] = agentId;
  }

  return headers;
}

function parseSseFrame(frame) {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return null;

  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") return null;

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function splitSseFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = [];
  let rest = normalized;
  while (true) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    frames.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { frames, rest };
}

export function parseSseEvents(rawText) {
  const events = [];
  const chunks = rawText.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    const ev = parseSseFrame(chunk);
    if (ev) events.push(ev);
  }
  return events;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

function textFromOutputArray(output) {
  if (!Array.isArray(output)) return "";
  for (let i = output.length - 1; i >= 0; i -= 1) {
    const msg = output[i];
    if (msg?.object === "message" && msg?.type === "message" && msg?.role === "assistant") {
      const t = contentText(msg.content);
      if (t) return t;
    }
  }
  return "";
}

export function parseCopawResponse(raw) {
  if (typeof raw === "string") {
    if (raw.includes("data:")) {
      const events = parseSseEvents(raw);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev?.object === "response" && ev?.status === "completed") {
          const t = textFromOutputArray(ev.output);
          if (t) return t;
        }
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev?.object === "message" && ev?.type === "message" && ev?.role === "assistant") {
          const t = contentText(ev.content);
          if (t) return t;
        }
      }
      return "";
    }
    return raw.trim();
  }

  if (!raw || typeof raw !== "object") return "";

  if (Array.isArray(raw.output)) {
    const t = textFromOutputArray(raw.output);
    if (t) return t;
  }
  if (Array.isArray(raw.content)) {
    const t = contentText(raw.content);
    if (t) return t;
  }

  return (
    raw.reply ||
    raw.answer ||
    raw.output ||
    raw.text ||
    raw.message ||
    raw.content ||
    ""
  );
}

function buildPayload({ tenantId, userId, channel, sessionId, message, metadata }) {
  const mode = process.env.COPAW_API_MODE || "agent_process";
  if (mode === "channel_webhook") {
    return {
      channel,
      user_id: `${tenantId}:${userId}`,
      session_id: sessionId,
      message,
      metadata,
    };
  }

  return {
    channel,
    user_id: `${tenantId}:${userId}`,
    input: [{ role: "user", content: [{ type: "text", text: message }] }],
    session_id: sessionId,
  };
}

function buildRawSummary(res, rawText) {
  const mode = process.env.COPAW_API_MODE || "agent_process";
  return process.env.COPAW_RETURN_RAW === "1"
    ? rawText
    : {
        mode,
        contentType: res.headers.get("content-type") || "",
        size: rawText.length,
      };
}

function isAbortError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error.name === "AbortError" || String(error.message || "").includes("aborted"))
  );
}

function wrapAbortAsTimeout(error, timeoutMs) {
  if (!isAbortError(error)) return error;
  return new Error(
    `请求超时：CoPaw 在 ${timeoutMs}ms 内未完成，已中止。请增大 COPAW_TIMEOUT_MS 或减少单次任务复杂度。`
  );
}

function parseJsonSafe(rawText) {
  if (typeof rawText !== "string") return null;
  const text = rawText.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureAbsUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function deriveCopawApiBaseUrl() {
  const explicit = ensureAbsUrl(process.env.COPAW_API_BASE_URL);
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const messageUrl = ensureAbsUrl(process.env.COPAW_MESSAGE_URL);
  if (!messageUrl) return "";

  try {
    const url = new URL(messageUrl);
    const path = url.pathname.replace(/\/+$/, "");

    const knownSuffixes = [
      "/agent/process",
      "/console/chat/stop",
      "/console/chat",
      "/channel/webhook",
    ];
    for (const suffix of knownSuffixes) {
      if (path.endsWith(suffix)) {
        const basePath = path.slice(0, path.length - suffix.length) || "/";
        url.pathname = basePath;
        return url.toString().replace(/\/+$/, "");
      }
    }

    if (path === "/api" || path.endsWith("/api")) {
      return url.toString().replace(/\/+$/, "");
    }

    const apiIdx = path.indexOf("/api/");
    if (apiIdx >= 0) {
      url.pathname = path.slice(0, apiIdx + 4);
      return url.toString().replace(/\/+$/, "");
    }

    url.pathname = "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function resolveChatsUrl() {
  const explicit = ensureAbsUrl(process.env.COPAW_CHATS_URL);
  if (explicit) return explicit;

  const base = deriveCopawApiBaseUrl();
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/chats`;
}

function resolveStopUrl() {
  const explicit = ensureAbsUrl(process.env.COPAW_STOP_URL);
  if (explicit) return explicit;

  const base = deriveCopawApiBaseUrl();
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/console/chat/stop`;
}

function normalizeList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.result)) return payload.result;
  }
  return [];
}

function composeCopawUserId(tenantId, userId) {
  const t = String(tenantId || "").trim();
  const u = String(userId || "").trim();
  if (t && u) return `${t}:${u}`;
  return t || u;
}

function toTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : 0;
}

function pickLatestChatBySession(chats, sessionId) {
  const target = String(sessionId || "").trim();
  if (!target) return null;
  const matches = chats.filter((chat) => String(chat?.session_id || "").trim() === target);
  if (!matches.length) return null;
  const runningMatches = matches.filter(
    (chat) => String(chat?.status || "").trim().toLowerCase() === "running"
  );
  const candidates = runningMatches.length ? runningMatches : matches;
  candidates.sort((a, b) => {
    const aTs = Math.max(toTimestamp(a?.updated_at), toTimestamp(a?.created_at));
    const bTs = Math.max(toTimestamp(b?.updated_at), toTimestamp(b?.created_at));
    if (aTs !== bTs) return bTs - aTs;
    return 0;
  });
  return candidates[0] || null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchTextWithTimeout({
  url,
  options = {},
  timeoutMs,
  signal = null,
  timeoutHint = "请求",
}) {
  const ctrl = new AbortController();
  let abortedByTimeout = false;
  let abortedByExternal = false;
  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    abortedByExternal = true;
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) {
      onExternalAbort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
    });
    const rawText = await res.text();
    return { res, rawText };
  } catch (error) {
    if (isAbortError(error)) {
      if (abortedByExternal && !abortedByTimeout) {
        throw new Error("request aborted by caller");
      }
      throw new Error(
        `请求超时：${timeoutHint}在 ${timeoutMs}ms 内未完成，已中止。请增大 COPAW_STOP_TIMEOUT_MS。`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function listChatsByFilters({
  tenantId,
  userId,
  channel,
  agentId = "",
  signal = null,
  useFilters = true,
}) {
  const chatsUrl = resolveChatsUrl();
  if (!chatsUrl) {
    throw new Error("COPAW_CHATS_URL is not configured and cannot be derived");
  }

  const url = new URL(chatsUrl);
  if (useFilters) {
    const copawUserId = composeCopawUserId(tenantId, userId);
    if (copawUserId) {
      url.searchParams.set("user_id", copawUserId);
    }
    if (channel) {
      url.searchParams.set("channel", String(channel));
    }
  }

  const timeoutMs = Number(process.env.COPAW_STOP_TIMEOUT_MS || process.env.COPAW_TIMEOUT_MS || 30000);
  const { res, rawText } = await fetchTextWithTimeout({
    url: url.toString(),
    options: {
      method: "GET",
      headers: buildHeaders(agentId),
    },
    timeoutMs,
    signal,
    timeoutHint: "查询 CoPaw 会话",
  });

  if (!res.ok) {
    throw new Error(`CoPaw list chats failed: ${res.status} ${rawText.slice(0, 500)}`);
  }

  return normalizeList(parseJsonSafe(rawText) ?? rawText);
}

async function resolveChatIdBySession({
  tenantId,
  userId,
  channel,
  sessionId,
  agentId = "",
  signal = null,
}) {
  const primary = await listChatsByFilters({
    tenantId,
    userId,
    channel,
    sessionId,
    agentId,
    signal,
    useFilters: true,
  });
  let matched = pickLatestChatBySession(primary, sessionId);
  if (matched) {
    return String(matched.id || "");
  }

  const fallback = await listChatsByFilters({
    tenantId,
    userId,
    channel,
    sessionId,
    agentId,
    signal,
    useFilters: false,
  });
  matched = pickLatestChatBySession(fallback, sessionId);
  if (matched) {
    return String(matched.id || "");
  }

  return "";
}

export async function stopCopawTask({
  tenantId,
  userId,
  channel,
  sessionId,
  agentId = "",
  signal = null,
}) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    throw new Error("sessionId is required");
  }

  const retries = Math.max(1, Number(process.env.COPAW_STOP_LOOKUP_RETRIES || 3));
  const retryDelayMs = Math.max(50, Number(process.env.COPAW_STOP_LOOKUP_RETRY_DELAY_MS || 250));
  let chatId = "";

  for (let i = 0; i < retries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    chatId = await resolveChatIdBySession({
      tenantId,
      userId,
      channel,
      sessionId: sid,
      agentId,
      signal,
    });
    if (chatId) break;
    if (i < retries - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs);
    }
  }

  if (!chatId) {
    return { stopped: false, chatId: "", reason: "chat_not_found" };
  }

  const stopUrlText = resolveStopUrl();
  if (!stopUrlText) {
    throw new Error("COPAW_STOP_URL is not configured and cannot be derived");
  }

  const stopUrl = new URL(stopUrlText);
  const stopParam = String(process.env.COPAW_STOP_CHAT_ID_PARAM || "chat_id").trim() || "chat_id";
  stopUrl.searchParams.set(stopParam, chatId);

  const timeoutMs = Number(process.env.COPAW_STOP_TIMEOUT_MS || process.env.COPAW_TIMEOUT_MS || 30000);
  const { res, rawText } = await fetchTextWithTimeout({
    url: stopUrl.toString(),
    options: {
      method: "POST",
      headers: buildHeaders(agentId),
    },
    timeoutMs,
    signal,
    timeoutHint: "终止 CoPaw 任务",
  });

  if (!res.ok) {
    throw new Error(`CoPaw stop chat failed: ${res.status} ${rawText.slice(0, 500)}`);
  }

  const json = parseJsonSafe(rawText);
  const stopped = typeof json?.stopped === "boolean" ? json.stopped : true;
  return {
    stopped,
    chatId,
    raw: json ?? rawText,
  };
}

export async function sendToCopaw({
  tenantId,
  userId,
  channel,
  sessionId,
  message,
  agentId = "",
  metadata = {},
  signal = null,
}) {
  const url = process.env.COPAW_MESSAGE_URL;
  if (!url) {
    throw new Error("COPAW_MESSAGE_URL is not configured");
  }

  const payload = buildPayload({
    tenantId,
    userId,
    channel,
    sessionId,
    message,
    metadata,
  });

  const timeoutMs = Number(process.env.COPAW_TIMEOUT_MS || 30000);
  const ctrl = new AbortController();
  let abortedByTimeout = false;
  let abortedByExternal = false;
  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    abortedByExternal = true;
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) {
      onExternalAbort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(agentId),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`CoPaw request failed: ${res.status} ${rawText.slice(0, 500)}`);
    }

    let json = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      json = null;
    }

    return {
      raw: buildRawSummary(res, rawText),
      text: parseCopawResponse(json ?? rawText),
    };
  } catch (error) {
    if (isAbortError(error)) {
      if (abortedByExternal && !abortedByTimeout) {
        throw new Error("request aborted by caller");
      }
      throw wrapAbortAsTimeout(error, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function streamToCopaw({
  tenantId,
  userId,
  channel,
  sessionId,
  message,
  agentId = "",
  metadata = {},
  signal = null,
  onEvent = () => {},
}) {
  const url = process.env.COPAW_MESSAGE_URL;
  if (!url) {
    throw new Error("COPAW_MESSAGE_URL is not configured");
  }

  const payload = buildPayload({
    tenantId,
    userId,
    channel,
    sessionId,
    message,
    metadata,
  });

  const timeoutMs = Number(process.env.COPAW_TIMEOUT_MS || 30000);
  const ctrl = new AbortController();
  let abortedByTimeout = false;
  let abortedByExternal = false;
  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    ctrl.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    abortedByExternal = true;
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) {
      onExternalAbort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(agentId),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`CoPaw request failed: ${res.status} ${errText.slice(0, 500)}`);
    }

    // Non-stream response fallback.
    if (!res.body) {
      const rawText = await res.text();
      return {
        raw: buildRawSummary(res, rawText),
        text: parseCopawResponse(rawText),
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let rawText = "";
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawText += chunk;
      buffer += chunk;

      const split = splitSseFrames(buffer);
      buffer = split.rest;
      for (const frame of split.frames) {
        const ev = parseSseFrame(frame);
        if (ev) onEvent(ev);
      }
    }

    const tail = decoder.decode();
    if (tail) {
      rawText += tail;
      buffer += tail;
    }
    if (buffer.trim()) {
      const ev = parseSseFrame(buffer);
      if (ev) onEvent(ev);
    }

    return {
      raw: buildRawSummary(res, rawText),
      text: parseCopawResponse(rawText),
    };
  } catch (error) {
    if (isAbortError(error)) {
      if (abortedByExternal && !abortedByTimeout) {
        throw new Error("request aborted by caller");
      }
      throw wrapAbortAsTimeout(error, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
