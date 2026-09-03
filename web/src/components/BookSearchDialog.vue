<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, Setting, Loading } from '@element-plus/icons-vue';
import api from '../api';
import { GENRES } from '../utils/format';
import BookSourceDialog from './BookSourceDialog.vue';

const props = defineProps({
  modelValue: Boolean,
  defaultTarget: { type: String, default: 'style' }
});
const emit = defineEmits(['update:modelValue', 'refresh']);

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
});

const keyword = ref('');
const searching = ref(false);
const results = ref([]);
const failures = ref([]);
const searched = ref(false);

const step = ref('search'); // search | confirm
const selected = ref(null);
const target = ref(props.defaultTarget);
const genre = ref('');
const enqueueing = ref(false);

const showManage = ref(false);

watch(() => props.modelValue, (open) => {
  if (open) {
    step.value = 'search';
    target.value = props.defaultTarget;
  }
});
onUnmounted(() => {});

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw) return ElMessage.warning('请输入书名或作者关键词');
  searching.value = true;
  searched.value = false;
  results.value = [];
  failures.value = [];
  try {
    const data = await api.searchSources(kw);
    results.value = data.results || [];
    failures.value = data.failures || [];
    searched.value = true;
    if (!results.value.length && !failures.value.length) {
      ElMessage.info('所有书源均无结果');
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    searching.value = false;
  }
}

function pick(item) {
  selected.value = item;
  target.value = props.defaultTarget;
  step.value = 'confirm';
}

async function doEnqueue() {
  if (target.value === 'knowledge' && !genre.value) return ElMessage.warning('请选择知识库题材');
  enqueueing.value = true;
  try {
    await api.importFromSource({
      sourceId: selected.value.sourceId,
      bookUrl: selected.value.bookUrl,
      name: selected.value.name,
      author: selected.value.author,
      target: target.value,
      genre: target.value === 'knowledge' ? genre.value : ''
    });
    ElMessage.success(`「${selected.value.name}」已加入导入队列，整本抓取需要一些时间，可关闭窗口`);
    emit('refresh');
    show.value = false;
  } catch (e) {
    if (e.response?.status === 409) ElMessage.info(e.response.data?.error || '该书已在队列中');
    else ElMessage.error(e.message);
  } finally {
    enqueueing.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="show" title="书源搜索导入" width="720px" :close-on-click-modal="false">
    <template v-if="step === 'search'">
      <div class="search-bar">
        <el-input
          v-model="keyword"
          placeholder="输入书名或作者关键词，同时搜索所有启用的书源"
          clearable
          @keyup.enter="doSearch"
        >
          <template #append>
            <el-button :icon="Search" :loading="searching" @click="doSearch">搜索</el-button>
          </template>
        </el-input>
        <el-button :icon="Setting" @click="showManage = true">管理书源</el-button>
      </div>

      <div v-if="searching" class="status-line">
        <el-icon class="spin"><Loading /></el-icon> 正在向所有启用书源搜索…
      </div>

      <template v-if="searched">
        <el-alert
          v-if="results.length"
          type="success" :closable="false" style="margin-top: 12px"
          :title="`搜索到 ${results.length} 条结果，点击选择要导入的书`"
        />
        <el-alert
          v-else type="info" :closable="false" style="margin-top: 12px"
          title="没有搜索到结果"
          :description="failures.length ? '部分书源搜索失败，详见下方' : '尝试更换关键词，或检查书源是否可用'"
        />

        <div class="result-list">
          <div v-for="(it, i) in results" :key="i" class="result-item" @click="pick(it)">
            <div class="result-main">
              <div class="result-title">
                <span class="name">{{ it.name }}</span>
                <span v-if="it.author" class="author">{{ it.author }}</span>
                <el-tag size="small" type="info" effect="plain">{{ it.sourceName }}</el-tag>
              </div>
              <div v-if="it.intro" class="result-intro">{{ it.intro }}</div>
              <div v-if="it.latest" class="result-latest">{{ it.latest }}</div>
            </div>
            <el-button size="small" type="primary" plain @click.stop="pick(it)">导入这本</el-button>
          </div>
        </div>

        <div v-if="failures.length" class="failure-box">
          <div class="failure-title">以下书源搜索失败（{{ failures.length }}）</div>
          <div v-for="f in failures" :key="f.sourceId" class="failure-item">
            {{ f.sourceName }}：{{ f.error }}
          </div>
        </div>
      </template>
    </template>

    <template v-else-if="step === 'confirm' && selected">
      <el-descriptions :column="1" border style="margin-bottom: 16px">
        <el-descriptions-item label="书名">{{ selected.name }}</el-descriptions-item>
        <el-descriptions-item label="作者">{{ selected.author || '未知' }}</el-descriptions-item>
        <el-descriptions-item label="来源书源">{{ selected.sourceName }}</el-descriptions-item>
        <el-descriptions-item v-if="selected.intro" label="简介">{{ selected.intro }}</el-descriptions-item>
      </el-descriptions>
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
        <el-form-item>
          <span class="hint">整本全量抓取（后台逐章进行），完成后自动进入分析管线，可关闭窗口</span>
        </el-form-item>
      </el-form>
      <div style="display: flex; gap: 10px">
        <el-button @click="step = 'search'">返回搜索</el-button>
        <el-button type="primary" :loading="enqueueing" @click="doEnqueue">加入导入队列</el-button>
      </div>
    </template>

    <BookSourceDialog v-model="showManage" />
  </el-dialog>
</template>

<style scoped>
.search-bar { display: flex; gap: 10px; }
.status-line { margin-top: 14px; color: var(--el-text-color-secondary); display: flex; align-items: center; gap: 8px; }
.result-list { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow: auto; }
.result-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; cursor: pointer; }
.result-item:hover { border-color: var(--el-color-primary-light-5); background: var(--el-color-primary-light-9); }
.result-main { flex: 1; min-width: 0; }
.result-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.result-title .name { font-weight: 600; }
.result-title .author { color: var(--el-text-color-secondary); font-size: 13px; }
.result-intro { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.result-latest { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
.failure-box { margin-top: 14px; padding: 10px 12px; background: var(--el-fill-color-light); border-radius: 8px; }
.failure-title { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.failure-item { font-size: 12px; color: var(--el-text-color-regular); line-height: 1.8; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.spin { animation: spin 1s linear infinite; color: var(--el-color-primary); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
