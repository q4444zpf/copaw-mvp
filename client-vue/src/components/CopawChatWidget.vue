<template>
  <section class="copaw-widget">
    <header class="copaw-header">
      <div class="header-title">
        <strong>{{ title }}</strong>
      </div>

      <div class="header-actions">
        <button class="ghost rerun-btn" :disabled="loading || sessionSwitching" @click="onRerun">
          重新运行
        </button>
        <button class="ghost" :disabled="loading || sessionSwitching" @click="onToggleHistoryPanel">
          {{ showHistoryPanel ? "收起历史" : "聊天历史" }}
        </button>
        <button class="ghost" :disabled="loading || sessionSwitching" @click="onNewChat">新建聊天</button>

        <label class="model-switch">
          <span>模型切换</span>
          <select
            v-model="selectedModelId"
            :disabled="loading || sessionSwitching || modelsLoading"
            @change="onModelChange"
          >
            <option value="">默认模型</option>
            <option v-for="item in modelOptions" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
        </label>

        <label class="agent-switch">
          <span>智能体切换</span>
          <select
            v-model="selectedAgentId"
            :disabled="loading || sessionSwitching || agentsLoading"
            @change="onAgentChange"
          >
            <option value="">默认智能体</option>
            <option v-for="item in agentOptions" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
        </label>
      </div>
    </header>

    <section v-if="showHistoryPanel" class="history-panel">
      <div class="history-toolbar">
        <strong>聊天历史</strong>
        <button
          class="link-btn"
          type="button"
          :disabled="sessionsLoading || loading || sessionSwitching"
          @click="refreshChatSessions"
        >
          刷新
        </button>
      </div>

      <div class="history-list">
        <div v-if="sessionsLoading" class="history-empty">历史加载中...</div>
        <div v-else-if="!chatSessions.length" class="history-empty">暂无历史会话</div>

        <button
          v-for="item in chatSessions"
          :key="item.sessionId"
          type="button"
          :class="['history-item', item.sessionId === sessionId ? 'active' : '']"
          :disabled="loading || sessionSwitching"
          @click="onPickHistory(item)"
        >
          <div class="history-main">{{ item.preview || "(空会话)" }}</div>
          <div class="history-meta">
            <span>{{ item.messageCount }} 条消息</span>
            <span>{{ formatSessionTime(item.updatedAt) }}</span>
          </div>
        </button>
      </div>
    </section>

    <div class="copaw-body" ref="bodyRef" @click="onBodyClick">
      <div v-for="item in messages" :key="item.id" :class="['msg', item.role]">
        <template v-if="isTraceRole(item.role)">
          <div class="trace-row-wrap">
            <button
              type="button"
              :class="['trace-row', selectedTraceId === item.id ? 'active' : '']"
              @click="toggleTrace(item.id)"
            >
              <span :class="['trace-icon', `icon-${getTraceKind(item)}`]" aria-hidden="true"></span>
              <span class="trace-row-title">{{ getTraceTitle(item) }}</span>
            </button>

            <div v-if="selectedTraceId === item.id" class="trace-detail">
              <div class="trace-io" v-if="item.role === 'tool' && item.toolInput">
                <div class="trace-label">Input</div>
                <pre class="trace-code">{{ safeJson(item.toolInput) }}</pre>
              </div>
              <div class="trace-io">
                <div class="trace-label">{{ item.role === "reasoning" ? "Thinking" : "Output" }}</div>
                <div
                  class="trace-output md-content"
                  v-html="
                    renderMarkdown(
                      formatTraceText(item.text) ||
                        (item.role === 'reasoning' ? '思考中...' : '(waiting output...)')
                    )
                  "
                ></div>
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div :class="['bubble', item.role]">
            <div
              v-if="item.role === 'assistant'"
              class="md-content"
              v-html="renderMarkdown(item.text)"
            ></div>
            <template v-else>{{ item.text }}</template>
          </div>
        </template>
      </div>
      <div v-if="loading && !streamingStarted" class="msg assistant">
        <div class="bubble">正在思考...</div>
      </div>
    </div>

    <form class="copaw-input" @submit.prevent="onSubmit">
      <input
        v-model="inputText"
        :disabled="loading || sessionSwitching"
        placeholder="输入 / 查看快捷指令；审批时可使用 /approve 或 /deny ..."
        autocomplete="off"
      />
      <button type="submit" :disabled="loading || sessionSwitching || !inputText.trim()">发送</button>
    </form>
  </section>
</template>

<script setup>
import DOMPurify from "dompurify";
import { marked } from "marked";
import { nextTick, onMounted, ref } from "vue";
import {
  ensureSession,
  getAgentOptions,
  getChatSessions,
  getHistory,
  getModelOptions,
  resetSession,
  selectSession,
  sendMessageStream,
} from "../services/copawApi.js";

const props = defineProps({
  apiBaseUrl: { type: String, required: true },
  tenantId: { type: String, required: true },
  userId: { type: String, required: true },
  channel: { type: String, default: "web-chat" },
  title: { type: String, default: "CoPaw 助手" },
});

const bodyRef = ref(null);
const inputText = ref("");
const loading = ref(false);
const sessionSwitching = ref(false);
const sessionId = ref("");
const messages = ref([]);
const streamingStarted = ref(false);
const showHistoryPanel = ref(false);
const sessionsLoading = ref(false);
const chatSessions = ref([]);
const modelsLoading = ref(false);
const modelOptions = ref([]);
const selectedModelId = ref("");
const agentsLoading = ref(false);
const agentOptions = ref([]);
const selectedAgentId = ref("");
const selectedTraceId = ref("");
const fileRefPattern =
  /(?:^|[\s("'`（【\[])([A-Za-z0-9_./\\-]+\.(?:png|jpg|jpeg|gif|webp|svg|html?|pdf|csv|txt|json|md))/gim;
const imageFileExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const htmlFileExtensions = new Set(["html", "htm"]);

function getModelStorageKey() {
  return `copaw:model:${props.tenantId}:${props.userId}:${props.channel}`;
}

function readStoredModelId() {
  try {
    return String(window.localStorage.getItem(getModelStorageKey()) || "").trim();
  } catch {
    return "";
  }
}

function writeStoredModelId(modelId) {
  try {
    const key = getModelStorageKey();
    const value = String(modelId || "").trim();
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

function getAgentStorageKey() {
  return `copaw:agent:${props.tenantId}:${props.userId}:${props.channel}`;
}

function readStoredAgentId() {
  try {
    return String(window.localStorage.getItem(getAgentStorageKey()) || "").trim();
  } catch {
    return "";
  }
}

function writeStoredAgentId(agentId) {
  try {
    const key = getAgentStorageKey();
    const value = String(agentId || "").trim();
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

function normalizeAgentValue(agentId) {
  const value = String(agentId || "").trim();
  if (!value || value === "default") return "";
  return value;
}

function append(role, text) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
  };
  messages.value.push(item);
  return item.id;
}

function appendTool(toolName, toolInput = null) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "tool",
    text: "",
    toolName: String(toolName || "tool_call"),
    toolInput,
  };
  messages.value.push(item);
  return item.id;
}

function updateMessage(id, updater) {
  const idx = messages.value.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const current = messages.value[idx];
  messages.value[idx] = { ...current, text: updater(current.text) };
}

function setMessageText(id, text) {
  const idx = messages.value.findIndex((m) => m.id === id);
  if (idx === -1) return;
  messages.value[idx] = { ...messages.value[idx], text };
}

function updateToolMeta(id, patch = {}) {
  const idx = messages.value.findIndex((m) => m.id === id);
  if (idx === -1) return;
  messages.value[idx] = { ...messages.value[idx], ...patch };
}

function safeJson(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTraceText(text) {
  return String(text || "").replace(/^思考中\.\.\.\s*/u, "").trim();
}

function formatSessionTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeModelItems(items) {
  const source = Array.isArray(items) ? items : [];
  const seen = new Set();
  const list = [];
  for (const item of source) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(item?.label || id).trim() || id;
    list.push({ id, label });
  }
  return list;
}

function mapHistoryItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: `hist-${item.id}-${Math.random().toString(36).slice(2, 6)}`,
    role:
      item.role === "user"
        ? "user"
        : item.role === "reasoning"
          ? "reasoning"
          : item.role === "tool"
            ? "tool"
            : "assistant",
    text: item.text || "",
    toolName: item.toolName || "",
    toolInput: item.toolInput || null,
  }));
}

function isTraceRole(role) {
  return role === "reasoning" || role === "tool";
}

function getTraceTitle(item) {
  if (!item || typeof item !== "object") return "Trace";
  if (item.role === "reasoning") return "Thinking";
  return String(item.toolName || "tool_call");
}

function getTraceKind(item) {
  if (!item || typeof item !== "object") return "tool";
  if (item.role === "reasoning") return "thinking";

  const name = String(item.toolName || "").toLowerCase();
  if (!name) return "tool";

  if (
    name.includes("browser") ||
    name.includes("web") ||
    name.includes("crawl") ||
    name.includes("page")
  ) {
    return "browser";
  }

  if (
    name.includes("file") ||
    name.includes("read") ||
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("path") ||
    name.includes("dir")
  ) {
    return "file";
  }

  if (
    name.includes("python") ||
    name.includes("shell") ||
    name.includes("bash") ||
    name.includes("cmd") ||
    name.includes("powershell") ||
    name.includes("code")
  ) {
    return "code";
  }

  if (
    name.includes("search") ||
    name.includes("query") ||
    name.includes("fetch") ||
    name.includes("http")
  ) {
    return "web";
  }

  return "tool";
}

function toggleTrace(traceId) {
  const id = String(traceId || "");
  if (!id) return;
  selectedTraceId.value = selectedTraceId.value === id ? "" : id;
}

function renderMarkdown(text) {
  const source = String(text || "");
  if (!source.trim()) return "";
  const enhanced = appendFileLinksAndEmbeds(source);
  let html = marked.parse(enhanced, {
    gfm: true,
    breaks: true,
    async: false,
  });
  html = html.replace(/<a /gi, '<a target="_blank" rel="noopener noreferrer" ');
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: [
      "src",
      "title",
      "loading",
      "class",
      "target",
      "rel",
      "allow",
      "allowfullscreen",
      "frameborder",
      "data-copy-url",
      "data-file-name",
    ],
  });
}

function buildFileContentUrl(fileRef) {
  const normalized = String(fileRef || "").replace(/\\/g, "/");
  const queryKey = normalized.includes("/") ? "path" : "name";
  return `${props.apiBaseUrl}/api/files/content?${queryKey}=${encodeURIComponent(normalized)}`;
}

function collectFileRefs(text) {
  const refs = [];
  const seen = new Set();
  const source = String(text || "");
  fileRefPattern.lastIndex = 0;
  let matched;

  while ((matched = fileRefPattern.exec(source)) !== null) {
    const raw = String(matched[1] || "").trim().replace(/[),.;，。]+$/u, "");
    if (!raw) continue;
    if (raw.includes("://")) continue;

    const ext = raw.split(".").pop()?.toLowerCase() || "";
    if (!ext) continue;

    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    refs.push({ file: raw, ext });
  }

  return refs;
}

function appendFileLinksAndEmbeds(text) {
  const refs = collectFileRefs(text);
  if (!refs.length) return text;

  const block = [];
  block.push("");
  block.push('<div class="generated-files">');
  block.push('<div class="generated-title">生成文件</div>');

  for (const ref of refs) {
    const url = buildFileContentUrl(ref.file);
    const extLabel = String(ref.ext || "").toUpperCase();
    block.push('<div class="file-card">');
    block.push('  <div class="file-card-main">');
    block.push(`    <span class="file-chip">${extLabel}</span>`);
    block.push(
      `    <a class="file-link" href="${url}" target="_blank" rel="noopener noreferrer">${ref.file}</a>`
    );
    block.push("  </div>");
    block.push('  <div class="file-card-actions">');
    block.push(
      `    <a class="file-open" href="${url}" target="_blank" rel="noopener noreferrer">打开</a>`
    );
    block.push(
      `    <button type="button" class="file-copy-btn" data-copy-url="${url}" data-file-name="${ref.file}">复制链接</button>`
    );
    block.push("  </div>");
    block.push("</div>");

    if (imageFileExtensions.has(ref.ext)) {
      block.push(
        `<img class="file-inline-preview" src="${url}" alt="${ref.file}" loading="lazy" />`
      );
    } else if (htmlFileExtensions.has(ref.ext)) {
      block.push(`<iframe class="file-preview" src="${url}" title="${ref.file}" loading="lazy"></iframe>`);
    }
  }
  block.push("</div>");

  return `${text}\n${block.join("\n")}`;
}

async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fallback below
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

async function onBodyClick(event) {
  const target = event?.target;
  if (!(target instanceof HTMLElement)) return;
  const btn = target.closest(".file-copy-btn");
  if (!btn) return;

  const url = btn.getAttribute("data-copy-url") || "";
  const ok = await copyText(url);
  const original = btn.textContent || "复制链接";
  btn.textContent = ok ? "已复制" : "复制失败";
  window.setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

async function scrollToBottom() {
  await nextTick();
  if (bodyRef.value) {
    bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
  }
}

async function initSession() {
  sessionId.value = await ensureSession({
    apiBaseUrl: props.apiBaseUrl,
    tenantId: props.tenantId,
    userId: props.userId,
    channel: props.channel,
  });
}

async function loadModelList() {
  modelsLoading.value = true;
  try {
    const data = await getModelOptions({ apiBaseUrl: props.apiBaseUrl });
    const items = normalizeModelItems(data.models);
    modelOptions.value = items;

    const stored = readStoredModelId();
    const validIds = new Set(items.map((item) => item.id));
    const defaultModel = String(data.defaultModel || "").trim();

    if (stored && validIds.has(stored)) {
      selectedModelId.value = stored;
    } else if (defaultModel && validIds.has(defaultModel)) {
      selectedModelId.value = defaultModel;
    } else {
      selectedModelId.value = items[0]?.id || "";
    }

    writeStoredModelId(selectedModelId.value);
  } catch {
    modelOptions.value = [];
    selectedModelId.value = "";
  } finally {
    modelsLoading.value = false;
  }
}

async function loadAgentList() {
  agentsLoading.value = true;
  try {
    const data = await getAgentOptions({ apiBaseUrl: props.apiBaseUrl });
    const items = normalizeModelItems(data.agents).filter((item) => item.id !== "default");
    agentOptions.value = items;

    const stored = normalizeAgentValue(readStoredAgentId());
    const validIds = new Set(items.map((item) => item.id));
    const defaultAgent = normalizeAgentValue(data.defaultAgent);

    if (stored && validIds.has(stored)) {
      selectedAgentId.value = stored;
    } else if (defaultAgent && validIds.has(defaultAgent)) {
      selectedAgentId.value = defaultAgent;
    } else {
      selectedAgentId.value = items[0]?.id || "";
    }

    writeStoredAgentId(selectedAgentId.value);
  } catch {
    agentOptions.value = [];
    selectedAgentId.value = "";
  } finally {
    agentsLoading.value = false;
  }
}

async function refreshChatSessions() {
  sessionsLoading.value = true;
  try {
    const data = await getChatSessions({
      apiBaseUrl: props.apiBaseUrl,
      tenantId: props.tenantId,
      userId: props.userId,
      channel: props.channel,
      limit: 30,
    });

    chatSessions.value = (data.items || []).map((item) => ({
      sessionId: String(item.sessionId || ""),
      messageCount: Number(item.messageCount || 0),
      updatedAt: String(item.updatedAt || ""),
      preview: String(item.preview || item.lastText || "").trim(),
    }));

    if (data.activeSessionId) {
      sessionId.value = String(data.activeSessionId);
    }
  } catch {
    chatSessions.value = [];
  } finally {
    sessionsLoading.value = false;
  }
}

async function loadHistory(targetSessionId = "") {
  const data = await getHistory({
    apiBaseUrl: props.apiBaseUrl,
    tenantId: props.tenantId,
    userId: props.userId,
    channel: props.channel,
    sessionId: targetSessionId,
    limit: 100,
  });
  sessionId.value = data.sessionId || targetSessionId || sessionId.value;
  messages.value = mapHistoryItems(data.items || []);
  selectedTraceId.value = "";
}

function onModelChange() {
  writeStoredModelId(selectedModelId.value);
}

function onAgentChange() {
  selectedAgentId.value = normalizeAgentValue(selectedAgentId.value);
  writeStoredAgentId(selectedAgentId.value);
}

function getLastUserMessageText() {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    const item = messages.value[i];
    if (item?.role === "user") {
      return String(item.text || "").trim();
    }
  }
  return "";
}

async function onToggleHistoryPanel() {
  if (showHistoryPanel.value) {
    showHistoryPanel.value = false;
    return;
  }
  await refreshChatSessions();
  showHistoryPanel.value = true;
}

async function onPickHistory(item) {
  const targetSessionId = String(item?.sessionId || "").trim();
  if (!targetSessionId || loading.value || sessionSwitching.value) return;

  sessionSwitching.value = true;
  try {
    await selectSession({
      apiBaseUrl: props.apiBaseUrl,
      tenantId: props.tenantId,
      userId: props.userId,
      channel: props.channel,
      sessionId: targetSessionId,
    });
    sessionId.value = targetSessionId;
    await loadHistory(targetSessionId);
    showHistoryPanel.value = false;
  } catch (error) {
    append("assistant", `切换会话失败：${error.message}`);
  } finally {
    sessionSwitching.value = false;
    await scrollToBottom();
  }
}

async function runChat(text) {
  if (!text || loading.value || sessionSwitching.value) return;

  append("user", text);
  loading.value = true;
  streamingStarted.value = false;
  await scrollToBottom();

  try {
    let reasoningId = "";
    let assistantId = "";
    const toolByMsgId = new Map();
    const toolByCallId = new Map();
    const effectiveAgentId = normalizeAgentValue(selectedAgentId.value);

    await sendMessageStream({
      apiBaseUrl: props.apiBaseUrl,
      tenantId: props.tenantId,
      userId: props.userId,
      channel: props.channel,
      sessionId: sessionId.value,
      agentId: effectiveAgentId,
      modelId: selectedModelId.value,
      message: text,
      metadata: {
        source: "embedded-vue-widget",
        model_id: selectedModelId.value || "",
        agent_id: effectiveAgentId,
      },
      onEvent: (ev) => {
        if (!ev || typeof ev !== "object") return;

        if (ev.type === "session" && ev.sessionId) {
          sessionId.value = ev.sessionId;
          return;
        }

        if (ev.type === "reasoning_delta") {
          streamingStarted.value = true;
          if (!reasoningId) {
            reasoningId = append("reasoning", "");
          }
          updateMessage(reasoningId, (prev) => prev + String(ev.text || ""));
          void scrollToBottom();
          return;
        }

        if (ev.type === "tool_start") {
          const msgId = String(ev.msgId || "");
          const callId = String(ev.callId || "");
          let toolItemId = "";

          if (callId && toolByCallId.has(callId)) {
            toolItemId = toolByCallId.get(callId);
          } else if (msgId && toolByMsgId.has(msgId)) {
            toolItemId = toolByMsgId.get(msgId);
          } else {
            toolItemId = appendTool(ev.toolName || ev.toolType || "tool_call", ev.input || null);
          }

          updateToolMeta(toolItemId, {
            toolName: ev.toolName || ev.toolType || "tool_call",
            toolInput: ev.input ?? null,
          });

          if (msgId) {
            toolByMsgId.set(msgId, toolItemId);
          }
          if (callId) {
            toolByCallId.set(callId, toolItemId);
          }
          streamingStarted.value = true;
          void scrollToBottom();
          return;
        }

        if (ev.type === "tool_delta") {
          const msgId = String(ev.msgId || "");
          const callId = String(ev.callId || "");
          let toolItemId =
            (callId && toolByCallId.get(callId)) || (msgId && toolByMsgId.get(msgId)) || "";
          if (!toolItemId) {
            toolItemId = appendTool(ev.toolName || ev.toolType || "tool_call", null);
            if (msgId) {
              toolByMsgId.set(msgId, toolItemId);
            }
            if (callId) {
              toolByCallId.set(callId, toolItemId);
            }
          }
          updateToolMeta(toolItemId, {
            toolName: ev.toolName || ev.toolType || "tool_call",
          });
          updateMessage(toolItemId, (prev) => prev + String(ev.text || ""));
          streamingStarted.value = true;
          void scrollToBottom();
          return;
        }

        if (ev.type === "tool_output") {
          const msgId = String(ev.msgId || "");
          const callId = String(ev.callId || "");
          let toolItemId =
            (callId && toolByCallId.get(callId)) || (msgId && toolByMsgId.get(msgId)) || "";
          if (!toolItemId) {
            toolItemId = appendTool(ev.toolName || ev.toolType || "tool_call", null);
          }
          if (msgId) {
            toolByMsgId.set(msgId, toolItemId);
          }
          if (callId) {
            toolByCallId.set(callId, toolItemId);
          }
          updateToolMeta(toolItemId, {
            toolName: ev.toolName || ev.toolType || "tool_call",
          });
          setMessageText(toolItemId, String(ev.text || "").trim());
          streamingStarted.value = true;
          void scrollToBottom();
          return;
        }

        if (ev.type === "assistant_delta") {
          streamingStarted.value = true;
          if (!assistantId) {
            assistantId = append("assistant", "");
          }
          updateMessage(assistantId, (prev) => prev + String(ev.text || ""));
          void scrollToBottom();
          return;
        }

        if (ev.type === "assistant_final") {
          streamingStarted.value = true;
          const finalText = String(ev.text || "(empty response)");
          if (!assistantId) {
            assistantId = append("assistant", finalText);
          } else {
            setMessageText(assistantId, finalText);
          }
          void scrollToBottom();
        }
      },
    });

    if (showHistoryPanel.value) {
      await refreshChatSessions();
    }
  } catch (error) {
    append("assistant", `请求失败：${error.message}`);
  } finally {
    loading.value = false;
    streamingStarted.value = false;
    await scrollToBottom();
  }
}

async function onSubmit() {
  const text = inputText.value.trim();
  if (!text) return;
  inputText.value = "";
  await runChat(text);
}

async function onRerun() {
  const text = getLastUserMessageText();
  if (!text || loading.value || sessionSwitching.value) return;
  await runChat(text);
}

async function onNewChat() {
  if (loading.value || sessionSwitching.value) return;
  loading.value = true;
  try {
    sessionId.value = await resetSession({
      apiBaseUrl: props.apiBaseUrl,
      tenantId: props.tenantId,
      userId: props.userId,
      channel: props.channel,
    });
    messages.value = [];
    selectedTraceId.value = "";
    append("assistant", "已新建聊天，我们重新开始。");
    if (showHistoryPanel.value) {
      await refreshChatSessions();
    }
  } catch (error) {
    append("assistant", `新建聊天失败：${error.message}`);
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

onMounted(async () => {
  try {
    await initSession();
    await Promise.all([loadModelList(), loadAgentList(), refreshChatSessions()]);
    await loadHistory(sessionId.value);
    if (!messages.value.length) {
      append("assistant", "你好，我是 CoPaw 助手。");
    }
  } catch (error) {
    append("assistant", `初始化失败：${error.message}`);
  }
  await scrollToBottom();
});
</script>

<style scoped>
.copaw-widget {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
  overflow: hidden;
}

.copaw-header {
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: #f7f7f7;
}

.header-title {
  min-width: 0;
  color: #1f2937;
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.rerun-btn {
  border-color: #f3e7dd;
  background: #f6f1ed;
}

.model-switch,
.agent-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #44556d;
}

.model-switch select,
.agent-switch select {
  min-width: 120px;
  height: 30px;
  border: 1px solid #c8d3e0;
  border-radius: 8px;
  padding: 0 8px;
  background: #fff;
}

.history-panel {
  border-bottom: 1px solid #e5edf8;
  background: #f8fbff;
  padding: 10px 12px;
}

.history-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.link-btn {
  border: none;
  background: transparent;
  color: #0f62fe;
  font-size: 12px;
  cursor: pointer;
}

.link-btn:disabled {
  color: #9cb2d8;
  cursor: not-allowed;
}

.history-list {
  max-height: 220px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-empty {
  font-size: 12px;
  color: #6b7280;
  padding: 6px 2px;
}

.history-item {
  width: 100%;
  text-align: left;
  border: 1px solid #dbe5f3;
  border-radius: 8px;
  padding: 8px;
  background: #fff;
  cursor: pointer;
}

.history-item:hover {
  border-color: #9ab7eb;
}

.history-item.active {
  border-color: #0f62fe;
  background: #edf4ff;
}

.history-main {
  color: #243447;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-meta {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #6b7280;
  font-size: 11px;
}

.copaw-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #f5f5f5;
}

.msg {
  display: flex;
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

.msg.reasoning {
  justify-content: flex-start;
  width: 100%;
}

.msg.tool {
  justify-content: flex-start;
  width: 100%;
}

.bubble {
  max-width: 85%;
  padding: 10px 12px;
  border-radius: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user .bubble {
  background: #0f62fe;
  color: #fff;
}

.msg.assistant .bubble {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  color: #1f2937;
}

.md-content {
  white-space: normal;
}

.md-content :deep(p) {
  margin: 0 0 10px;
}

.md-content :deep(p:last-child) {
  margin-bottom: 0;
}

.md-content :deep(ul),
.md-content :deep(ol) {
  margin: 0 0 10px 18px;
  padding: 0;
}

.md-content :deep(li) {
  margin: 4px 0;
}

.md-content :deep(pre) {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f5f7fb;
  overflow: auto;
}

.md-content :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.md-content :deep(blockquote) {
  margin: 8px 0;
  padding: 6px 10px;
  border-left: 3px solid #c9d5e8;
  color: #4b5563;
  background: #f7f9fc;
}

.md-content :deep(a) {
  color: #0f62fe;
  text-decoration: underline;
}

.md-content :deep(img) {
  max-width: 100%;
  height: auto;
  border: 1px solid #dde5f1;
  border-radius: 8px;
  margin: 8px 0;
  display: block;
  background: #fff;
}

.md-content :deep(iframe.file-preview) {
  width: 100%;
  min-height: 320px;
  border: 1px solid #dde5f1;
  border-radius: 8px;
  margin: 8px 0;
  background: #fff;
}

.md-content :deep(.generated-files) {
  margin-top: 10px;
  border: 1px solid #d9e3f2;
  border-radius: 10px;
  padding: 10px;
  background: #f7fbff;
}

.md-content :deep(.generated-title) {
  font-weight: 700;
  color: #2c3f56;
  margin-bottom: 8px;
}

.md-content :deep(.file-card) {
  border: 1px solid #dbe4f3;
  background: #fff;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}

.md-content :deep(.file-card-main) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.md-content :deep(.file-chip) {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e8f0ff;
  color: #234ea0;
  font-size: 11px;
  font-weight: 700;
}

.md-content :deep(.file-link) {
  overflow-wrap: anywhere;
}

.md-content :deep(.file-card-actions) {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.md-content :deep(.file-open),
.md-content :deep(.file-copy-btn) {
  font-size: 12px;
  border: 1px solid #cbd8ee;
  background: #f8fbff;
  color: #30558d;
  border-radius: 6px;
  padding: 2px 8px;
  text-decoration: none;
  cursor: pointer;
}

.md-content :deep(.file-inline-preview) {
  max-width: 100%;
  height: auto;
  border: 1px solid #dde5f1;
  border-radius: 8px;
  margin: 8px 0 12px;
  display: block;
  background: #fff;
}

.trace-row-wrap {
  width: 100%;
}

.trace-row {
  width: 100%;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #1f2937;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  text-align: left;
}

.trace-row:hover {
  background: #efefef;
}

.trace-row.active {
  background: #e9e9e9;
}

.trace-icon {
  min-width: 18px;
  height: 18px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.2px;
  flex: 0 0 18px;
  color: #475569;
  background: #e5e7eb;
}

.trace-icon::before {
  content: "T";
}

.trace-icon.icon-thinking {
  color: #9a3412;
  background: #ffedd5;
}

.trace-icon.icon-thinking::before {
  content: "Th";
}

.trace-icon.icon-browser {
  color: #1e3a8a;
  background: #dbeafe;
}

.trace-icon.icon-browser::before {
  content: "W";
}

.trace-icon.icon-file {
  color: #14532d;
  background: #dcfce7;
}

.trace-icon.icon-file::before {
  content: "F";
}

.trace-icon.icon-code {
  color: #5b21b6;
  background: #ede9fe;
}

.trace-icon.icon-code::before {
  content: "C";
}

.trace-icon.icon-web {
  color: #0f766e;
  background: #ccfbf1;
}

.trace-icon.icon-web::before {
  content: "S";
}

.trace-row-title {
  font-size: 13px;
  color: #111827;
}

.trace-detail {
  margin: 4px 0 10px 18px;
}

.trace-io {
  margin: 0 0 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}

.trace-label {
  font-size: 12px;
  padding: 6px 10px;
  color: #4b5563;
  background: #f8fafc;
  border-bottom: 1px solid #e5e7eb;
}

.trace-code {
  margin: 0;
  padding: 10px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #2f3b4a;
}

.trace-output {
  margin: 0;
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  color: #2f3b4a;
}

.copaw-input {
  height: 64px;
  border-top: 1px solid #eef2f7;
  display: flex;
  gap: 8px;
  padding: 10px;
  background: #fff;
}

.copaw-input input {
  flex: 1;
  border: 1px solid #cfd8e3;
  border-radius: 8px;
  padding: 0 10px;
  font-size: 14px;
}

.copaw-input button,
.ghost {
  border: 1px solid #c8d3e0;
  background: #fff;
  border-radius: 8px;
  padding: 0 12px;
  cursor: pointer;
}

.copaw-input button {
  background: #0f62fe;
  border-color: #0f62fe;
  color: #fff;
}

.copaw-input button:disabled,
.ghost:disabled,
.history-item:disabled,
.model-switch select:disabled,
.agent-switch select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 900px) {
  .copaw-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
