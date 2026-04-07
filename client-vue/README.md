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

## 使用示例

```vue
<template>
  <CopawChatWidget
    api-base-url="http://localhost:8787"
    tenant-id="tenant-a"
    user-id="u-1001"
    channel="web-chat"
    title="智能助手"
  />
</template>

<script setup>
import CopawChatWidget from "./components/CopawChatWidget.vue";
</script>
```

## 会话隔离说明

中间层按 `tenant_id + user_id + channel` 自动隔离会话。
