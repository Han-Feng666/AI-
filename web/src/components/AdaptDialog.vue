<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';

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

const job = computed(() => store.adaptJob);
const plan = computed(() => job.value?.plan || null);
const planChapters = computed(() => (plan.value?.chapters || []).sort((a, b) => a.chapter_index - b.chapter_index));

const candidates = computed(() => store.adaptCandidates || []);
const acceptedCount = computed(() => candidates.value.filter((c) => c.status === 'accepted').length);
const skippedCount = computed(() => candidates.value.filter((c) => c.status === 'skipped').length);

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

async function generatePlan() {
  if (!canStart.value) {
    ElMessage.warning('请描述改编意图或选择模板');
    return;
  }
  try {
    await store.startAdaptation(intentText.value.trim());
  } catch (e) {
    ElMessage.error(e.message || '生成改编方案失败');
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
  } catch (e) {
    ElMessage.error(e.message || '采纳失败');
  }
}

async function skipCurrent(c) {
  try {
    await store.skipCandidate(c.id);
    ElMessage.info('已跳过，保留原文');
  } catch (e) {
    ElMessage.error(e.message || '跳过失败');
  }
}

async function retryCurrent(c) {
  try {
    await store.retryCandidate(c.id);
  } catch (e) {
    ElMessage.error(e.message || '重试失败');
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
    <!-- 第一步：填写改编意图 -->
    <div v-if="!job" class="adapt-intent">
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
      <div class="adapt-count">本书共 {{ totalChapters }} 章，将逐章生成改写候选，确认后再写回正式章节。</div>
      <div class="adapt-actions">
        <el-button type="primary" :loading="store.adaptBusy" :disabled="!canStart" @click="generatePlan">
          生成改编方案
        </el-button>
      </div>
    </div>

    <!-- 第二步：展示改编方案，等待确认 -->
    <div v-else-if="planReady" class="adapt-plan">
      <div v-if="store.adaptPlanStream" class="adapt-plan-stream">{{ store.adaptPlanStream }}</div>
      <template v-else>
        <div class="adapt-plan-head">
          <el-tag type="success">方案已生成</el-tag>
          <span class="adapt-plan-notes">{{ plan.global_notes || '全书统一调整要点已列出，确认后逐章改编。' }}</span>
        </div>
        <div class="adapt-plan-list">
          <div v-for="c in planChapters" :key="c.chapter_index" class="adapt-plan-item">
            <div class="adapt-plan-item-head">
              <span class="adapt-plan-idx">第 {{ c.chapter_index }} 章</span>
              <span class="adapt-plan-title">{{ c.title }}</span>
            </div>
            <ul v-if="c.actions?.length" class="adapt-plan-actions">
              <li v-for="(a, i) in c.actions" :key="i">{{ a }}</li>
            </ul>
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
          <span>已采纳 {{ acceptedCount }} · 已跳过 {{ skippedCount }}</span>
          <span v-if="store.adaptBusy" class="adapt-running"><el-icon class="is-loading"><Loading /></el-icon>正在生成第 {{ store.genProgress }} 章候选…</span>
        </div>
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
          <el-button type="success" @click="acceptCurrent(store.adaptCompare)">采纳</el-button>
          <el-button @click="skipCurrent(store.adaptCompare)">跳过</el-button>
          <el-button type="warning" plain @click="retryCurrent(store.adaptCompare)">重试</el-button>
          <el-button type="primary" @click="nextCandidate">处理下一章</el-button>
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
.adapt-templates { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.adapt-template-tag { cursor: pointer; }
.adapt-template-tag.active { background: #4f46e5; color: #fff; border-color: #4f46e5; }
.adapt-count { margin-top: 10px; color: #6b7280; font-size: 13px; }
.adapt-actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }

.adapt-plan-stream {
  max-height: 420px; overflow: auto; white-space: pre-wrap; background: #0f172a; color: #e2e8f0;
  border-radius: 8px; padding: 14px; font-size: 13px; font-family: monospace;
}
.adapt-plan-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.adapt-plan-notes { color: #6b7280; font-size: 13px; }
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
