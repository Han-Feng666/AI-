<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Loading, VideoPause } from '@element-plus/icons-vue';
import api from '../api';

/**
 * 番茄导入批次进度条：有进行中任务时显示在页面顶部。
 * 批次结束时 emit('done') 供父页面刷新列表。
 */
const emit = defineEmits(['done']);

const jobs = ref([]);
let pollTimer = null;
let hadActive = false;

const activeJobs = computed(() => jobs.value.filter((j) => ['pending', 'fetching', 'analyzing'].includes(j.status)));
const current = computed(() => activeJobs.value[0] || null);
const waitingCount = computed(() => Math.max(0, activeJobs.value.length - 1));

async function load() {
  try {
    const data = await api.getFanqieJobs();
    jobs.value = data.jobs || [];
    const nowActive = activeJobs.value.length > 0;
    if (hadActive && !nowActive) emit('done');
    hadActive = nowActive;
  } catch { /* 轮询失败静默 */ }
}

onMounted(() => {
  load();
  pollTimer = setInterval(load, 3000);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

async function cancelAll() {
  try {
    await ElMessageBox.confirm('取消当前与队列中的全部导入任务？', '取消导入', { type: 'warning' });
  } catch { return; }
  try {
    await api.cancelFanqieJobs();
    load();
    ElMessage.success('已取消');
  } catch (e) { ElMessage.error(e.message); }
}
</script>

<template>
  <div v-if="current" class="fq-bar">
    <el-icon class="spin"><Loading /></el-icon>
    <span class="fq-bar-title">番茄导入</span>
    <el-progress
      :percentage="current.status === 'done' ? 100 : (current.progress || 0)"
      :stroke-width="8"
      :show-text="false"
      class="fq-bar-progress"
      :status="current.status === 'analyzing' ? 'warning' : undefined"
    />
    <span class="fq-bar-msg">
      《{{ current.title || current.book_id }}》{{ current.message || '处理中…' }}
      <template v-if="waitingCount">（还有 {{ waitingCount }} 本排队）</template>
    </span>
    <el-button size="small" text type="danger" :icon="VideoPause" @click="cancelAll">取消</el-button>
  </div>
</template>

<style scoped>
.fq-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; margin-bottom: 14px; border: 1px solid var(--el-color-primary-light-7); background: var(--el-color-primary-light-9); border-radius: 8px; }
.fq-bar-title { font-weight: 600; font-size: 13px; flex-shrink: 0; }
.fq-bar-progress { flex: 0 0 160px; }
.fq-bar-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--el-text-color-regular); }
.spin { animation: spin 1s linear infinite; color: var(--el-color-primary); flex-shrink: 0; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
