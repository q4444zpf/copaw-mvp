<template>
  <main class="page">
    <header class="hero">
      <h1>{{ viewState.pageTitle }}</h1>
      <p>{{ viewState.pageSubtitle }}</p>
    </header>

    <section class="workspace">
      <div class="chat-host">
        <CopawChatWidget
          api-base-url="http://localhost:8787"
          tenant-id="tenant-a"
          user-id="u-1001"
          channel="web-chat"
          title="Vue3 页面控制助手"
          :skill-methods="pageControlMethods"
          :skill-tool-names="skillToolNames"
          :skill-namespace="'vue3-page-control'"
          @skill-success="onSkillSuccess"
          @skill-error="onSkillError"
        />
      </div>

      <aside class="status-panel">
        <h2>页面控制状态</h2>
        <div class="status-grid">
          <div class="label">执行状态</div>
          <div :class="['value', `status-${runState.status}`]">{{ statusText }}</div>

          <div class="label">最近方法</div>
          <div class="value">{{ runState.lastMethod || "-" }}</div>

          <div class="label">执行时间</div>
          <div class="value">{{ runState.lastRunAt || "-" }}</div>

          <div class="label">结果摘要</div>
          <div class="value">{{ runState.summary || "-" }}</div>

          <div class="label">工具来源</div>
          <div class="value">{{ runState.lastToolSource || "-" }}</div>

          <div class="label">命令ID</div>
          <div class="value">{{ runState.lastCommandId || "-" }}</div>
        </div>

        <div :class="['banner', `banner-${viewState.bannerLevel}`]">
          {{ viewState.bannerText || "等待 skill 指令..." }}
        </div>

        <div class="theme-preview">
          <h3>主题预览</h3>
          <div class="chips">
            <span class="chip">accent: {{ viewState.theme.accent }}</span>
            <span class="chip">panel: {{ viewState.theme.panelBg }}</span>
            <span class="chip">text: {{ viewState.theme.textColor }}</span>
          </div>
        </div>

        <h3>统计数据</h3>
        <pre class="result-box">{{ statsText }}</pre>

        <h3>最近返回</h3>
        <pre class="result-box">{{ resultText }}</pre>

        <h3 v-if="runState.lastError">最近错误</h3>
        <pre v-if="runState.lastError" class="error-box">{{ runState.lastError }}</pre>
      </aside>
    </section>
  </main>
</template>

<script setup>
import { computed, reactive, watchEffect } from "vue";
import CopawChatWidget from "./components/CopawChatWidget.vue";

const skillToolNames = [
  "vue3_page_control_dispatch",
  "copaw_web_skill_dispatch",
  "invoke_vue_method",
];

const runState = reactive({
  status: "idle",
  lastMethod: "",
  lastRunAt: "",
  summary: "",
  lastToolSource: "",
  lastCommandId: "",
  lastResult: null,
  lastError: "",
});

const viewState = reactive({
  pageTitle: "CoPaw Vue3 页面控制 Demo",
  pageSubtitle: "通过 skill 指令直接控制页面状态与展示内容。",
  bannerText: "",
  bannerLevel: "info",
  theme: {
    accent: "#1f5eff",
    panelBg: "#ffffff",
    textColor: "#1f2c3b",
  },
  stats: {
    onlineUsers: 0,
    pendingTasks: 0,
    refreshAt: "",
  },
});

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function setPageTitle(args = {}) {
  const title = asText(args.title, viewState.pageTitle);
  const subtitle = asText(args.subtitle, viewState.pageSubtitle);
  viewState.pageTitle = title;
  viewState.pageSubtitle = subtitle;
  return {
    summary: "页面标题已更新。",
    pageTitle: viewState.pageTitle,
    pageSubtitle: viewState.pageSubtitle,
  };
}

async function showBanner(args = {}) {
  viewState.bannerText = asText(args.message, "已收到指令。");
  const level = asText(args.level, "info").toLowerCase();
  viewState.bannerLevel = ["info", "success", "warning", "error"].includes(level)
    ? level
    : "info";
  return {
    summary: "提示条已更新。",
    bannerText: viewState.bannerText,
    bannerLevel: viewState.bannerLevel,
  };
}

async function setThemeTokens(args = {}) {
  viewState.theme = {
    accent: asText(args.accent, viewState.theme.accent),
    panelBg: asText(args.panelBg, viewState.theme.panelBg),
    textColor: asText(args.textColor, viewState.theme.textColor),
  };
  return {
    summary: "主题变量已更新。",
    theme: { ...viewState.theme },
  };
}

async function updateStats(args = {}) {
  const incoming = safeObject(args.items);
  viewState.stats = {
    ...viewState.stats,
    ...incoming,
    refreshAt: nowText(),
  };
  return {
    summary: "统计面板已刷新。",
    stats: { ...viewState.stats },
  };
}

const pageControlMethods = {
  setPageTitle,
  showBanner,
  setThemeTokens,
  updateStats,
};

function onSkillSuccess(detail) {
  runState.status = "success";
  runState.lastMethod = asText(detail?.method);
  runState.lastRunAt = nowText();
  runState.lastResult = detail?.result ?? null;
  runState.summary = asText(detail?.result?.summary, "执行成功");
  runState.lastToolSource = asText(detail?.toolSource, "native");
  runState.lastCommandId = asText(detail?.commandId, "-");
  runState.lastError = "";
}

function onSkillError(detail) {
  runState.status = "error";
  runState.lastMethod = asText(detail?.method);
  runState.lastRunAt = nowText();
  runState.lastToolSource = asText(detail?.toolSource, "-");
  runState.lastCommandId = asText(detail?.commandId, "-");
  runState.lastError = asText(detail?.error, "unknown error");
}

watchEffect(() => {
  document.documentElement.style.setProperty("--demo-accent", viewState.theme.accent);
  document.documentElement.style.setProperty("--demo-panel-bg", viewState.theme.panelBg);
  document.documentElement.style.setProperty("--demo-text-color", viewState.theme.textColor);
});

const statusText = computed(() => {
  if (runState.status === "success") return "成功";
  if (runState.status === "error") return "失败";
  return "待执行";
});

const resultText = computed(() => {
  if (!runState.lastResult) return "暂无执行结果";
  try {
    return JSON.stringify(runState.lastResult, null, 2);
  } catch {
    return String(runState.lastResult);
  }
});

const statsText = computed(() => JSON.stringify(viewState.stats, null, 2));
</script>

<style scoped>
.page {
  --bg-1: #edf4ff;
  --bg-2: #eef8f1;
  --card: var(--demo-panel-bg, #ffffff);
  --line: #d4dfeb;
  --ink: var(--demo-text-color, #1f2c3b);
  --muted: #4a5c74;
  --accent: var(--demo-accent, #1f5eff);
  --ok: #1e7f4f;
  --err: #bd2f1d;

  height: 100dvh;
  min-height: 100dvh;
  padding: 16px;
  color: var(--ink);
  background: radial-gradient(circle at top left, var(--bg-1), var(--bg-2));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hero h1 {
  margin: 0;
  font-size: clamp(22px, 2.7vw, 34px);
}

.hero p {
  margin: 6px 0 0;
  color: var(--muted);
}

.workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1.45fr 1fr;
  gap: 12px;
}

.chat-host,
.status-panel {
  min-height: 0;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
}

.status-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.status-panel h2,
.status-panel h3 {
  margin: 0;
}

.status-grid {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px;
  align-items: start;
  font-size: 13px;
}

.label {
  color: var(--muted);
}

.value {
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.status-success {
  color: var(--ok);
  font-weight: 700;
}

.status-error {
  color: var(--err);
  font-weight: 700;
}

.banner {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #cfdbeb;
  background: #f4f8ff;
  font-size: 13px;
}

.banner-success {
  border-color: #b9e2cc;
  background: #ecfaf2;
}

.banner-warning {
  border-color: #f5d7ab;
  background: #fff8eb;
}

.banner-error {
  border-color: #f1c4bc;
  background: #fff3f1;
}

.theme-preview {
  border: 1px dashed #cbd8e8;
  border-radius: 8px;
  padding: 10px;
}

.chips {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  border: 1px solid #ccd8ea;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 12px;
  color: #334863;
  background: #f7faff;
}

.result-box,
.error-box {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f9fcff;
  font-size: 12px;
  line-height: 1.45;
  overflow: auto;
  max-height: 220px;
}

.error-box {
  background: #fff6f4;
  border-color: #f3cec8;
  color: #983124;
}

@media (max-width: 1040px) {
  .workspace {
    grid-template-columns: 1fr;
  }
}
</style>
