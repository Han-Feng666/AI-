<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, RefreshRight, VideoPause, Loading } from '@element-plus/icons-vue';
import api from '../api';
import { GENRES, formatNumber } from '../utils/format';

const props = defineProps({
  modelValue: Boolean,
  defaultTarget: { type: String, default: 'style' }
});
const emit = defineEmits(['update:modelValue', 'refresh']);

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
});

const step = ref(0); // 0 粘贴 | 1 预览
const target = ref(props.defaultTarget);
const genre = ref('');
const inputsText = ref('');
const parsing = ref(false);
const parsedItems = ref([]); // { bookId, title, author, wordCount, chapterCount, freeCount, error, _removed }
const jobs = ref([]);
let pollTimer = null;
let hadActive = false;

const validItems = computed(() => parsedItems.value.filter((it) => !it._removed && !it.error));
const activeJobs = computed(() => jobs.value.filter((j) => ['pending', 'fetching', 'analyzing'].includes(j.status)));

watch(() => props.modelValue, (open) => {
  if (open) {
    target.value = props.defaultTarget;
    step.value = 0;
    parsedItems.value = [];
    loadJobs();
    startPolling();
  } else {
    stopPolling();
  }
});
onUnmounted(stopPolling);

function startPolling() {
  stopPolling();
  pollTimer = setInterval(loadJobs, 3000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadJobs() {
  try {
    const data = await api.getFanqieJobs();
    const prev = jobs.value;
    jobs.value = data.jobs || [];
    const nowActive = jobs.value.some((j) => ['pending', 'fetching', 'analyzing'].includes(j.status));
    if (hadActive && !nowActive && prev.length) {
      // 批次结束：通知父页面刷新列表
      emit('refresh');
    }
    hadActive = nowActive;
  } catch { /* 轮询失败静默 */ }
}

async function doParse() {
  if (!inputsText.value.trim()) return ElMessage.warning('请粘贴番茄小说的书籍链接或 ID');
  parsing.value = true;
  try {
    const data = await api.parseFanqieInputs(inputsText.value);
    parsedItems.value = (data.items || []).map((it) => ({ ...it, _removed: false }));
    if (!parsedItems.value.length) {
      ElMessage.warning(data.hint || '未识别到书籍链接或 ID');
      return;
    }
    step.value = 1;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    parsing.value = false;
  }
}

function removeItem(idx) {
  parsedItems.value.splice(idx, 1);
  if (!validItems.value.length && !parsedItems.value.length) step.value = 0;
}

async function doEnqueue() {
  if (!validItems.value.length) return ElMessage.warning('没有可导入的书籍');
  if (target.value === 'knowledge' && !genre.value) return ElMessage.warning('请选择知识库题材');
  try {
    const data = await api.createFanqieBatch(
      validItems.value.map((it) => ({ bookId: it.bookId })),
      target.value,
      target.value === 'knowledge' ? genre.value : ''
    );
    const dup = (data.jobs || []).filter((j) => j.duplicated);
    if (dup.length) ElMessage.info(`${dup.length} 本已存在（${dup[0].reason}），已跳过`);
    ElMessage.success(`已加入队列 ${(data.jobs || []).length - dup.length} 本`);
    parsedItems.value = [];
    inputsText.value = '';
    step.value = 0;
    await loadJobs();
    startPolling();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function retryJob(job) {
  try {
    const r = await api.retryFanqieJob(job.id);
    if (r.error) return ElMessage.error(r.error);
    loadJobs();
  } catch (e) { ElMessage.error(e.message); }
}

async function removeJob(job) {
  try {
    await ElMessageBox.confirm(`删除「${job.title || job.book_id}」的导入记录？`, '删除记录', { type: 'warning' });
  } catch { return; }
  try {
    const r = await api.deleteFanqieJob(job.id);
    if (r.error) return ElMessage.error(r.error);
    loadJobs();
  } catch (e) { ElMessage.error(e.message); }
}

async function cancelAll() {
  try {
    await ElMessageBox.confirm('取消当前与队列中的全部导入任务？', '取消导入', { type: 'warning' });
  } catch { return; }
  try {
    await api.cancelFanqieJobs();
    loadJobs();
    ElMessage.success('已取消');
  } catch (e) { ElMessage.error(e.message); }
}

const STATUS_META = {
  pending: { label: '排队中', type: 'info' },
  fetching: { label: '抓取中', type: 'primary' },
  analyzing: { label: '分析中', type: 'warning' },
  done: { label: '完成', type: 'success' },
  failed: { label: '失败', type: 'danger' },
  cancelled: { label: '已取消', type: 'info' }
};
function statusMeta(s) { return STATUS_META[s] || { label: s, type: 'info' }; }
function jobProgress(j) {
  if (j.status === 'done') return 100;
  return j.progress || 0;
}
function jobRefLabel(j) {
  if (!j.result_ref) return '';
  const [kind, id] = j.result_ref.split(':');
  return kind === 'style' ? `已入库为风格 #${id}` : `已入库为知识库 #${id}`;
}
</script>

<template>
  <el-dialog v-model="show" title="从番茄小说批量导入" width="720px" :close-on-click-modal="false">
    <template v-if="step === 0">
      <el-form label-width="90px">
        <el-form-item label="导入目标">
          <el-radio-group v-model="target">
            <el-radio-button value="style">风格库</el-radio-button>
            <el-radio-button value="knowledge">知识库</el-radio-button>
          </el-radio-group>
          <el-select v-if="target === 'knowledge'" v-model="genre" placeholder="选择题材" filterable style="width: 160px; margin-left: 12px">
            <el-option v-for="g in GENRES" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="书籍链接">
          <el-input
            v-model="inputsText"
            type="textarea"
            :rows="6"
            placeholder="每行一条，支持以下格式：&#10;https://fanqienovel.com/page/7143038691944959774&#10;https://fanqienovel.com/reader/7143038691944959774_xxxxxx&#10;7143038691944959774（纯数字书籍 ID）"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="parsing" @click="doParse">解析书籍</el-button>
          <span class="hint">仅抓取免费章节；抓取在后台逐本进行，可关闭窗口</span>
        </el-form-item>
      </el-form>
    </template>

    <template v-else-if="step === 1">
      <el-alert type="info" :closable="false" style="margin-bottom: 12px"
        :title="`识别到 ${parsedItems.length} 本（可导入 ${validItems.length} 本）`" />
      <div class="parse-list">
        <div v-for="(it, idx) in parsedItems" :key="it.bookId" class="parse-item" :class="{ err: it.error, removed: it._removed }">
          <div class="parse-main">
            <div class="parse-title">
              <span class="name">{{ it.title || `未识别 ${it.bookId}` }}</span>
              <span v-if="it.author" class="author">{{ it.author }}</span>
              <el-tag v-if="it.error" size="small" type="danger">{{ it.error }}</el-tag>
            </div>
            <div v-if="!it.error" class="parse-meta">
              共 {{ it.chapterCount }} 章 · 免费 {{ it.freeCount }} 章 · {{ formatNumber(it.wordCount) }} 字
            </div>
          </div>
          <el-button size="small" text type="danger" @click="removeItem(idx)">移除</el-button>
        </div>
      </div>
      <div style="margin-top: 14px; display: flex; gap: 10px">
        <el-button @click="step = 0">返回修改</el-button>
        <el-button type="primary" :disabled="!validItems.length" @click="doEnqueue">
          加入队列（{{ validItems.length }} 本）
        </el-button>
      </div>
    </template>

    <!-- 队列面板：有任务时常驻显示 -->
    <template v-if="jobs.length">
      <el-divider content-position="left">
        导入队列
        <el-button v-if="activeJobs.length" size="small" text type="danger" :icon="VideoPause" style="margin-left: 8px" @click="cancelAll">全部取消</el-button>
      </el-divider>
      <div class="job-list">
        <div v-for="j in jobs" :key="j.id" class="job-item">
          <div class="job-head">
            <el-icon v-if="['fetching', 'analyzing'].includes(j.status)" class="spin"><Loading /></el-icon>
            <span class="job-title">{{ j.title || j.book_id }}</span>
            <el-tag size="small" :type="statusMeta(j.status).type" effect="light">{{ statusMeta(j.status).label }}</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ j.target === 'style' ? '风格库' : `知识库${j.genre ? ' · ' + j.genre : ''}` }}</el-tag>
            <span class="job-ops">
              <el-icon v-if="['failed', 'cancelled'].includes(j.status)" class="op" @click="retryJob(j)"><RefreshRight /></el-icon>
              <el-icon v-if="['done', 'failed', 'cancelled'].includes(j.status)" class="op danger" @click="removeJob(j)"><Delete /></el-icon>
            </span>
          </div>
          <el-progress
            v-if="['fetching', 'analyzing'].includes(j.status)"
            :percentage="jobProgress(j)" :stroke-width="6" :show-text="false"
            :status="j.status === 'analyzing' ? 'warning' : undefined"
            style="margin: 6px 0 4px"
          />
          <div class="job-msg">
            <template v-if="j.error">{{ j.error }}</template>
            <template v-else-if="jobRefLabel(j)">{{ jobRefLabel(j) }}</template>
            <template v-else>{{ j.message || '等待中…' }}</template>
            <span v-if="j.total_chapters" class="job-count">
              {{ j.fetched_chapters }}/{{ j.total_chapters }} 章<template v-if="j.skipped_chapters"> · 跳过 {{ j.skipped_chapters }}</template>
            </span>
          </div>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.hint { margin-left: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.parse-list { max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.parse-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.parse-item.err { border-color: var(--el-color-danger-light-5); background: var(--el-color-danger-light-9); }
.parse-item.removed { opacity: 0.45; }
.parse-title { display: flex; align-items: center; gap: 8px; }
.parse-title .name { font-weight: 600; }
.parse-title .author { color: var(--el-text-color-secondary); font-size: 13px; }
.parse-meta { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
.job-list { max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.job-item { padding: 8px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.job-head { display: flex; align-items: center; gap: 8px; }
.job-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-ops { display: flex; gap: 8px; margin-left: auto; }
.job-ops .op { cursor: pointer; color: var(--el-text-color-secondary); }
.job-ops .op:hover { color: var(--el-color-primary); }
.job-ops .op.danger:hover { color: var(--el-color-danger); }
.job-msg { color: var(--el-text-color-secondary); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; }
.job-count { flex-shrink: 0; }
.spin { animation: spin 1s linear infinite; color: var(--el-color-primary); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
