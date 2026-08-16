<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import api from '../api';

const store = useEditorStore();

const TEMPLATES = [
  { key: 'shuangwen', label: '改成爽文', value: '节奏更爽快，主角更强，打脸、逆袭、升级的情节更密集，爽点前置，每章都有明确的高潮与情绪释放' },
  { key: 'gender', label: '主角换性别', value: '将主角性别互换，并同步调整其身份背景、人际称谓与社会处境，保留原有剧情主线与角色关系结构' },
  { key: 'tragedy', label: '改为悲剧结局', value: '将整体走向改为悲剧基调，逐步铺垫宿命感、牺牲与遗憾，结局令人唏嘘，但逻辑自洽' },
  { key: 'faster', label: '节奏加快', value: '整体节奏加快：压缩铺垫与日常，减少废话与重复描写，事件推进更紧凑，章均有效剧情密度提高' },
  { key: 'new-world', label: '世界观更换', value: '保留角色与主线骨架，将世界观整体更换为另一套设定（如修真→科幻末世），所有细节随之重建' }
];

const intentText = ref('');
const activeTemplate = ref('');

// 多本融合
const mergeMode = ref(false);
const mergeFiles = ref([]);
const mergeFileContents = ref([]);
const mergeAnalyzing = ref(false);
const mergeAnalysis = ref(null);
const mergeDialog = ref(false);
const mergeUploadRef = ref(null);

const songMode = ref(false);
const songTitle = ref('');
const songArtist = ref('');
const songLyrics = ref('');
const songStyle = ref('');

const job = computed(() => store.adaptJob);
const plan = computed(() => job.value?.plan || null);
const plans = computed(() => {
  const raw = job.value?.plans;
  if (Array.isArray(raw) && raw.length) return raw;
  if (plan.value?.plans && Array.isArray(plan.value.plans) && plan.value.plans.length) return plan.value.plans;
  return [];
});
const selectedPlanId = ref('');
const planChapters = computed(() => (plan.value?.chapters || []).sort((a, b) => a.chapter_index - b.chapter_index));

const activePlan = computed(() => {
  const list = plans.value;
  if (!list.length) return plan.value;
  return list.find((p) => p.plan_id === selectedPlanId.value) || list[0];
});
const activePlanChapters = computed(() => (activePlan.value?.chapters || []).sort((a, b) => a.chapter_index - b.chapter_index));

const candidates = computed(() => store.adaptCandidates || []);
const acceptedCount = computed(() => candidates.value.filter((c) => c.status === 'accepted').length);
const skippedCount = computed(() => candidates.value.filter((c) => c.status === 'skipped').length);
const pendingCount = computed(() => candidates.value.filter((c) => c.status === 'pending').length);

const planGenProgress = computed(() => store.genProgress);

const dialogVisible = computed({
  get: () => store.adaptDialog,
  set: (v) => { if (!v) store.closeAdaptDialog(); }
});

const canStart = computed(() => !!intentText.value.trim() || !!activeTemplate.value);
const adapting = computed(() => !!job.value && job.value.status === 'adapting');
const planReady = computed(() => !!job.value && job.value.status === 'plan_ready');
const done = computed(() => !!job.value && job.value.status === 'done');

const totalChapters = computed(() => {
  if (plan.value?.chapters?.length) return plan.value.chapters.length;
  return store.chapters.filter((c) => c.word_count).length || 0;
});

const progressPct = computed(() => {
  if (!totalChapters.value) return 0;
  const processed = acceptedCount.value + skippedCount.value;
  return Math.round((processed / totalChapters.value) * 100);
});

function applyTemplate(t) {
  activeTemplate.value = t.key;
  intentText.value = t.value;
}

function onMergeFileChange(uploadFile) {
  const raw = uploadFile.raw;
  if (!raw) return;
  if (!/\.(txt|md|text)$/i.test(raw.name) && raw.type !== 'text/plain') {
    ElMessage.warning('请选择 .txt 或纯文本文件');
    return;
  }
  if (raw.size > 200 * 1024 * 1024) {
    ElMessage.warning(`「${raw.name}」超过 200MB，请拆分后导入`);
    return;
  }
  const already = mergeFiles.value.find((f) => f.name === raw.name);
  if (already) { ElMessage.warning('已添加该文件'); return; }
  mergeAnalysis.value = null; // 文件变化时清除旧分析结果
  mergeFiles.value.push({ name: raw.name, file: raw });
  const reader = new FileReader();
  reader.onload = () => {
    mergeFileContents.value.push({ name: raw.name, content: String(reader.result || '') });
    ElMessage.success(`「${raw.name}」已加入待融合列表`);
  };
  reader.readAsText(raw, 'utf-8');
  // 清空 upload 内部 fileList，允许继续追加选择多本
  mergeUploadRef.value?.clearFiles();
}

function removeMergeFile(idx) {
  const name = mergeFiles.value[idx]?.name;
  mergeFiles.value.splice(idx, 1);
  const contentIdx = mergeFileContents.value.findIndex((f) => f.name === name);
  if (contentIdx !== -1) mergeFileContents.value.splice(contentIdx, 1);
  if (mergeFileContents.value.length < 2) mergeAnalysis.value = null;
}

async function analyzeMerge() {
  if (mergeFileContents.value.length < 2) { ElMessage.warning('请至少导入 2 本小说'); return; }
  if (mergeFileContents.value.length !== mergeFiles.value.length) {
    ElMessage.warning('部分文件尚未加载完成，请稍后再试');
    return;
  }
  mergeAnalyzing.value = true;
  try {
    const data = await api.analyzeMergeNovels(store.novelId, mergeFileContents.value.map((f) => ({ title: f.name, content: f.content.slice(0, 50000) })));
    mergeAnalysis.value = data.analysis;
    ElMessage.success('分析完成，请选择融合方式');
  } catch (e) {
    ElMessage.error(e.message || '分析失败');
  } finally {
    mergeAnalyzing.value = false;
  }
}

async function startMergeAdaptation() {
  if (!mergeAnalysis.value) return;
  intentText.value = `融合改编：${mergeAnalysis.value || ''}`;
  activeTemplate.value = '';
}

async function generatePlan() {
  if (!canStart.value) {
    ElMessage.warning('请描述改编意图或选择模板');
    return;
  }
  try {
    store.genProgress = 0;
    await store.startAdaptation(intentText.value.trim());
  } catch (e) {
    ElMessage.error(e.message || '生成改编方案失败');
  }
}

async function generateSongPlan() {
  if (!songLyrics.value.trim()) {
    ElMessage.warning('请填写歌词内容');
    return;
  }
  try {
    store.genProgress = 0;
    store.adaptBusy = true;
    store.adaptPlanStream = '';
    store.adaptDialog = true;
    const originId = store.novelId;
    const p = api.adaptationFromSong(store.novelId, {
      songTitle: songTitle.value.trim(),
      artist: songArtist.value.trim(),
      lyrics: songLyrics.value.trim(),
      style: songStyle.value.trim()
    }, {
      onStatus: () => {},
      onProgress: (pct, msg) => {
        const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
        store._commit(originId, { genProgress: v, busyLabel: msg || '正在生成改编方案…' });
      },
      onDelta: (d) => {
        const cur = String(store.novelId) === String(originId) ? (store.$state.adaptPlanStream || '') : ((store._slices.get(String(originId)) || {}).adaptPlanStream || '');
        store._commit(originId, { adaptPlanStream: cur + d });
      },
      onError: (m) => { throw new Error(m); }
    });
    store._genAbort = p.abort;
    const data = await p;
    const plans = Array.isArray(data.plans) ? data.plans : [];
    store._commit(originId, {
      adaptJob: {
        ...(store.adaptJob || {}),
        id: data.jobId, status: 'plan_ready', plan: data.plan,
        plans
      },
      adaptBusy: false, adaptPlanStream: '', _genAbort: null
    });
  } catch (e) {
    ElMessage.error(e.message || '生成歌词改编方案失败');
    store.adaptBusy = false;
    store.adaptPlanStream = '';
  }
}

async function selectPlan(p) {
  selectedPlanId.value = p.plan_id;
  try {
    await store.selectAdaptationPlan(p.plan_id);
  } catch (e) {
    ElMessage.error(e.message || '选择方案失败');
  }
}

async function confirmStart() {
  try {
    await store.beginAdaptation();
    await nextCandidate();
  } catch (e) {
    ElMessage.error(e.message || '开始改编失败');
  }
}

async function nextCandidate() {
  if (store.adaptBusy) return;
  try {
    await store.adaptationNext();
  } catch (e) {
    ElMessage.error(e.message || '生成候选失败');
  }
}

async function acceptCurrent(c) {
  try {
    await store.acceptCandidate(c.id);
    ElMessage.success('已采纳，写入正式章节');
    if (hasMorePending()) await nextCandidate();
  } catch (e) {
    ElMessage.error(e.message || '采纳失败');
  }
}

async function skipCurrent(c) {
  try {
    await store.skipCandidate(c.id);
    ElMessage.info('已跳过，保留原文');
    if (hasMorePending()) await nextCandidate();
  } catch (e) {
    ElMessage.error(e.message || '跳过失败');
  }
}

function hasMorePending() {
  return (store.adaptCandidates || []).some((x) => x.status === 'pending');
}

async function retryCurrent(c) {
  try {
    await store.retryCandidate(c.id);
    ElMessage.success('已重新生成该章候选');
  } catch (e) {
    ElMessage.error(e.message || '重试失败');
  }
}

async function acceptAll() {
  try {
    await store.batchAdaptation('accepted');
    ElMessage.success('已采纳全部待处理候选');
  } catch (e) {
    ElMessage.error(e.message || '批量采纳失败');
  }
}

async function skipAll() {
  try {
    await store.batchAdaptation('skipped');
    ElMessage.info('已跳过全部待处理候选');
  } catch (e) {
    ElMessage.error(e.message || '批量跳过失败');
  }
}

function setActiveCandidate(idx) {
  const c = candidates.value.find((x) => x.chapter_index === idx);
  if (c) store.adaptCompare = c;
}

onMounted(() => {
  if (store.novelId) store.loadAdaptation();
});
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="整本改编"
    width="860px"
    :close-on-click-modal="false"
    append-to-body
    class="adapt-dialog"
    top="4vh"
  >
    <!-- 第一步：多本融合 / 填写改编意图 -->
    <div v-if="!job" class="adapt-intent">
      <div class="adapt-mode-bar">
        <el-radio-group v-model="mergeMode" size="small" @change="songMode = false">
          <el-radio-button :value="false">单本改编</el-radio-button>
          <el-radio-button :value="true">多本融合</el-radio-button>
        </el-radio-group>
        <el-button size="small" :type="songMode ? 'primary' : 'default'" @click="songMode = !songMode; if(songMode)mergeMode=false" style="margin-left:8px">歌词改编</el-button>
      </div>

      <!-- 多本融合模式 -->
      <div v-if="mergeMode" class="adapt-merge">
        <div class="field-tip" style="margin:4px 0 12px">导入 2 本以上小说（每本 ≤ 200MB），AI 将分析各本特点并给出融合改编建议，你可以选择融合方向后生成改编方案。每导入一本都会在下方列出，确认无误后再进行分析。</div>
        <el-upload
          ref="mergeUploadRef"
          drag
          :auto-upload="false"
          :show-file-list="false"
          :limit="10"
          accept=".txt,.md,.text,text/plain"
          :on-change="onMergeFileChange"
        >
          <div class="upload-tip">
            <el-icon :size="34" color="#9ca3af"><UploadFilled /></el-icon>
            <div class="upload-text">点击选择多本 .txt 小说（支持同时导入多本，AI 分析后给出融合建议）</div>
          </div>
        </el-upload>
        <div v-for="(f, i) in mergeFiles" :key="i" class="merge-file-item">
          <span class="merge-file-name">{{ f.name }}</span>
          <span class="merge-file-status">{{ mergeFileContents.find((c) => c.name === f.name)?.content ? '已加载' : '加载中…' }}</span>
          <el-button size="small" type="danger" plain @click="removeMergeFile(i)">移除</el-button>
        </div>
        <div v-if="mergeFileContents.length" class="merge-file-actions">
          <el-button size="small" plain @click="mergeFiles = []; mergeFileContents = []; mergeAnalysis = null">清除所有</el-button>
        </div>
        <div v-if="mergeFileContents.length >= 2" class="adapt-actions" style="margin-top:12px">
          <el-button type="primary" :loading="mergeAnalyzing" @click="analyzeMerge">{{ mergeAnalysis ? '重新分析' : '分析并推荐融合方向' }}</el-button>
        </div>
        <div v-if="mergeAnalysis" class="merge-analysis-result">
          <div class="merge-analysis-title">融合分析结果</div>
          <div class="merge-analysis-books">
            <div v-for="b in (mergeAnalysis.books || [])" :key="b.title" class="merge-book-item">
              <strong>{{ b.title }}：</strong>{{ b.features }}
            </div>
          </div>
          <div class="merge-suggestions">
            <div class="merge-suggestions-title">推荐融合方向：</div>
            <div v-for="(s, i) in (mergeAnalysis.merge_suggestions || [])" :key="i" class="merge-suggestion-item">
              <el-radio v-model="intentText" :value="s" @change="activeTemplate=''">{{ s }}</el-radio>
            </div>
          </div>
          <div class="adapt-actions">
            <el-button type="primary" :loading="store.adaptBusy" :disabled="!intentText.trim()" @click="generatePlan">按此方向生成改编方案</el-button>
          </div>
        </div>
      </div>

      <!-- 歌词改编模式 -->
      <div v-if="songMode" class="adapt-song">
        <div class="field-tip">填入歌曲信息和歌词，AI 将分析歌词情感与意象，输出小说改编方案。</div>
        <div class="adapt-song-row">
          <el-input v-model="songTitle" placeholder="歌名（选填）" style="flex:1" size="small" />
          <el-input v-model="songArtist" placeholder="歌手（选填）" style="flex:1;margin-left:8px" size="small" />
        </div>
        <el-input
          v-model="songLyrics"
          type="textarea"
          :rows="6"
          placeholder="粘贴歌词全文…"
          style="margin-top:8px"
        />
        <el-input
          v-model="songStyle"
          placeholder="风格偏好（选填），例如：仙侠、都市、悬疑、言情…"
          style="margin-top:8px"
          size="small"
        />
        <div class="adapt-actions">
          <el-button type="primary" :loading="store.adaptBusy" :disabled="!songLyrics.trim()" @click="generateSongPlan">
            生成歌词改编方案
          </el-button>
        </div>
      </div>

      <!-- 单本改编模式 -->
      <template v-if="!mergeMode && !songMode">
      <el-input
        v-model="intentText"
        type="textarea"
        :rows="3"
        placeholder="描述你想怎么改这本书，例如：把节奏加快、主角更腹黑、结局改成大团圆……也可以直接选择下方模板"
      />
      <div class="adapt-templates">
        <el-tag
          v-for="t in TEMPLATES"
          :key="t.key"
          class="adapt-template-tag"
          :class="{ active: activeTemplate === t.key }"
          effect="plain"
          @click="applyTemplate(t)"
        >{{ t.label }}</el-tag>
      </div>
      </template>
      <template v-if="!mergeMode && !songMode">
      <div class="adapt-count">本书共 {{ totalChapters }} 章，将逐章生成改写候选，确认后再写回正式章节。</div>
      <div class="adapt-actions">
        <el-button type="primary" :loading="store.adaptBusy" :disabled="!canStart" @click="generatePlan">
          生成改编方案
        </el-button>
      </div>
      </template>
    </div>

    <!-- 第二步：展示改编方案（多方案选择），等待确认 -->
    <div v-else-if="planReady" class="adapt-plan">
      <div v-if="store.adaptBusy" class="adapt-plan-progress">
        <el-progress :percentage="planGenProgress" :stroke-width="8" striped striped-flow :duration="15" />
        <div class="adapt-plan-progress-meta">{{ store.busyLabel || '正在生成改编方案…' }}</div>
      </div>
      <div v-if="store.adaptPlanStream" class="adapt-plan-stream">{{ store.adaptPlanStream }}</div>
      <template v-else-if="!store.adaptBusy">
        <div class="adapt-plan-head">
          <el-tag type="success">方案已生成</el-tag>
          <span class="adapt-plan-notes">生成了 {{ plans.length || 1 }} 个改编方案供选择，选一个后逐章改编</span>
        </div>

        <!-- 多方案选择卡片 -->
        <div v-if="plans.length" class="adapt-plans-grid">
          <div
            v-for="p in plans"
            :key="p.plan_id"
            class="adapt-plan-card"
            :class="{ active: selectedPlanId === p.plan_id }"
            @click="selectPlan(p)"
          >
            <div class="adapt-plan-card-head">
              <el-tag :type="p.plan_id === 'minimal' ? 'info' : (p.plan_id === 'bold' ? 'warning' : 'danger')" effect="plain" size="small">{{ p.plan_name }}</el-tag>
              <el-icon v-if="selectedPlanId === p.plan_id" class="adapt-plan-picked"><CircleCheckFilled /></el-icon>
            </div>
            <div class="adapt-plan-card-intent">{{ p.intent_summary }}</div>
            <div class="adapt-plan-card-approach">{{ p.approach }}</div>
            <div class="adapt-plan-card-status">
              <span>共 {{ (p.chapters || []).length }} 章改造要点</span>
              <el-button v-if="selectedPlanId !== p.plan_id" size="small" type="primary" plain @click.stop="selectPlan(p)">选择此方案</el-button>
            </div>
          </div>
        </div>

        <!-- 选中方案章节要点预览 -->
        <div v-if="activePlan" class="adapt-plan-preview">
          <div class="adapt-plan-preview-head">
            <span class="adapt-plan-preview-title">{{ activePlan.plan_name || '改编方案' }}</span>
            <span class="adapt-plan-preview-notes">{{ activePlan.global_notes || '全书统一调整要点已列出，确认后逐章改编。' }}</span>
          </div>
          <div class="adapt-plan-list">
            <div v-for="c in (selectedPlanId || !plans.length ? activePlanChapters : [])" :key="c.chapter_index" class="adapt-plan-item">
              <div class="adapt-plan-item-head">
                <span class="adapt-plan-idx">第 {{ c.chapter_index }} 章</span>
                <span class="adapt-plan-title">{{ c.title }}</span>
              </div>
              <ul v-if="c.actions?.length" class="adapt-plan-actions">
                <li v-for="(a, i) in c.actions" :key="i">{{ a }}</li>
              </ul>
            </div>
          </div>
        </div>

        <div class="adapt-actions">
          <el-button @click="store.adaptDialog = false">先不改编</el-button>
          <el-button type="primary" :loading="store.adaptBusy" @click="confirmStart">确认方案，开始逐章改编</el-button>
        </div>
      </template>
    </div>

    <!-- 第三步：逐章改编中 -->
    <div v-else-if="adapting || done" class="adapt-run">
      <div class="adapt-progress">
        <el-progress :percentage="progressPct" :stroke-width="10" striped striped-flow :duration="20" />
        <div class="adapt-progress-meta">
          <span>已采纳 {{ acceptedCount }} · 已跳过 {{ skippedCount }} · 剩余 {{ Math.max(0, totalChapters - acceptedCount - skippedCount) }}</span>
          <span v-if="store.adaptBusy" class="adapt-running"><el-icon class="is-loading"><Loading /></el-icon>正在生成第 {{ store.genProgress }} 章候选…</span>
        </div>
      </div>

      <div v-if="pendingCount && !store.adaptBusy" class="adapt-batch-bar">
        <span class="adapt-batch-hint">还有 {{ pendingCount }} 章待处理候选，可快速批量操作：</span>
        <el-button size="small" type="success" plain @click="acceptAll">全部采纳</el-button>
        <el-button size="small" plain @click="skipAll">全部跳过</el-button>
      </div>

      <!-- 候选列表 -->
      <div class="adapt-cand-list">
        <el-tag
          v-for="c in candidates"
          :key="c.id"
          class="adapt-cand-tag"
          :type="c.status === 'accepted' ? 'success' : (c.status === 'skipped' ? 'info' : 'warning')"
          effect="plain"
          @click="setActiveCandidate(c.chapter_index)"
        >
          第 {{ c.chapter_index }} 章 · {{ c.status === 'accepted' ? '已采纳' : (c.status === 'skipped' ? '已跳过' : '待处理') }}
        </el-tag>
      </div>

      <!-- 当前候选对比视图 -->
      <div v-if="store.adaptCompare" class="adapt-compare">
        <div class="adapt-compare-head">
          <span class="adapt-compare-title">第 {{ store.adaptCompare.chapter_index }} 章：{{ store.adaptCompare.candidate_title }}</span>
          <span v-if="store.adaptCompare.status === 'accepted'" class="adapt-cand-status ok">已采纳</span>
          <span v-else-if="store.adaptCompare.status === 'skipped'" class="adapt-cand-status skip">已跳过</span>
          <span v-else class="adapt-cand-status pending">待处理</span>
        </div>
        <div class="adapt-compare-cols">
          <div class="adapt-col">
            <div class="adapt-col-label">原文</div>
            <div class="adapt-col-body original">{{ store.adaptCompare.original_content }}</div>
          </div>
          <div class="adapt-col">
            <div class="adapt-col-label">改编后</div>
            <div class="adapt-col-body candidate">{{ store.adaptCompare.candidate_content }}</div>
          </div>
        </div>
        <div v-if="store.adaptCompare.status === 'pending'" class="adapt-compare-actions">
          <el-button type="success" @click="acceptCurrent(store.adaptCompare)">采纳并下一章</el-button>
          <el-button @click="skipCurrent(store.adaptCompare)">跳过并下一章</el-button>
          <el-button type="warning" plain @click="retryCurrent(store.adaptCompare)">重试</el-button>
          <el-button v-if="pendingCount > 1" type="primary" plain @click="nextCandidate">仅换下一章</el-button>
        </div>
        <div v-else class="adapt-compare-actions">
          <el-button v-if="!store.adaptBusy" type="primary" @click="nextCandidate">生/看下一章</el-button>
        </div>
      </div>
      <div v-else class="adapt-compare-empty">
        <el-button v-if="!store.adaptBusy && !done" type="primary" @click="nextCandidate">生成第 {{ store.adaptCandidates.length + 1 }} 章候选</el-button>
        <el-result v-if="done" icon="success" title="整本改编完成" sub-title="所有章节已处理完毕，采纳的章节已写回正式内容" />
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.adapt-intent { padding: 4px 2px; }
.adapt-mode-bar { margin-bottom: 12px; }
.adapt-merge { padding: 8px 0; }
.merge-file-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border: 1px solid #eef0f6; border-radius: 6px; margin-top: 8px; }
.merge-file-name { font-size: 13px; color: #374151; }
.merge-file-status { font-size: 11px; color: #9ca3af; margin-left: 8px; }
.merge-file-actions { margin-top: 8px; display: flex; gap: 8px; }
.merge-analysis-result { margin-top: 16px; border: 1px solid #d1fae5; border-radius: 10px; padding: 14px; background: #f0fdf4; }
.merge-analysis-title { font-weight: 600; font-size: 14px; color: #065f46; margin-bottom: 10px; }
.merge-analysis-books { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.merge-book-item { font-size: 13px; color: #374151; line-height: 1.6; }
.merge-suggestions-title { font-weight: 600; font-size: 13px; color: #065f46; margin-bottom: 8px; }
.merge-suggestion-item { margin: 6px 0; }
.merge-suggestion-item .el-radio { display: flex; align-items: flex-start; font-size: 13px; line-height: 1.6; white-space: normal; }
.adapt-templates { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.adapt-template-tag { cursor: pointer; }
.adapt-template-tag.active { background: #4f46e5; color: #fff; border-color: #4f46e5; }
.adapt-count { margin-top: 10px; color: #6b7280; font-size: 13px; }
.adapt-actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }

.adapt-song { padding: 8px 0; }
.adapt-song-row { display: flex; gap: 0; }
.adapt-plan-progress { margin-bottom: 10px; }
.adapt-plan-progress-meta { margin-top: 4px; font-size: 12px; color: #6b7280; text-align: center; }

.adapt-plan-stream {
  max-height: 420px; overflow: auto; white-space: pre-wrap; background: #0f172a; color: #e2e8f0;
  border-radius: 8px; padding: 14px; font-size: 13px; font-family: monospace;
}
.adapt-plan-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.adapt-plan-notes { color: #6b7280; font-size: 13px; }
.adapt-plans-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
.adapt-plan-card {
  border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; cursor: pointer;
  transition: all .15s; background: #fff; display: flex; flex-direction: column; gap: 6px;
}
.adapt-plan-card:hover { border-color: #a5b4fc; box-shadow: 0 2px 8px rgba(79,70,229,.08); }
.adapt-plan-card.active { border-color: #4f46e5; box-shadow: 0 0 0 1px #4f46e5 inset, 0 2px 10px rgba(79,70,229,.12); }
.adapt-plan-card-head { display: flex; align-items: center; justify-content: space-between; }
.adapt-plan-picked { color: #4f46e5; font-size: 16px; }
.adapt-plan-card-intent { font-size: 13px; font-weight: 600; color: #111827; line-height: 1.5; }
.adapt-plan-card-approach { font-size: 12px; color: #6b7280; line-height: 1.6; flex: 1; }
.adapt-plan-card-status { display: flex; align-items: center; justify-content: space-between; color: #9ca3af; font-size: 12px; }
.adapt-plan-preview { border: 1px solid #eef0f6; border-radius: 10px; padding: 12px; }
.adapt-plan-preview-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.adapt-plan-preview-title { font-weight: 600; font-size: 14px; color: #4f46e5; }
.adapt-plan-preview-notes { color: #6b7280; font-size: 13px; flex: 1; }
.adapt-plan-list { max-height: 380px; overflow: auto; border: 1px solid #eef0f6; border-radius: 8px; }
.adapt-plan-item { padding: 12px 14px; border-bottom: 1px solid #f1f3f9; }
.adapt-plan-item:last-child { border-bottom: none; }
.adapt-plan-item-head { display: flex; gap: 8px; align-items: baseline; }
.adapt-plan-idx { color: #4f46e5; font-weight: 600; font-size: 13px; white-space: nowrap; }
.adapt-plan-title { font-weight: 600; font-size: 14px; }
.adapt-plan-actions { margin: 8px 0 0; padding-left: 18px; color: #4b5563; font-size: 13px; }
.adapt-plan-actions li { margin: 3px 0; }

.adapt-progress { margin-bottom: 12px; }
.adapt-progress-meta { display: flex; justify-content: space-between; margin-top: 6px; color: #6b7280; font-size: 13px; }
.adapt-running { display: inline-flex; align-items: center; gap: 4px; color: #4f46e5; }
.adapt-batch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.adapt-batch-hint { font-size: 12px; color: #4f46e5; }
.adapt-cand-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.adapt-cand-tag { cursor: pointer; }

.adapt-compare { border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
.adapt-compare-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #f8fafc; border-bottom: 1px solid #e5e7eb; }
.adapt-compare-title { font-weight: 600; font-size: 14px; }
.adapt-cand-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.adapt-cand-status.ok { background: #dcfce7; color: #16a34a; }
.adapt-cand-status.skip { background: #f3f4f6; color: #6b7280; }
.adapt-cand-status.pending { background: #fef3c7; color: #b45309; }
.adapt-compare-cols { display: grid; grid-template-columns: 1fr 1fr; }
.adapt-col { min-width: 0; }
.adapt-col-label { padding: 6px 14px; background: #f1f5f9; color: #475569; font-size: 12px; border-bottom: 1px solid #e2e8f0; }
.adapt-col-body { max-height: 340px; overflow: auto; padding: 12px 14px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.adapt-col-body.original { background: #fff7f7; }
.adapt-col-body.candidate { background: #f7fff7; }
.adapt-compare-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 14px; background: #f8fafc; border-top: 1px solid #e5e7eb; }
.adapt-compare-empty { padding: 20px 0; text-align: center; }
</style>
