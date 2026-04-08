# Vue Embeddable Chat Widget (MVP)

这个目录提供一个可嵌入业务系统的 Vue 组件。

## 组件

- `src/components/CopawChatWidget.vue`
- `src/services/copawApi.js`

## 依赖

组件内置 Markdown 渲染（用于助手回复、Thinking、工具输出），宿主项目需要安装：

```bash
npm install marked dompurify
```

## 关键参数

- `apiBaseUrl`: 你的中间层地址（如 `http://localhost:8787`）
- `tenantId`: 租户 ID
- `userId`: 业务用户 ID
- `channel`: 渠道名（默认 `web-chat`）
- `skillMethods`: 可被 skill 调用的前端方法映射（`{ [methodName]: fn }`）
- `skillToolNames`: 允许触发前端方法的工具名白名单
- `skillNamespace`: skill 命名空间（默认 `vue3-page-control`）
- `allowAssistantSkillCommand`: 是否允许从助手文本解析 skill 指令（默认 `false`）

## 使用示例

```vue
<template>
  <CopawChatWidget
    api-base-url="http://localhost:8787"
    tenant-id="tenant-a"
    user-id="u-1001"
    channel="web-chat"
    title="智能助手"
    :skill-methods="skillMethods"
    :skill-tool-names="['vue3_page_control_dispatch']"
    @skill-success="onSkillSuccess"
    @skill-error="onSkillError"
  />
</template>

<script setup>
import CopawChatWidget from "./components/CopawChatWidget.vue";

const skillMethods = {
  setPageTitle(args, context) {
    // 在这里执行你的业务页面方法
    console.log("setPageTitle", args, context);
    return { ok: true };
  },
};

function onSkillSuccess(detail) {
  console.log("skill success", detail);
}

function onSkillError(detail) {
  console.error("skill error", detail);
}
</script>
```

## Vue3 页面控制 Skill 协议

`CopawChatWidget` 支持三种指令载体：

- Tool 输入/输出中的 JSON 对象
- `copaw-web-skill` 代码围栏
- `<copaw-web-skill>...</copaw-web-skill>`

推荐 JSON：

```json
{
  "skill": "vue3-page-control",
  "action": "invoke_method",
  "commandId": "vue-control-001",
  "method": "setPageTitle",
  "args": {
    "title": "总览页面",
    "subtitle": "已按会话指令更新"
  }
}
```

## 会话隔离说明

中间层按 `tenant_id + user_id + channel` 自动隔离会话。
