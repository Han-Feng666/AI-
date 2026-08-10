<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import { useManagerStore } from '../stores/manager';
import { useSettingsStore } from '../stores/settings';
import { useRoute } from 'vue-router';
import workspaceEventBus from '../utils/workspaceEventBus';

const editor = useEditorStore();
const manager = useManagerStore();
const settings = useSettingsStore();
const route = useRoute();
const input = ref('');
const listEl = ref(null);

const ready = computed(() => settings.isConfigured);
const novelId = computed(() => Number(editor.novelId) || Number(route.params.id) || null);
const expandedTools = ref(new Set());

function isToolExpanded(idx) { return expandedTools.value.has(idx); }
function toggleTool(idx) {
  if (expandedTools.value.has(idx)) expandedTools.value.delete(idx);
  else expandedTools.value.add(idx);
  // 触发响应
  expandedTools.value = new Set(expandedTools.value);
}

function toolContentLines(content) {
  return String(content || '').split('\n').length;
}

function sendMode() {
  return settings.managerSendBy || 'enter';
}

const quickPrompts = [
  '帮我看下现在的方案',
  '让 AI 把下一章节奏放慢',
  '查一下这本书的进度',
  '建议下一步剧情的转折',
  '搜索：网文反派角色塑造技巧'
];

async function scrollBottom() {
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
}

watch(novelId, (id) => { if (id != null) manager.load(id); }, { immediate: true });
watch(
  () => manager.messages.length + ':' + (manager.replyStream.length || 0) + ':' + manager.pendingToolCalls.length,
  () => { scrollBottom(); }
);

onMounted(scrollBottom);

// Phase 10：监听联动总线——Manager 工具授权完成后刷新 editor 对应 novel
const unsub = workspaceEventBus.on('novel:outlineUpdated', ({ novelId }) => {
  if (Number(novelId) === Number(novelId.value)) editor.refresh();
});
const unsubChar = workspaceEventBus.on('novel:characterUpdated', ({ novelId }) => {
  if (Number(novelId) === Number(novelId.value)) editor.refresh();
});
onBeforeUnmount(() => { unsub?.(); unsubChar?.(); });

function send(text) {
  if (!ready.value) {
    ElMessage.warning('请先在「设置」中配置大模型 API');
    return;
  }
  if (manager.busy) {
    ElMessage.warning('总管 AI 正在回复中，请稍候');
    return;
  }
  // 不再受 store.busy 阻塞：工作区 AI 工作时仍可对话（REQ-04）
  const content = (text ?? input.value).trim();
  if (!content) return;
  input.value = '';
  manager.send(content, novelId.value).catch(() => {});
}

async function clear() {
  try {
    await ElMessageBox.confirm('清空后丢失全部总管对话历史，确定吗？', '清空对话', { type: 'warning' });
  } catch { return; }
  await manager.clear(novelId.value);
  manager.clearLocal();
  ElMessage.success('已清空');
}

function toolDescription(name, args) {
  const a = args || {};
  const map = {
    get_novel_progress: `查询 ${a.novel_id || ''} 号书的进度`,
    list_shared_characters: '列出共享角色池',
    introduce_shared_character: `把共享角色 ${a.shared_id || ''} 引入 ${a.novel_id || ''} 号书`,
    update_outline: `修改 ${a.novel_id || ''} 号书剧情大纲：${(a.new_outline || '').slice(0, 24)}…`,
    update_character: `修改 ${a.novel_id || ''} 号书角色「${a.name || ''}」`,
    request_revise: `让 ${a.novel_id || ''} 号书 AI 按"${(a.feedback || '').slice(0, 30)}…"修订方案`,
    request_generate_chapter: `让 ${a.novel_id || ''} 号书生成下一章`,
    web_search: `联网搜索：${a.query || ''}`
  };
  return map[name] || name;
}

async function authorize(callId) {
  try { await manager.authorize(callId); ElMessage.success('已授权执行'); }
  catch (e) { ElMessage.error(e.message); }
}

async function reject(callId) {
  try { await manager.reject(callId); }
  catch { /* ignore */ }
}

// 回车发送处理：默认 Enter 直接发；若用户设置 ctrlEnter 则 Enter 换行、Ctrl/Cmd+Enter 发送
function onKeydown(e) {
  const mode = sendMode();
  if (mode === 'ctrlEnter') {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); return; }
    return;  // 普通 Enter 走默认换行
  }
  // mode === 'enter'
  if (e.key === 'Enter' && !e.shiftKey && !(e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
}
</script>

<template>
  <div class="chat-panel">
    <div class="chat-head">
      <div class="chat-title">
        <el-icon :size="16"><ChatDotRound /></el-icon>
        <span>总管 AI</span>
        <span class="chat-sub">最高权限 · 跨书管理</span>
      </div>
      <el-button link size="small" type="danger" @click="clear">
        <el-icon><Delete /></el-icon>
      </el-button>
    </div>

    <div ref="listEl" class="chat-list">
      <template v-for="(m, i) in manager.messages" :key="i">
        <div v-if="m.role === 'user'" class="msg user">
          <div class="bubble user-bubble">{{ m.content }}</div>
        </div>
        <div v-else-if="m.role === 'assistant'" class="msg ai">
          <div class="ai-avatar"><el-icon :size="13"><MagicStick /></el-icon></div>
          <div class="bubble ai-bubble">{{ m.content }}</div>
        </div>
        <div v-else-if="m.role === 'tool'" class="msg ai">
          <div class="ai-avatar tool-avatar"><el-icon :size="13"><Tools /></el-icon></div>
          <div class="bubble tool-bubble">
            <div class="tool-tag">{{ m.toolName || '工具' }} 返回 <span class="tool-toggle" @click="toggleTool(i)">{{ isToolExpanded(i) ? '收起' : '展开' }}</span></div>
            <pre v-if="isToolExpanded(i) || toolContentLines(m.content) <= 3" class="tool-result">{{ m.content }}</pre>
            <pre v-else class="tool-result collapsed">{{ (m.content || '').split('\n').slice(0, 3).join('\n') }}<span class="collapsed-hint">…（共 {{ toolContentLines(m.content) }} 行，点击展开）</span></pre>
          </div>
        </div>
      </template>
      <div v-if="manager.busy && !manager.replyStream" class="msg ai">
        <div class="ai-avatar"><el-icon :size="13"><MagicStick /></el-icon></div>
        <div class="bubble ai-bubble"><el-icon class="is-loading"><Loading /></el-icon></div>
      </div>

      <!-- 待授权工具调用行动卡片 -->
      <div v-for="tc in manager.pendingToolCalls" :key="tc.id" class="pending-card">
        <div class="pending-icon"><el-icon><Tools /></el-icon></div>
        <div class="pending-body">
          <div class="pending-title">AI 准备执行操作</div>
          <div class="pending-desc">{{ toolDescription(tc.name, tc.args) }}</div>
          <div class="pending-args" v-if="Object.keys(tc.args || {}).length">
            <code v-for="(v, k) in tc.args" :key="k">{{ k }}: {{ String(v).slice(0, 40) }}</code>
          </div>
          <div class="pending-actions">
            <el-button size="small" type="primary" @click="authorize(tc.id)">授权执行</el-button>
            <el-button size="small" @click="reject(tc.id)">拒绝</el-button>
          </div>
        </div>
      </div>

      <el-empty
        v-if="!manager.messages.length && !manager.busy && !manager.pendingToolCalls.length"
        description="和总管 AI 聊天，它可查任意书进度、修改大纲/角色、触发修订"
        :image-size="70"
      />
    </div>

    <div class="quick-row">
      <el-tag
        v-for="(p, i) in quickPrompts"
        :key="i"
        class="quick-tag"
        effect="plain"
        @click="send(p)"
      >{{ p }}</el-tag>
    </div>

    <div class="chat-input">
      <el-input
        v-if="ready"
        v-model="input"
        type="textarea"
        :rows="2"
        resize="none"
        :placeholder="sendMode() === 'ctrlEnter' ? 'Ctrl/Cmd+Enter 发送，Enter 换行' : '回车直接发送，Shift+Enter 换行'"
        @keydown="onKeydown"
      />
      <div v-else class="chat-tip-banner">
        未配置大模型 API，请先到「设置」配置地址与密钥后再开始对话
      </div>
      <el-button
        type="primary"
        :loading="manager.busy"
        :disabled="!ready || !input.trim()"
        class="send-btn"
        @click="send()"
      >
        <el-icon><Promotion /></el-icon>
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
  overflow: hidden;
}
.chat-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #eef0f6;
}
.chat-title { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 14px; color: #1e1b4b; }
.chat-sub { font-size: 11px; color: #9ca3af; font-weight: 400; margin-left: 4px; }
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  background: #fafbff;
}
.msg { display: flex; margin-bottom: 12px; }
.msg.user { justify-content: flex-end; }
.msg.ai { justify-content: flex-start; align-items: flex-start; }
.bubble {
  max-width: 82%;
  padding: 10px 13px;
  border-radius: 12px;
  font-size: 13.5px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}
.user-bubble {
  background: #4f46e5;
  color: #fff;
  border-top-right-radius: 3px;
}
.ai-bubble {
  background: #fff;
  border: 1px solid #e5e7f0;
  border-top-left-radius: 3px;
  color: #374151;
}
.ai-avatar {
  width: 24px; height: 24px;
  border-radius: 50%;
  background: #eef0ff;
  color: #4f46e5;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 8px;
  margin-top: 4px;
  flex-shrink: 0;
}
.tool-avatar { background: #fef3c7; color: #d97706; }
.tool-bubble {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #78350f;
  border-top-left-radius: 3px;
  font-size: 12px;
}
.tool-tag { font-weight: 700; font-size: 11px; color: #b45309; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
.tool-toggle { font-weight: 400; color: #6366f1; cursor: pointer; padding: 0 4px; user-select: none; }
.tool-toggle:hover { color: #4f46e5; text-decoration: underline; }
.tool-result {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.6;
  max-height: 220px;
  overflow-y: auto;
}
.tool-result.collapsed { max-height: 64px; overflow: hidden; }
.collapsed-hint { display: block; color: #9ca3af; font-size: 11px; padding-top: 4px; }
.pending-card {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 10px;
  padding: 10px 12px;
  margin: 10px 0;
}
.pending-icon { width: 26px; height: 26px; border-radius: 50%; background: #fed7aa; color: #c2410c; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.pending-title { font-weight: 700; font-size: 13px; color: #9a3412; }
.pending-desc { font-size: 12.5px; color: #7c2d12; margin-top: 4px; line-height: 1.6; }
.pending-args { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.pending-args code { font-size: 11px; padding: 2px 6px; background: #ffedd5; color: #9a3412; border-radius: 4px; }
.pending-actions { margin-top: 8px; display: flex; gap: 8px; }
.quick-row {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  overflow-x: auto;
  border-top: 1px solid #eef0f6;
  background: #fff;
}
.quick-tag {
  cursor: pointer;
  flex-shrink: 0;
  font-size: 12px;
}
.chat-input {
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid #eef0f6;
  background: #fff;
}
.chat-input :deep(.el-textarea__inner) { font-size: 13.5px; }
.chat-tip-banner {
  flex: 1;
  align-self: stretch;
  display: flex;
  align-items: center;
  font-size: 12px;
  color: #9ca3af;
  background: #f5f6fd;
  border-radius: 8px;
  padding: 0 12px;
  height: 56px;
}
.send-btn { align-self: flex-end; height: 56px; }
</style>
