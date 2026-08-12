<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import { copyText } from '../utils/format';
import api from '../api';

const store = useEditorStore();
const contentBox = ref(null);
const genBox = ref(null);
const showSummary = ref(false);

// 正文按段落拆分渲染（首行缩进）
const paragraphs = computed(() => {
  const text = store.activeChapter?.content || '';
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
});

// 上 / 下一章
const prevIndex = computed(() => {
  const arr = store.chapters;
  const i = arr.findIndex((c) => c.chapter_index === store.activeChapter?.chapter_index);
  if (i <= 0) return null;
  return arr[i - 1].chapter_index;
});
const nextIndex = computed(() => {
  const arr = store.chapters;
  const i = arr.findIndex((c) => c.chapter_index === store.activeChapter?.chapter_index);
  if (i === -1 || i >= arr.length - 1) return null;
  return arr[i + 1].chapter_index;
});

function goChapter(idx) {
  if (idx == null) return;
  store.selectChapter(idx);
}

// 编辑态实时字数
const editLen = computed(() => store.editContent.length);
const targetLen = computed(() => store.novel?.chapter_word_count || 2000);
const editReached = computed(() => editLen.value >= targetLen.value);

// 快捷键：←/→ 切换章节，Ctrl+S 保存编辑
function onKeydown(e) {
  if (store.chapterEdit) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveEdit();
    }
    return;
  }
  if (store.busy) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft' && prevIndex.value != null) goChapter(prevIndex.value);
  else if (e.key === 'ArrowRight' && nextIndex.value != null) goChapter(nextIndex.value);
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

// 编辑草稿自动保存（localStorage），防止刷新/误关丢失
const draftKey = computed(() => {
  if (!store.activeChapter) return null;
  return `novel_draft_${store.novelId}_${store.activeChapter.chapter_index}`;
});
let draftTimer = null;

watch(
  () => store.editContent,
  () => {
    if (!store.chapterEdit) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (draftKey.value && store.editContent) localStorage.setItem(draftKey.value, store.editContent);
    }, 1200);
  }
);

function clearDraft() {
  if (draftKey.value) localStorage.removeItem(draftKey.value);
}

function startEdit() {
  store.editContent = store.activeChapter.content || '';
  store.chapterEdit = true;
  const saved = draftKey.value ? localStorage.getItem(draftKey.value) : null;
  if (saved && saved !== (store.activeChapter.content || '')) {
    ElMessageBox.confirm('检测到上次未保存的编辑草稿，是否恢复？', '恢复草稿', {
      confirmButtonText: '恢复',
      cancelButtonText: '忽略'
    })
      .then(() => { store.editContent = saved; })
      .catch(() => { localStorage.removeItem(draftKey.value); });
  }
}

function cancelEdit() {
  store.chapterEdit = false;
  clearDraft();
}

// AI 味检测
const detect = ref(null);
const detectLoading = ref(false);
const detectLevel = computed(() => {
  if (!detect.value) return null;
  const s = detect.value.score;
  if (s <= 30) return { text: '文风合格', cls: 'ok' };
  if (s <= 60) return { text: '存在 AI 味', cls: 'warn' };
  return { text: 'AI 味较重', cls: 'bad' };
});

async function runDetect() {
  if (detectLoading.value || !store.activeChapter) return;
  detect.value = null;
  detectLoading.value = true;
  try {
    const r = await api.detectChapter(store.novelId, store.activeChapter.chapter_index);
    detect.value = {
      score: r.score,
      issues: r.issues || [],
      blacklist: r.blacklist || [],
      passed: r.passed
    };
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    detectLoading.value = false;
  }
}

// 章节历史版本
const backups = ref([]);
const backupsOpen = ref(false);
const backupsLoading = ref(false);

async function openBackups() {
  if (!store.activeChapter) return;
  backupsOpen.value = true;
  backupsLoading.value = true;
  try {
    backups.value = await api.getBackups(store.novelId, store.activeChapter.chapter_index);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    backupsLoading.value = false;
  }
}

async function restoreBackup(b) {
  try {
    await ElMessageBox.confirm(
      `将恢复「${b.reason}」版本的 ${b.content.length} 字内容并覆盖当前章节，确定吗？`,
      '恢复历史版本',
      { type: 'warning' }
    );
  } catch { return; }
  try {
    await api.restoreBackup(store.novelId, store.activeChapter.chapter_index, b.id);
    await store.refresh();
    await store.selectChapter(store.activeChapter.chapter_index);
    backupsOpen.value = false;
    detect.value = null;
    ElMessage.success('已恢复历史版本');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function saveEdit() {
  try {
    await store.saveChapterEdit();
    clearDraft();
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function copyChapter() {
  const text = store.activeChapter?.content || '';
  if (!text) return;
  const ok = await copyText(text);
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制到剪贴板' : '复制失败，请手动复制');
}

async function regenerate() {
  const idx = store.activeChapter.chapter_index;
  try {
    await ElMessageBox.confirm(`将重新生成第 ${idx} 章并覆盖当前内容，确定吗？`, '重新生成本章', { type: 'warning' });
  } catch { return; }
  try {
    await store.generateChapter({ mode: 'regenerate', chapterIndex: idx });
    ElMessage.success('本章已重新生成');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function polish() {
  try {
    await ElMessageBox.confirm(
      '将按人类写作风格重写本章，清除 AI 痕迹（保留剧情与人设）。覆盖当前内容，确定吗？',
      '去 AI 味润色',
      { type: 'info', confirmButtonText: '开始润色', cancelButtonText: '取消' }
    );
  } catch { return; }
  try {
    const data = await store.polishChapter();
    detect.value = {
      score: data?.detect?.score ?? 0,
      issues: data?.detect?.issues || [],
      blacklist: data?.detect?.blacklist || [],
      passed: !!data?.passed,
      rounds: data?.rounds || []
    };
    ElMessage.success(data?.passed ? '润色完成，AI 味检测已达标' : '润色完成（检测仍有残留，可再次润色）');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeChapter() {
  const idx = store.activeChapter.chapter_index;
  try {
    await ElMessageBox.confirm(`确定删除第 ${idx} 章吗？此操作不可恢复。`, '删除章节', { type: 'warning' });
  } catch { return; }
  try {
    await store.deleteChapter(idx);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// 本地模型生成本章（离线模式，Ollama 优先，降级规则引擎）
const localGenLoading = ref(false);
const localGenLayer = ref(null);
async function localGenerate() {
  const idx = store.activeChapter.chapter_index;
  try {
    await ElMessageBox.confirm(
      '将使用本地模型生成本章内容（Ollama 优先，无 Ollama 时用内置模板引擎），覆盖当前内容。确定吗？',
      '本地模型生成',
      { type: 'info', confirmButtonText: '开始生成', cancelButtonText: '取消' }
    );
  } catch { return; }
  localGenLoading.value = true;
  localGenLayer.value = null;
  store.busy = true;
  store.busyLabel = '本地模型生成中…';
  store.genStream = '';
  try {
    const targetWords = store.novel?.chapter_word_count || 2000;
    await api.localGenerateChapter(store.novelId, idx, targetWords, {
      onStatus: (msg) => { store.busyLabel = msg; },
      onDelta: (chunk) => {
        if (chunk) store.genStream = (store.genStream || '') + chunk;
      },
      onError: (msg) => ElMessage.error(msg)
    });
    await store.refresh();
    await store.selectChapter(idx);
    ElMessage.success('本地模型生成完成');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    localGenLoading.value = false;
    store.busy = false;
    store.busyLabel = '';
    store.genStream = '';
  }
}

// 生成时滚动到底部
watch(
  () => store.genStream,
  async () => {
    await nextTick();
    if (genBox.value) genBox.value.scrollTop = genBox.value.scrollHeight;
  }
);

watch(
  () => store.activeChapter,
  async () => {
    detect.value = null;
    await nextTick();
    if (contentBox.value) contentBox.value.scrollTop = 0;
  }
);
</script>

<template>
  <div class="chapter-area">
    <!-- 生成中实时内容 -->
    <div v-if="store.busy" class="gen-wrap">
      <div class="gen-head">
        <div class="gen-status">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ store.busyLabel }}</span>
        </div>
        <el-button size="small" @click="store.stop()">
          <el-icon style="margin-right:4px"><VideoPause /></el-icon>停止生成
        </el-button>
      </div>
      <div v-if="store.genProgress > 0 && store.genProgress < 100" class="gen-progress">
        <el-progress
          :percentage="store.genProgress"
          :stroke-width="8"
          :show-text="true"
          color="#7c3aed"
          striped
          striped-flow
          :duration="20"
        />
      </div>
      <div ref="genBox" class="gen-content">
        {{ store.genStream }}
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!store.activeChapter" class="empty-area">
      <el-empty :description="store.hasPlanned ? '从左侧章节列表选择一章开始阅读，或点击「生成下一章」' : '先输入灵感想法，让 AI 生成创作方案'" />
    </div>

    <!-- 章节阅读/编辑 -->
    <div v-else class="chapter-read">
      <div class="chapter-head">
        <div class="chapter-title-wrap">
          <el-input
            v-if="store.chapterEdit"
            v-model="store.activeChapter.title"
            size="large"
            class="title-input"
            placeholder="章节标题"
          />
          <div v-else class="chapter-title">{{ store.activeChapter.title || `第${store.activeChapter.chapter_index}章` }}</div>
        </div>
        <div class="chapter-meta">
          <el-tag size="small" type="info" effect="plain">第 {{ store.activeChapter.chapter_index }} 章</el-tag>
          <el-tag size="small" type="success" effect="plain">{{ store.activeChapter.word_count || 0 }} 字</el-tag>
          <el-tag v-if="store.activeChapter.summary && !store.chapterEdit" size="small" type="warning" effect="plain" @click="showSummary = !showSummary">{{ showSummary ? '隐藏概要' : '章节概要' }}</el-tag>
        </div>
      </div>

      <div v-if="showSummary && store.activeChapter?.summary && !store.chapterEdit" class="chapter-summary-bar">
        <el-icon style="margin-right:4px"><Document /></el-icon>
        <span>{{ store.activeChapter.summary }}</span>
      </div>

      <div class="chapter-tools">
        <template v-if="!store.chapterEdit">
          <el-button size="small" @click="startEdit"><el-icon style="margin-right:4px"><Edit /></el-icon>编辑</el-button>
          <el-button size="small" type="success" plain @click="copyChapter"><el-icon style="margin-right:4px"><CopyDocument /></el-icon>一键复制</el-button>
          <el-button size="small" type="info" plain :loading="detectLoading" @click="runDetect"><el-icon style="margin-right:4px"><Aim /></el-icon>AI味检测</el-button>
          <el-button size="small" type="warning" plain @click="polish"><el-icon style="margin-right:4px"><Brush /></el-icon>去AI味</el-button>
          <el-button size="small" type="primary" plain @click="store.adaptDialog = true"><el-icon style="margin-right:4px"><MagicStick /></el-icon>整本改编</el-button>
          <el-button size="small" @click="openBackups"><el-icon style="margin-right:4px"><Clock /></el-icon>历史版本</el-button>
          <el-button size="small" type="warning" plain @click="regenerate"><el-icon style="margin-right:4px"><Refresh /></el-icon>重新生成</el-button>
          <el-button size="small" type="primary" plain @click="localGenerate" :loading="localGenLoading"><el-icon style="margin-right:4px"><Cpu /></el-icon>本地生成</el-button>
          <el-button size="small" type="danger" plain @click="removeChapter"><el-icon style="margin-right:4px"><Delete /></el-icon>删除</el-button>
        </template>
        <template v-else>
          <el-button size="small" type="primary" @click="saveEdit"><el-icon style="margin-right:4px"><Check /></el-icon>保存</el-button>
          <el-button size="small" @click="cancelEdit">取消</el-button>
        </template>
      </div>

      <!-- AI 味检测结果 -->
      <div v-if="detect && !store.chapterEdit" class="detect-box">
        <div class="detect-head">
          <span class="detect-label"><el-icon><Aim /></el-icon> AI 味检测</span>
          <span class="detect-score" :class="detectLevel.cls">AI 味 {{ detect.score }} 分 · {{ detectLevel.text }}</span>
          <span v-if="detect.passed" class="detect-pass"><el-icon><CircleCheck /></el-icon>已达标</span>
          <span v-if="detect.rounds && detect.rounds.length" class="detect-rounds">共 {{ detect.rounds.length }} 轮润色</span>
          <div class="detect-ops">
            <el-button v-if="!detect.passed" size="small" type="warning" plain @click="polish">
              <el-icon style="margin-right:4px"><Brush /></el-icon>去 AI 味润色
            </el-button>
            <el-button size="small" @click="detect = null">关闭</el-button>
          </div>
        </div>
        <div v-if="detect.blacklist && detect.blacklist.length" class="detect-blacklist">
          <span class="bl-label">命中 AI 高频词：</span>
          <el-tag v-for="w in detect.blacklist" :key="w" size="small" type="danger" effect="plain">{{ w }}</el-tag>
        </div>
        <div v-if="detect.issues.length" class="detect-issues">
          <div v-for="(issue, i) in detect.issues" :key="i" class="issue-item">
            <div class="issue-head">
              <el-tag v-if="issue.category" size="small" effect="light" class="issue-cat">{{ issue.category }}</el-tag>
              <span class="issue-problem">{{ issue.problem }}</span>
            </div>
            <div class="issue-quote">「{{ issue.quote }}」</div>
            <div v-if="issue.suggestion" class="issue-suggestion">建议：{{ issue.suggestion }}</div>
          </div>
        </div>
        <div v-else class="detect-clean">未检测到明显 AI 痕迹，文风合格。</div>
      </div>

      <!-- 历史版本弹窗 -->
      <el-dialog v-model="backupsOpen" :title="'第 ' + store.activeChapter?.chapter_index + ' 章 · 历史版本'" width="520px">
        <div v-loading="backupsLoading">
          <div v-if="!backups.length" class="backup-empty">
            暂无历史版本。每次「重新生成」「去 AI 味」「恢复版本」覆盖章节前，系统会自动保留旧内容。
          </div>
          <div v-for="b in backups" :key="b.id" class="backup-item">
            <div class="backup-info">
              <div class="backup-reason">{{ b.reason || '历史版本' }}</div>
              <div class="backup-sub">{{ b.created_at }} · {{ b.content.length }} 字{{ b.title ? ' · ' + b.title : '' }}</div>
            </div>
            <el-button size="small" type="primary" plain @click="restoreBackup(b)">恢复</el-button>
          </div>
        </div>
      </el-dialog>

      <div v-if="store.chapterEdit" class="chapter-edit-wrap">
        <el-input
          v-model="store.editContent"
          type="textarea"
          class="chapter-editor"
          placeholder="编辑章节正文…"
        />
        <div class="edit-footer">
          <span class="edit-count" :class="{ reached: editReached }">{{ editLen }} 字</span>
          <span class="edit-target">目标约 {{ targetLen }} 字{{ editReached ? ' · 已达标，可保存' : '' }}</span>
          <span class="edit-shortcut">Ctrl + S 保存</span>
        </div>
      </div>
      <div v-else ref="contentBox" class="chapter-content">
        <p v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</p>
      </div>
      <div v-if="!store.chapterEdit && store.activeChapter?.word_count > 0" class="word-progress-bar">
        <span>章节字数 {{ store.activeChapter.word_count }} / 目标 {{ targetLen }} 字</span>
        <el-progress :percentage="Math.min(100, Math.round((store.activeChapter.word_count / targetLen) * 100))" :color="store.activeChapter.word_count >= targetLen ? '#10b981' : '#6366f1'" :stroke-width="6" style="flex:1;max-width:300px" />
      </div>
      <div v-if="!store.chapterEdit" class="chapter-nav-row">
        <el-button :disabled="!prevIndex" @click="goChapter(prevIndex)">
          <el-icon style="margin-right:4px"><ArrowLeft /></el-icon>上一章
        </el-button>
        <span class="nav-hint">键盘 ← / → 快速切换章节</span>
        <el-button :disabled="!nextIndex" @click="goChapter(nextIndex)">
          下一章<el-icon style="margin-left:4px"><ArrowRight /></el-icon>
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chapter-area {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
  overflow: hidden;
}
.gen-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.gen-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid #eef0f6;
  background: #fafbff;
}
.gen-status { display: flex; align-items: center; gap: 8px; color: #4f46e5; font-weight: 600; font-size: 14px; }
.gen-progress {
  padding: 10px 20px 0;
  border-bottom: 1px solid #eef0f6;
  background: #fafbff;
}
.gen-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  font-size: 15px;
  line-height: 2;
  color: #374151;
  white-space: pre-wrap;
}
.empty-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chapter-read {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chapter-head {
  padding: 18px 28px 8px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.title-input :deep(.el-input__wrapper) {
  background: #fafbff;
  border: 1px solid #c7d2fe;
  box-shadow: none;
}
.chapter-title { font-size: 20px; font-weight: 700; color: #1e1b4b; }
.chapter-meta { display: flex; gap: 8px; flex-shrink: 0; margin-top: 4px; }
.chapter-meta .el-tag { cursor: pointer; }
.chapter-summary-bar {
  margin: 0 28px 8px;
  padding: 8px 12px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  font-size: 13px;
  color: #92400e;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  line-height: 1.7;
}
.word-progress-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 28px 8px;
  font-size: 12px;
  color: #6b7280;
}
.chapter-tools {
  padding: 8px 28px 12px;
  display: flex;
  gap: 8px;
  border-bottom: 1px solid #eef0f6;
}
.chapter-edit-wrap { flex: 1; overflow: hidden; padding: 12px 28px; display: flex; flex-direction: column; }
.chapter-editor {
  height: 100%;
}
.chapter-editor :deep(textarea) {
  height: 100% !important;
  font-size: 15px;
  line-height: 1.9;
  font-family: inherit;
}
.edit-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px 0;
  font-size: 12px;
  color: #9ca3af;
}
.edit-count { font-weight: 700; color: #6b7280; }
.edit-count.reached { color: #059669; }
.edit-target { color: #9ca3af; }
.edit-shortcut { margin-left: auto; color: #c4c8dd; }
.chapter-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px 12px;
  font-size: 15.5px;
  line-height: 2.05;
  color: #333c50;
  text-align: justify;
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
}
.chapter-content .para {
  margin: 0 0 0.9em;
  text-indent: 2em;
  white-space: pre-wrap;
}
.chapter-nav-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 32px 20px;
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
  flex-shrink: 0;
}
.nav-hint { font-size: 12px; color: #c4c8dd; }
.detect-box {
  margin: 0 28px 12px;
  padding: 12px 16px;
  background: #fafbff;
  border: 1px solid #e5e7f0;
  border-radius: 10px;
}
.detect-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.detect-label { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px; color: #1e1b4b; }
.detect-score { font-size: 13px; font-weight: 700; }
.detect-score.ok { color: #059669; }
.detect-score.warn { color: #d97706; }
.detect-score.bad { color: #dc2626; }
.detect-ops { margin-left: auto; display: flex; gap: 8px; }
.detect-pass {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: #059669;
  background: #ecfdf5;
  border-radius: 999px;
  padding: 2px 10px;
}
.detect-rounds { font-size: 12px; color: #6b7280; }
.detect-blacklist {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}
.bl-label { color: #b91c1c; font-weight: 600; }
.detect-issues { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.issue-item {
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #fde68a;
  border-radius: 8px;
}
.issue-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.issue-cat { flex-shrink: 0; }
.issue-quote { font-size: 13px; color: #1e1b4b; }
.issue-problem { font-size: 12px; color: #b45309; }
.issue-suggestion { font-size: 12px; color: #6b7280; margin-top: 3px; }
.detect-clean { margin-top: 10px; font-size: 13px; color: #059669; }
.backup-empty { font-size: 13px; color: #9ca3af; padding: 16px 4px; text-align: center; }
.backup-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  margin-bottom: 8px;
  background: #fafbff;
}
.backup-reason { font-size: 13px; font-weight: 600; color: #374151; }
.backup-sub { font-size: 12px; color: #9ca3af; margin-top: 2px; }
</style>
