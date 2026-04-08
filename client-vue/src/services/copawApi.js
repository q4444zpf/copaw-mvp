export async function ensureSession({ apiBaseUrl, tenantId, userId, channel }) {
  const res = await fetch(`${apiBaseUrl}/api/chat/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
    body: JSON.stringify({ channel }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to create session");
  }
  return data.sessionId;
}

export async function getChatSessions({
  apiBaseUrl,
  tenantId,
  userId,
  channel,
  limit = 20,
}) {
  const url = new URL(`${apiBaseUrl}/api/chat/sessions`);
  url.searchParams.set("channel", channel || "web-chat");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to load sessions");
  }
  return data;
}

export async function selectSession({
  apiBaseUrl,
  tenantId,
  userId,
  channel,
  sessionId,
}) {
  const res = await fetch(`${apiBaseUrl}/api/chat/session/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
    body: JSON.stringify({ channel, sessionId }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to select session");
  }
  return data;
}

export async function getModelOptions({ apiBaseUrl }) {
  const res = await fetch(`${apiBaseUrl}/api/chat/models`, {
    method: "GET",
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to load models");
  }
  return data;
}

export async function getAgentOptions({ apiBaseUrl }) {
  const res = await fetch(`${apiBaseUrl}/api/chat/agents`, {
    method: "GET",
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to load agents");
  }
  return data;
}

export async function resetSession({ apiBaseUrl, tenantId, userId, channel }) {
  const res = await fetch(`${apiBaseUrl}/api/chat/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
    body: JSON.stringify({ channel }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to reset session");
  }
  return data.sessionId;
}

export async function getHistory({
  apiBaseUrl,
  tenantId,
  userId,
  channel,
  sessionId = "",
  limit = 100,
}) {
  const url = new URL(`${apiBaseUrl}/api/chat/history`);
  url.searchParams.set("channel", channel || "web-chat");
  url.searchParams.set("limit", String(limit));
  if (sessionId) {
    url.searchParams.set("session_id", String(sessionId));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to load history");
  }
  return data;
}

export async function sendMessage({
  apiBaseUrl,
  tenantId,
  userId,
  channel,
  sessionId = "",
  agentId = "",
  modelId = "",
  message,
  metadata = {},
}) {
  const res = await fetch(`${apiBaseUrl}/api/chat/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
    body: JSON.stringify({ channel, sessionId, agentId, modelId, message, metadata }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to send message");
  }
  return data;
}

export async function stopChatTask({
  apiBaseUrl,
  tenantId,
  userId,
  channel,
  sessionId = "",
  agentId = "",
  modelId = "",
}) {
  const res = await fetch(`${apiBaseUrl}/api/chat/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
    },
    body: JSON.stringify({ channel, sessionId, agentId, modelId }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to stop chat task");
  }
  return data;
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

export async function sendMessageStream({
  apiBaseUrl,
  tenantId,
  userId,
  channel,
  sessionId = "",
  agentId = "",
  modelId = "",
  message,
  metadata = {},
  signal,
  onEvent = () => {},
}) {
  const res = await fetch(`${apiBaseUrl}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": tenantId,
      "x-user-id": userId,
      Accept: "text/event-stream",
    },
    signal,
    body: JSON.stringify({ channel, sessionId, agentId, modelId, message, metadata }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to stream message");
  }
  if (!res.body) {
    throw new Error("No response stream available");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let doneEvent = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const split = splitSseFrames(buffer);
    buffer = split.rest;
    for (const frame of split.frames) {
      const ev = parseSseFrame(frame);
      if (!ev) continue;
      if (ev.type === "error") {
        throw new Error(ev.error || "stream error");
      }
      if (ev.type === "done") {
        doneEvent = ev;
      }
      onEvent(ev);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim()) {
    const ev = parseSseFrame(buffer);
    if (ev) {
      if (ev.type === "error") {
        throw new Error(ev.error || "stream error");
      }
      if (ev.type === "done") {
        doneEvent = ev;
      }
      onEvent(ev);
    }
  }

  return doneEvent;
}
