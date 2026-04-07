<template>
  <main class="page">
    <h1>CoPaw MVP Chat Demo</h1>
    <div class="chat-host">
      <CopawChatWidget
        api-base-url="http://localhost:8787"
        tenant-id="tenant-a"
        user-id="u-1001"
        channel="web-chat"
        title="智能助手"
      />
    </div>
  </main>
</template>

<script setup>
import CopawChatWidget from "./components/CopawChatWidget.vue";
</script>

<style scoped>
.page {
  height: 100dvh;
  min-height: 100dvh;
  padding: 16px;
  background: #f3f6fb;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.chat-host {
  flex: 1;
  min-height: 0;
  width: min(100%, 960px);
}

h1 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 32px);
  color: #22324b;
}
</style>
