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

export async function sendToCopaw({
  tenantId,
  userId,
  channel,
  sessionId,
  message,
  agentId = "",
  metadata = {},
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
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

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
    throw wrapAbortAsTimeout(error, timeoutMs);
  } finally {
    clearTimeout(timeout);
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
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

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
    throw wrapAbortAsTimeout(error, timeoutMs);
  } finally {
    clearTimeout(timeout);
  }
}
