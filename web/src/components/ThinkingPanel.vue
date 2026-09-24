<template>
  <div class="thinking-panel">
    <div class="tp-head">
      <div class="tp-title">
        <el-icon><Cpu /></el-icon>
        <span>AI 思考过程</span>
      </div>
      <span class="tp-status" :class="statusClass">{{ statusText }}</span>
    </div>

    <div class="tp-meta" v-if="active">
      <span class="tp-label">{{ active.label }}</span>
      <span class="tp-model" v-if="active.model">{{ active.model }}</span>
      <el-select
        v-if="sessions.length > 1"
        size="small"
        :model-value="active.id"
        class="tp-history"
        @change="setActive"
      >
        <el-option
          v-for="s in sessions"
          :key="s.id"
          :value="s.id"
          :label="`${s.label} · ${fmtTime(s.startedAt)}`"
        />
      </el-select>
    </div>

    <div class="tp-body" ref="bodyEl">
      <div v-if="!active" class="tp-empty">
        <el-icon class="tp-empty-icon"><Cpu /></el-icon>
        <p>暂无思考内容</p>
        <p class="tp-empty-sub">模型开始推理时，思考过程会实时显示在这里（需在「模型设置 → 思考功能」中开启）</p>
      </div>
      <template v-else>
        <div class="tp-live" :class="statusClass">
          <span class="tp-dot" :class="{ pulsing: active.status === 'thinking' }" />
          {{ active.status === 'thinking' ? '思考中…' : (active.status === 'error' ? '调用失败' : '思考完成') }}
        </div>
        <pre class="tp-text">{{ displayText }}</pre>
      </template>
    </div>

    <div class="tp-foot">
      <span class="tp-count" v-if="active">{{ charCount }} 字</span>
      <button class="tp-clear" type="button" @click="clear">清空</button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useThinkingStore } from '../stores/thinking.js';

const store = useThinkingStore();
const { sessions, active, connected } = storeToRefs(store);
const bodyEl = ref(null);

const displayText = computed(() => {
  const a = active.value;
  if (!a) return '';
  if (a.text) return a.text;
  return a.status === 'thinking' ? '（模型正在组织思路…）' : '';
});

const statusText = computed(() => {
  if (!connected.value) return '连接中…';
  const a = active.value;
  if (!a) return '等待中';
  if (a.status === 'thinking') return '思考中';
  if (a.status === 'error') return '调用失败';
  return '已完成';
});

const statusClass = computed(() => {
  const a = active.value;
  if (a?.status === 'thinking') return 'is-thinking';
  if (a?.status === 'error') return 'is-error';
  return 'is-done';
});

const charCount = computed(() => (active.value?.text || '').length);

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ''; }
}

function setActive(id) {
  store.setActive(id);
}

function clear() {
  store.clear();
}

// 自动滚动：用户停留在底部时跟随最新增量，向上翻阅时不打断
watch(
  () => active.value?.text,
  async () => {
    const el = bodyEl.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    if (nearBottom) {
      await nextTick();
      el.scrollTop = el.scrollHeight;
    }
  }
);

store.connect();
</script>

<style scoped>
.thinking-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #fff;
  border: 1px solid #e5e7ef;
  border-radius: 12px;
  overflow: hidden;
}
.tp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #eef0f7;
  background: #fafaff;
}
.tp-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #1e1b4b;
}
.tp-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: #f0fdf4;
  color: #16a34a;
}
.tp-status.is-thinking {
  background: #eff6ff;
  color: #2563eb;
}
.tp-status.is-error {
  background: #fef2f2;
  color: #dc2626;
}
.tp-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px dashed #eef0f7;
  font-size: 11px;
  color: #6b7280;
  min-width: 0;
}
.tp-label {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: #f5f6fd;
  color: #4338ca;
}
.tp-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-history {
  margin-left: auto;
  max-width: 140px;
}
.tp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
}
.tp-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #9ca3af;
  gap: 4px;
  padding: 0 8px;
}
.tp-empty-icon {
  font-size: 28px;
  color: #c7cdf5;
}
.tp-empty p {
  margin: 0;
  font-size: 13px;
}
.tp-empty-sub {
  font-size: 11px !important;
  line-height: 1.6;
  color: #b3b9d0 !important;
}
.tp-live {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #2563eb;
  margin-bottom: 8px;
}
.tp-live.is-done { color: #16a34a; }
.tp-live.is-error { color: #dc2626; }
.tp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.tp-dot.pulsing {
  animation: tp-pulse 1.2s ease-in-out infinite;
}
@keyframes tp-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}
.tp-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  color: #4b5563;
}
.tp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-top: 1px solid #eef0f7;
  font-size: 11px;
  color: #9ca3af;
}
.tp-clear {
  border: none;
  background: transparent;
  font-size: 11px;
  color: #9ca3af;
  cursor: pointer;
  padding: 2px 4px;
}
.tp-clear:hover {
  color: #4338ca;
}
</style>
