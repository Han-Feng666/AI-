<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { useEditorStore } from '../stores/editor';
import api from '../api';
import { GENRES, PRESET_STYLES, LENGTH_CLASSES, splitGenres, planStreamPreview, readTxtFile } from '../utils/format';
import { diffLines } from 'diff';

const store = useEditorStore();
const router = useRouter();

// Phase 7：版本历史抽屉
const versionDrawer = ref(false);
const versions = ref([]);
const versionsLoading = ref(false);
const diffKey = ref('outline');
const diffVisible = ref(false);

const diffKeys = [
  { key: 'title', label: '书名' },
  { key: 'genre', label: '类型' },
  { key: 'world_view', label: '世界观' },
  { key: 'outline', label: '剧情大纲' }
];

const pending = computed(() => store.pendingVersion);
const pendingSnap = computed(() => pending.value?.snapshot || {});
const oldNovel = computed(() => store.novel || {});
// 方案生成中：把流式 JSON 提炼成中文预览，避免把英文键名的原始 JSON 透传给用户
const planPreviewText = computed(() => planStreamPreview(store.genStream));

// diff 计算：逐字段比 current novel 和 pending snapshot
const diffs = computed(() => {
  const cur = oldNovel.value || {};
  const next = pendingSnap.value || {};
  return diffKeys.map(({ key, label }) => {
    const a = String(cur[key] || '').trim();
    const b = String(next[key] || '').trim();
    if (a === b) return { key, label, changed: false };
    const hunks = diffLines(a || '', b || '');
    return { key, label, changed: true, hunks };
  });
});

const changedChars = computed(() => {
  const cur = store.characters || [];
  const next = pendingSnap.value?.characters || [];
  const curNames = cur.map((c) => c.name);
  const nextNames = next.map((c) => c.name);
  const added = next.filter((c) => !curNames.includes(c.name));
  const removed = cur.filter((c) => !nextNames.includes(c.name));
  return { added, removed, diff: added.length || removed.length || nextNames.length !== curNames.length };
});

const changedChapters = computed(() => {
  const cur = store.chapters || [];
  const next = pendingSnap.value?.chapters || [];
  const curTitles = cur.map((c) => c.title);
  const nextTitles = next.map((c) => c.title);
  const added = next.filter((c) => !curTitles.includes(c.title));
  const removed = cur.filter((c) => !nextTitles.includes(c.title));
  return { added, removed, diff: added.length || removed.length || nextTitles.length !== curTitles.length };
});

async function openVersions() {
  versionDrawer.value = true;
  versionsLoading.value = true;
  try {
    const r = await api.listPlanVersions(store.novelId);
    versions.value = r.versions || [];
  } catch { versions.value = []; }
  versionsLoading.value = false;
}

async function rollbackTo(v) {
  try {
    await store.rollbackToVersion(v.id);
    ElMessage.success(`已回滚到 v${v.version_no}`);
    versionDrawer.value = false;
  } catch (e) { ElMessage.error(e.message); }
}

async function acceptPending() {
  try {
    await store.acceptPendingVersion();
    ElMessage.success('已采纳新方案，方案已落库生效');
  } catch (e) { ElMessage.error(e.message); }
}

async function dismissPending() {
  await store.rollbackPendingVersion();
  ElMessage.info('已弃用候选版本');
}

// 草稿与已保存值解耦：避免输入回写 store 引发 watch 死循环
const planForm = ref({
  concept: '',
  genre: ['玄幻'],
  chapterWordCount: 2000,
  targetChapters: 20
});
const styleIds = ref([]);
const stylePresets = ref([]);
const planGenerating = ref(false);
const planDialog = ref(false);
const feedback = ref('');
const revHistory = ref([]);
const searchLoading = ref(false);
const searchOpen = ref(false);
const searchResults = ref([]);

const importOpen = ref(false);
const importing = ref(false);
const importTitle = ref('');
const importFile = ref(null);

function onImportPick(file) {
  const raw = file && (file.raw || file);
  if (!raw || typeof raw.arrayBuffer !== 'function') return;
  importFile.value = raw;
  if (!importTitle.value) {
    importTitle.value = (raw.name || '').replace(/\.txt$/i, '');
  }
}

function onImportRemove() {
  importFile.value = null;
}

async function doImport() {
  if (!importFile.value) { ElMessage.warning('请选择 TXT 文件'); return; }
  if (!importTitle.value.trim()) { ElMessage.warning('请填写作品标题'); return; }
  if (importFile.value.size > 5 * 1024 * 1024) { ElMessage.warning('文件过大，请控制在 5MB 以内'); return; }
  importing.value = true;
  try {
    const text = await readTxtFile(importFile.value);
    const data = await store.importTxt(importTitle.value.trim(), text);
    if (data?.novel) {
      importOpen.value = false;
      importFile.value = null;
      importTitle.value = '';
      ElMessage.success(`已导入《${data.novel.title}》，共 ${data.imported || 0} 章`);
    }
  } catch (e) {
    ElMessage.error(e.message || '导入失败');
  } finally {
    importing.value = false;
  }
}

async function searchRef() {
  const kw = planForm.value.concept.trim().slice(0, 50);
  if (!kw) {
    ElMessage.warning('请先输入灵感想法，再搜索参考资料');
    return;
  }
  searchLoading.value = true;
  searchOpen.value = true;
  searchResults.value = [];
  try {
    const data = await api.search(kw, { fetchContent: true });
    searchResults.value = data.results || [];
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    searchLoading.value = false;
  }
}

// Phase 9：篇幅分级
const lengthClass = ref('medium');
function applyLengthClass(c) {
  lengthClass.value = c.key;
  planForm.value.chapterWordCount = c.chapterWordCount;
  planForm.value.targetChapters = c.targetChapters;
}
watch(lengthClass, (k) => {
  const c = LENGTH_CLASSES.find(x => x.key === k);
  if (!c) return;
  // 仅在用户确实切换时把推荐值写回（若 user 已手动改且与推荐一致则不打架）
  if (planForm.value.chapterWordCount === c.chapterWordCount && planForm.value.targetChapters === c.targetChapters) return;
}, { immediate: false });

// Phase 9：风格 tag 拖拽到 list
function onStyleDrop(e) {
  e.preventDefault();
  const name = e.dataTransfer.getData('text/style-preset');
  if (name && !stylePresets.value.includes(name)) {
    stylePresets.value.push(name);
    ElMessage.success(`已加入风格：${name}`);
  }
}
function onStyleDragEnter(e) { e.preventDefault(); }
function onStyleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
function onPresetDragStart(e, name) {
  e.dataTransfer.setData('text/style-preset', name);
  e.dataTransfer.effectAllowed = 'copy';
}
// 标记是否正在同步 novel→表单，避免自动保存触发回环
let syncing = false;

function goStyles() {
  router.push('/styles');
}

onMounted(() => {
  store.loadStyles();
});

// 监听 novel 变化，把已保存值同步到草稿（仅在没有进行中的编辑时）
watch(
  () => store.novel,
  (n) => {
    if (!n) return;
    syncing = true;
    planForm.value.concept = n.concept || '';
    planForm.value.genre = n.genre ? splitGenres(n.genre) : ['玄幻'];
    planForm.value.chapterWordCount = Number(n.chapter_word_count) || 2000;
    planForm.value.targetChapters = Number(n.target_chapters) || 20;
    styleIds.value = (n.style_ids || []).slice();
    stylePresets.value = (n.style_presets || []).slice();
    lengthClass.value = n.length_class || 'medium';
    syncing = false;
  },
  { immediate: true }
);

// 草稿自动保存：任一字段变化且与已保存值不同就写回后端
let saveTimer = null;
watch(
  [planForm, styleIds, stylePresets],
  () => {
    if (syncing || !store.novel) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autoSaveDraft, 600);
  },
  { deep: true }
);

async function autoSaveDraft() {
  const n = store.novel;
  if (!n) return;
  const patch = {
    concept: planForm.value.concept,
    genre: planForm.value.genre.join(','),
    chapter_word_count: Number(planForm.value.chapterWordCount) || 2000,
    target_chapters: Number(planForm.value.targetChapters) || 20,
    style_ids: styleIds.value,
    style_presets: stylePresets.value,
    length_class: lengthClass.value
  };
  // 与已存值不同才保存
  if (
    patch.concept === (n.concept || '') &&
    patch.genre === (n.genre || '') &&
    patch.chapter_word_count === (Number(n.chapter_word_count) || 2000) &&
    patch.target_chapters === (Number(n.target_chapters) || 20) &&
    JSON.stringify(patch.style_ids) === JSON.stringify(n.style_ids || []) &&
    JSON.stringify(patch.style_presets) === JSON.stringify(n.style_presets || []) &&
    patch.length_class === (n.length_class || 'medium')
  ) return;
  try {
    await store.saveNovelSettings(patch);
  } catch (e) {
    // 自动保存失败不打扰，前台会在手动保存/生成时报错
  }
}

async function startPlan() {
  if (planGenerating.value || store.busy) return;
  if (!planForm.value.concept.trim()) {
    ElMessage.warning('请先输入你的灵感想法');
    return;
  }
  planGenerating.value = true;
  try {
    await store.saveStyles(styleIds.value);
    const data = await store.generatePlan({
      ...planForm.value,
      genre: planForm.value.genre.join(','),
      stylePresets: stylePresets.value,
      lengthClass: lengthClass.value
    });
    if (!data) return;
    planDialog.value = true;
    ElMessage.success('创作方案已生成，可以查看方案或提出修改意见');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    planGenerating.value = false;
  }
}

async function submitRevise() {
  const f = feedback.value.trim();
  if (!f) {
    ElMessage.warning('请先填写修改意见');
    return;
  }
  if (store.busy) return;
  try {
    const r = await store.revisePlan(f);
    if (!r) return;
    revHistory.value.push({ feedback: f, at: new Date().toLocaleTimeString() });
    feedback.value = '';
    ElMessage.success('方案已按你的意见更新');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function confirmPlan() {
  store.setWorkspace('chapters');
  planDialog.value = false;
}

function closePlanDialog() {
  planDialog.value = false;
  // 方案已生成时回到章节工作区，避免留在创作设置页且左侧导航无对应入口
  if (store.hasPlanned) store.setWorkspace('chapters');
}
</script>

<template>
  <div class="setup-panel">
    <div class="setup-title">创作设置</div>
    <el-form label-position="top" class="setup-form">
      <el-form-item label="灵感想法" required>
        <el-input
          v-model="planForm.concept"
          type="textarea"
          :rows="6"
          placeholder="描述你的想法：世界观、主角、核心冲突…"
        />
      </el-form-item>
      <el-form-item label="小说类型（可多选）">
        <el-checkbox-group v-model="planForm.genre" class="check-grid">
          <el-checkbox v-for="g in GENRES" :key="g" :value="g" class="check-item">{{ g }}</el-checkbox>
        </el-checkbox-group>
      </el-form-item>
      <el-form-item label="篇幅分级">
        <el-radio-group v-model="lengthClass" class="length-group">
          <el-radio v-for="c in LENGTH_CLASSES" :key="c.key" :value="c.key" class="length-radio" @change="applyLengthClass(c)">
            <div class="length-card">
              <div class="lc-title">{{ c.label }}</div>
              <div class="lc-desc">{{ c.desc }}</div>
            </div>
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="创作风格（可选，可多选）">
        <div class="style-target" @drop="onStyleDrop" @dragenter="onStyleDragEnter" @dragover="onStyleDragOver">
          <div v-if="!stylePresets.length" class="style-target-empty">将下方风格标签拖到这里，或直接点击</div>
          <span v-for="s in stylePresets" :key="s" class="style-pill">{{ s }}<i class="x" @click.stop="stylePresets = stylePresets.filter(x=>x!==s)">×</i></span>
        </div>
        <div class="style-source">
          <span
            v-for="s in PRESET_STYLES"
            :key="s"
            class="style-tag"
            draggable="true"
            @dragstart="onPresetDragStart($event, s)"
            @click="stylePresets.includes(s) || (stylePresets.push(s), ElMessage.success(`已加入风格：${s}`))"
          >{{ s }}</span>
        </div>
      </el-form-item>
      <el-form-item label="每章字数">
        <el-slider v-model="planForm.chapterWordCount" :min="500" :max="8000" :step="500" show-input :format-tooltip="(v) => v + ' 字'" />
        <div class="field-tip">AI 生成每一章正文时大致的字数目标</div>
      </el-form-item>
      <el-form-item>
        <template #label>
          全本总章数
          <el-tooltip content="决定全书共多少章，AI 会一次性规划完整的分章大纲（含每章标题与梗概），之后逐章生成正文。如需中途调整，可在生成后重新生成方案。" placement="top">
            <el-icon class="field-help"><QuestionFilled /></el-icon>
          </el-tooltip>
        </template>
        <el-input-number v-model="planForm.targetChapters" :min="1" :max="2000" />
        <div class="field-tip">这是<strong>整部小说</strong>的章节数，AI 会先规划好全本分章大纲，再逐章创作正文；例如设为 100 就是全书 100 章</div>
      </el-form-item>
      <el-form-item label="写作风格（可选，来自风格库，可多选）">
        <el-checkbox-group v-model="styleIds" class="check-grid">
          <el-checkbox v-for="s in store.allStyles" :key="s.id" :value="s.id" class="check-item">{{ s.name }}</el-checkbox>
        </el-checkbox-group>
        <div v-if="!store.allStyles.length" class="style-empty-tip">
          风格库为空，可前往
          <el-link type="primary" :underline="false" @click="goStyles">风格库</el-link>
          导入文本并提取文风
        </div>
      </el-form-item>
      <div class="setup-actions">
        <el-button
          type="primary"
          style="flex: 1"
          :loading="planGenerating || store.busy"
          @click="startPlan"
        >
          <el-icon style="margin-right:6px"><Sparkles /></el-icon>
          {{ store.busy ? store.busyLabel : 'AI 生成创作方案' }}
        </el-button>
        <el-button :loading="searchLoading" @click="searchRef">
          <el-icon style="margin-right:4px"><Search /></el-icon>搜索参考
        </el-button>
      </div>

      <el-dialog v-model="searchOpen" title="联网搜索参考" width="600px">
        <div v-loading="searchLoading">
          <div v-if="!searchResults.length && !searchLoading" class="search-empty">未找到相关结果</div>
          <div v-for="(r, i) in searchResults" :key="i" class="search-result-item">
            <div class="search-result-title">
              <a :href="r.url" target="_blank" rel="noopener">{{ r.title || '(无标题)' }}</a>
            </div>
            <div v-if="r.snippet" class="search-result-snippet">{{ r.snippet }}</div>
            <div v-if="r.fetchedContent" class="search-result-content">{{ r.fetchedContent.slice(0, 300) }}…</div>
          </div>
        </div>
      </el-dialog>
      <div v-if="store.busy" class="plan-progress">
        <div class="plan-progress-status">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ store.busyLabel }}</span>
        </div>
        <div class="plan-progress-bar">
          <el-progress
            :percentage="store.genProgress"
            :stroke-width="10"
            :show-text="true"
            color="#7c3aed"
            striped
            striped-flow
            :duration="20"
          />
          <span class="plan-progress-pct">{{ store.genProgress }}%</span>
        </div>
        <pre v-if="store.genStream && planPreviewText" class="plan-progress-stream">{{ planPreviewText }}</pre>
      </div>
      <div class="setup-tip">
        只需一个想法，AI 将自动生成书名、世界观、大纲、角色关系网与完整章节规划
      </div>

      <div v-if="pending" class="pending-banner">
        <div class="pending-banner-head">
          <el-icon color="#d97706"><Bell /></el-icon>
          <span class="pb-title">有一个待采纳的修订方案 v{{ pending.versionNo }}</span>
          <span class="pb-feedback">意见：{{ pending.feedback || '未填' }}</span>
        </div>
        <div class="pb-actions">
          <el-button size="small" type="primary" @click="diffVisible = true">查看对比</el-button>
          <el-button size="small" plain type="primary" @click="acceptPending">采纳</el-button>
          <el-button size="small" @click="dismissPending">弃用</el-button>
        </div>
      </div>

      <div class="import-txt-entry">
        <div class="import-txt-head">
          <el-icon color="#4f46e5"><UploadFilled /></el-icon>
          <span>已有整本小说？</span>
        </div>
        <div class="import-txt-desc">导入 TXT 全文，自动拆分章节，作为新书开始创作或进行整本改编。</div>
        <el-button size="small" plain type="primary" @click="importOpen = true">导入 TXT</el-button>
      </div>

      <div class="history-entry">
        <el-link type="primary" :underline="false" @click="openVersions">
          <el-icon><Clock /></el-icon>
          历史版本与回滚
        </el-link>
      </div>
    </el-form>

    <el-dialog
      v-model="planDialog"
      title="创作方案 · 策划讨论"
      width="680px"
      :close-on-click-modal="false"
      append-to-body
      class="plan-dialog"
    >
      <div v-if="pending" class="plan-dialog-pending-tip">
        <el-icon color="#d97706"><Bell /></el-icon>
        <span>这是基于你提出的「{{ pending.feedback || '' }}」意见生成的新方案 v{{ pending.versionNo }}。请查看对比后决定是否采纳。</span>
        <el-button size="small" type="primary" plain @click="diffVisible = true">对比旧方案</el-button>
        <el-button size="small" type="primary" @click="acceptPending">采纳</el-button>
        <el-button size="small" @click="dismissPending">弃用</el-button>
      </div>
      <div class="plan-overview" v-if="store.novel">
        <div class="plan-head">
          <span class="plan-book">{{ store.novel.title || '未命名' }}</span>
          <el-tag v-if="store.novel.genre" size="small" effect="plain">{{ splitGenres(store.novel.genre).join('、') }}</el-tag>
        </div>
        <div v-if="store.novel.style_presets?.length" class="plan-block">
          <div class="plan-label">创作风格</div>
          <div class="plan-chars">
            <span v-for="s in store.novel.style_presets" :key="s" class="plan-char">{{ s }}</span>
          </div>
        </div>
        <div v-if="store.novel.world_view" class="plan-block">
          <div class="plan-label">世界观设定</div>
          <div class="plan-text">{{ store.novel.world_view }}</div>
        </div>
        <div v-if="store.novel.outline" class="plan-block">
          <div class="plan-label">剧情大纲</div>
          <div class="plan-text">{{ store.novel.outline }}</div>
        </div>
        <div v-if="store.characters?.length" class="plan-block">
          <div class="plan-label">角色（{{ store.characters.length }}）</div>
          <div class="plan-chars">
            <span v-for="c in store.characters" :key="c.id" class="plan-char">
              {{ c.name }}<i>{{ c.role_type }}</i>
            </span>
          </div>
        </div>
        <div v-if="store.chapters?.length" class="plan-block">
          <div class="plan-label">章节规划（{{ store.chapters.length }} 章）</div>
          <div class="plan-chapters">
            <div v-for="c in store.chapters" :key="c.chapter_index" class="plan-chapter">
              <span class="pc-no">第{{ c.chapter_index }}章</span>
              <span class="pc-title">{{ c.title }}</span>
              <span v-if="c.summary" class="pc-sum">{{ c.summary }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="plan-revise">
        <div class="plan-label">对方案有什么修改意见？</div>
        <el-input
          v-model="feedback"
          type="textarea"
          :rows="3"
          placeholder="例如：主角改为女性；第5章节奏太慢，加一场冲突；增加一个反派角色…"
        />
        <el-button
          type="primary"
          plain
          style="margin-top:10px; width:100%"
          :loading="store.busy"
          @click="submitRevise"
        >
          {{ store.busy ? store.busyLabel : '提交意见，让 AI 修订方案' }}
        </el-button>
        <div v-if="revHistory.length" class="plan-history">
          <div v-for="(h, i) in revHistory" :key="i" class="plan-history-item">
            <span class="ph-at">{{ h.at }}</span>
            {{ h.feedback }}
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="closePlanDialog">先放着，稍后再看</el-button>
        <el-button type="primary" @click="confirmPlan">确认方案，开始创作</el-button>
      </template>
    </el-dialog>

    <!-- Phase 7：方案版本 diff 对话框 -->
    <el-dialog
      v-model="diffVisible"
      title="修订方案对比"
      width="780px"
      append-to-body
      class="diff-dialog"
    >
      <div class="diff-summary">
        共有 {{ diffs.filter(d=>d.changed).length }} 处文本变更，
        角色 {{ changedChars.diff ? `新增${changedChars.added.length}/改动${changedChars.removed.length}` : '未变' }}，
        章节 {{ changedChapters.diff ? `新增${changedChapters.added.length}/移除${changedChapters.removed.length}` : '未变' }}
      </div>
      <div class="diff-grid">
        <div
          v-for="d in diffs"
          :key="d.key"
          class="diff-row"
          :class="{ changed: d.changed }"
        >
          <div class="diff-label">{{ d.label }}</div>
          <div v-if="!d.changed" class="diff-unchanged">无变化</div>
          <div v-else class="diff-cols">
            <div class="diff-col old">
              <span v-for="(h, i) in d.hunks" :key="'o'+i" class="diff-line" :class="{ added: h.added, removed: h.removed }">{{ h.value || '（空）' }}</span>
            </div>
            <div class="diff-col new">
              <span v-for="(h, i) in d.hunks" :key="'n'+i" class="diff-line" :class="{ added: h.added, removed: h.removed }">{{ h.value || '（空）' }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-if="changedChars.diff" class="diff-block">
        <div class="diff-label">角色清单</div>
        <div class="char-pills">
          <span v-for="c in changedChars.added" :key="'a'+c.name" class="pill add">+ {{ c.name }}</span>
          <span v-for="c in changedChars.removed" :key="'r'+c.name" class="pill rem">× {{ c.name }}</span>
        </div>
      </div>
      <div v-if="changedChapters.diff" class="diff-block">
        <div class="diff-label">章节清单</div>
        <div class="char-pills">
          <span v-for="c in changedChapters.added" :key="'a'+c.title" class="pill add">+ {{ c.title }}</span>
          <span v-for="c in changedChapters.removed" :key="'r'+c.title" class="pill rem">× {{ c.title }}</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="diffVisible = false">关闭</el-button>
        <el-button type="primary" @click="acceptPending" :disabled="!pending">采纳新方案</el-button>
      </template>
    </el-dialog>

    <!-- Phase 7：历史版本抽屉 -->
    <el-drawer v-model="versionDrawer" title="历史版本与回滚" size="480px" direction="rtl">
      <div v-loading="versionsLoading" class="ver-list">
        <div v-for="v in versions" :key="v.id" class="ver-item" :class="{ 'is-accepted': v.accepted }">
          <div class="ver-head">
            <span class="ver-no">v{{ v.version_no }}</span>
            <el-tag v-if="v.accepted" size="small" type="success">已采纳</el-tag>
            <el-tag v-else size="small" type="warning">候选</el-tag>
            <span class="ver-at">{{ v.created_at }}</span>
          </div>
          <div class="ver-feedback" v-if="v.feedback">意见：{{ v.feedback }}</div>
          <div class="ver-feedback" v-else>初次生成 / 修订</div>
          <div class="ver-actions">
            <el-button size="small" :disabled="!v.accepted" @click="rollbackTo(v)">
              {{ v.accepted ? '回滚到此版本' : '未采纳不可回滚' }}
            </el-button>
          </div>
        </div>
        <el-empty v-if="!versions.length && !versionsLoading" description="暂无历史版本" />
      </div>
    </el-drawer>

    <el-dialog v-model="importOpen" title="导入 TXT 开始改编" width="560px" :close-on-click-modal="false" append-to-body>
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="作品标题">
          <el-input v-model="importTitle" placeholder="输入书名，例如：异界求生录" maxlength="80" show-word-limit />
        </el-form-item>
        <el-form-item label="选择文件">
          <el-upload
            drag
            :auto-upload="false"
            :limit="1"
            accept=".txt,text/plain"
            :on-change="onImportPick"
            :on-exceed="() => undefined"
            :on-remove="onImportRemove"
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">拖拽 TXT 文件到此处，或<em>点击选择</em></div>
            <template #tip>
              <div class="el-upload__tip">支持 UTF-8 / GBK 等常见编码的 .txt 全文小说，单文件 ≤ 5MB。导入后将按「章/回/节」自动拆分章节，作为一本新书。</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="importOpen = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.setup-panel {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px;
}
.setup-title {
  font-weight: 700;
  font-size: 17px;
  margin-bottom: 18px;
  color: #1e1b4b;
}
.setup-form { max-width: 560px; }
.check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 4px 10px;
  width: 100%;
}
.check-item { margin-right: 0; }
.setup-tip {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 2px;
  text-align: center;
}
.import-txt-entry {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px dashed #c7d2fe;
  border-radius: 10px;
  background: #f5f7ff;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.import-txt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
  color: #1e1b4b;
}
.import-txt-desc {
  font-size: 12px;
  color: #6b7280;
  line-height: 1.6;
}
.setup-actions {
  display: flex;
  gap: 8px;
}
.search-empty { padding: 20px; text-align: center; color: #9ca3af; }
.search-result-item {
  padding: 12px;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  margin-bottom: 10px;
}
.search-result-title a { font-weight: 600; color: #4f46e5; text-decoration: none; }
.search-result-title a:hover { text-decoration: underline; }
.search-result-snippet { font-size: 13px; color: #6b7280; margin-top: 4px; }
.search-result-content { font-size: 12px; color: #9ca3af; margin-top: 6px; line-height: 1.7; }
.field-tip {
  margin-top: 6px;
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.6;
}
.field-help {
  color: #c0c4dd;
  cursor: help;
  vertical-align: middle;
  margin-left: 4px;
}
.field-help:hover { color: #6366f1; }
.style-empty-tip { font-size: 11px; color: #9ca3af; margin-top: 6px; line-height: 1.6; }

.plan-overview {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #eef0f6;
  border-radius: 10px;
  padding: 14px 16px;
  background: #fafbff;
}
.plan-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.plan-book { font-weight: 700; font-size: 16px; color: #1e1b4b; }
.plan-block { margin-bottom: 12px; }
.plan-label {
  font-weight: 700;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}
.plan-text {
  font-size: 13px;
  line-height: 1.8;
  color: #374151;
  white-space: pre-wrap;
}
.plan-chars { display: flex; flex-wrap: wrap; gap: 6px; }
.plan-char {
  font-size: 12px;
  color: #4b5563;
  background: #eef2ff;
  border-radius: 999px;
  padding: 2px 10px;
}
.plan-char i { font-style: normal; color: #818cf8; margin-left: 6px; }
.plan-progress {
  margin-top: 12px;
  border: 1px solid #e0e7ff;
  background: #f8faff;
  border-radius: 10px;
  padding: 10px 12px;
}
.plan-progress-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #4f46e5;
}
.plan-progress-stream {
  margin: 8px 0 0;
  max-height: 180px;
  overflow-y: auto;
  font-size: 11.5px;
  line-height: 1.6;
  color: #6b7280;
  background: #fff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.plan-progress-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.plan-progress-bar .el-progress {
  flex: 1;
}
.plan-progress-pct {
  font-size: 13px;
  font-weight: 700;
  color: #4f46e5;
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.plan-chapter {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: #4b5563;
}
.pc-no { flex-shrink: 0; font-weight: 700; color: #6366f1; }
.pc-title { flex-shrink: 0; color: #1f2937; }
.pc-sum { color: #9ca3af; }
.plan-revise { margin-top: 16px; }
.plan-history { margin-top: 10px; }
.plan-history-item {
  font-size: 12px;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  line-height: 1.6;
}
.ph-at { color: #9ca3af; margin-right: 8px; font-size: 11px; }
.length-group { display: flex; gap: 8px; width: 100%; }
.length-radio { margin-right: 0; display: flex; flex: 1; }
.length-radio :deep(.el-radio__label) { padding-left: 6px; }
.length-card { padding: 4px 0; }
.lc-title { font-weight: 700; font-size: 13px; color: #1e1b4b; }
.lc-desc { font-size: 11px; color: #9ca3af; margin-top: 3px; }

.style-target {
  min-height: 60px;
  border: 2px dashed #cbd5e1;
  border-radius: 10px;
  padding: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: flex-start;
  background: #fff;
  transition: all .15s;
  width: 100%;
}
.style-target:dragover,
.style-target[dragover] { background: #eef2ff; border-color: #6366f1; }
.style-target-empty { font-size: 12px; color: #9ca3af; padding: 12px; }
.style-pill {
  font-size: 12px;
  background: #eef2ff;
  color: #4f46e5;
  padding: 3px 10px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.style-pill .x { cursor: pointer; font-style: normal; color: #9ca3af; font-weight: 700; padding: 0 2px; }
.style-pill .x:hover { color: #ef4444; }

.style-source {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 120px;
  overflow-y: auto;
}
.style-tag {
  font-size: 11.5px;
  color: #6b7280;
  background: #f3f4f6;
  padding: 3px 9px;
  border-radius: 999px;
  cursor: grab;
  user-select: none;
  transition: all .1s;
}
.style-tag:hover { background: #e0e7ff; color: #4f46e5; }
.style-tag:active { cursor: grabbing; }

.pending-banner {
  margin-top: 14px;
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 10px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.pending-banner-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #9a3412; }
.pb-title { font-weight: 700; }
.pb-feedback { color: #6b7280; font-size: 12px; }
.pb-actions { display: flex; gap: 6px; }
.history-entry { margin-top: 10px; font-size: 12px; }
.plan-dialog-pending-tip {
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: #9a3412;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.plan-dialog-pending-tip span { flex: 1 1 100%; margin-bottom: 6px; }
.diff-dialog .diff-summary {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 12px;
}
.diff-grid { display: flex; flex-direction: column; gap: 8px; }
.diff-row {
  border: 1px solid #e5e7f0;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fafbff;
}
.diff-row.changed { background: #fffbeb; border-color: #fde68a; }
.diff-row .diff-label {
  font-weight: 700;
  font-size: 12px;
  color: #4b5563;
  margin-bottom: 6px;
}
.diff-unchanged { font-size: 12px; color: #9ca3af; }
.diff-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.diff-col {
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  max-height: 200px;
  overflow-y: auto;
  padding: 4px 8px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid #eef0f6;
}
.diff-line { display: block; }
.diff-line.removed { background: #fee2e2; color: #991b1b; }
.diff-line.added { background: #d1fae5; color: #065f46; }
.diff-col.old .diff-line.removed { background: #fee2e2; }
.diff-col.old .diff-line.added { color: #d1d5db; background: transparent; }
.diff-col.new .diff-line.added { background: #d1fae5; }
.diff-col.new .diff-line.removed { color: #e5d5d5; background: transparent; }
.diff-block {
  border: 1px solid #e5e7f0;
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 10px;
  background: #fafbff;
}
.char-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.pill {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
}
.pill.add { background: #d1fae5; color: #065f46; }
.pill.rem { background: #fee2e2; color: #991b1b; }
.ver-list { padding: 0 8px; }
.ver-item {
  padding: 10px 0;
  border-bottom: 1px solid #eef0f6;
}
.ver-item.is-accepted { background: #f0fdf4; }
.ver-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ver-no { font-weight: 700; color: #1e1b4b; }
.ver-at { color: #9ca3af; font-size: 11.5px; margin-left: auto; }
.ver-feedback { font-size: 12.5px; color: #4b5563; margin-top: 4px; line-height: 1.6; }
.ver-actions { margin-top: 6px; }
</style>
