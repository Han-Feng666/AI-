<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';

const props = defineProps({
  modelValue: Boolean
});
const emit = defineEmits(['update:modelValue']);

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
});

const jsonText = ref('');
const importing = ref(false);
const lastReport = ref(null); // { saved, errors: [{ index, message }] }
const sources = ref([]);
const loading = ref(false);

watch(() => props.modelValue, (open) => {
  if (open) {
    lastReport.value = null;
    loadSources();
  }
});

async function loadSources() {
  loading.value = true;
  try {
    const data = await api.listSources();
    sources.value = data.sources || [];
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function doImport() {
  if (!jsonText.value.trim()) return ElMessage.warning('请粘贴书源 JSON（支持单个对象或数组）');
  importing.value = true;
  try {
    const data = await api.importSources(jsonText.value);
    lastReport.value = data;
    if (data.saved) {
      ElMessage.success(`成功导入 ${data.saved} 条书源`);
      jsonText.value = '';
    } else {
      ElMessage.error('没有书源导入成功，请检查格式');
    }
    loadSources();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    importing.value = false;
  }
}

async function toggleStatus(src) {
  try {
    await api.updateSource(src.id, src.status === 'enabled' ? 'disabled' : 'enabled');
    loadSources();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeSource(src) {
  try {
    await ElMessageBox.confirm(`删除书源「${src.name}」？`, '删除书源', { type: 'warning' });
  } catch { return; }
  try {
    await api.deleteSource(src.id);
    loadSources();
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <el-dialog v-model="show" title="书源管理" width="680px" :close-on-click-modal="false">
    <el-form label-position="top">
      <el-form-item label="粘贴书源 JSON（Legado 阅读格式，支持多个书源的数组）">
        <el-input
          v-model="jsonText"
          type="textarea"
          :rows="7"
          placeholder='[{"bookSourceName":"示例源","bookSourceUrl":"https://example.com","searchUrl":"https://example.com/search?q={{key}}","ruleSearch":{...},"ruleToc":{...},"ruleContent":{...}}]'
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="importing" @click="doImport">导入书源</el-button>
        <span class="hint">重复导入相同站点会覆盖更新；含 JS/XPath 规则的书源会标记为部分支持</span>
      </el-form-item>
    </el-form>

    <el-alert
      v-if="lastReport && (lastReport.saved || (lastReport.errors && lastReport.errors.length))"
      :type="lastReport.saved ? (lastReport.errors?.length ? 'warning' : 'success') : 'error'"
      :closable="true"
      style="margin-bottom: 12px"
    >
      <template #title>
        成功导入 {{ lastReport.saved || 0 }} 条<template v-if="lastReport.errors?.length">，失败 {{ lastReport.errors.length }} 条</template>
      </template>
      <div v-for="(err, i) in lastReport.errors || []" :key="i" class="err-line">第 {{ err.index }} 条：{{ err.message }}</div>
    </el-alert>

    <el-divider content-position="left">已导入书源（{{ sources.length }}）</el-divider>
    <div v-loading="loading" class="source-list">
      <el-empty v-if="!sources.length && !loading" description="还没有书源，先粘贴导入" :image-size="60" />
      <div v-for="src in sources" :key="src.id" class="source-item">
        <div class="source-main">
          <div class="source-name">
            {{ src.name }}
            <el-tag v-if="src.partial?.length" size="small" type="warning" effect="plain">部分支持</el-tag>
          </div>
          <div class="source-host">
            {{ src.host }}
            <span v-if="src.partial?.length" class="partial-hint">{{ src.partial.join('；') }}</span>
          </div>
        </div>
        <el-switch
          :model-value="src.status === 'enabled'"
          inline-prompt
          active-text="启用"
          inactive-text="停用"
          @change="toggleStatus(src)"
        />
        <el-button size="small" text type="danger" @click="removeSource(src)">删除</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.hint { margin-left: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.err-line { font-size: 12px; color: var(--el-text-color-regular); }
.source-list { display: flex; flex-direction: column; gap: 8px; min-height: 60px; }
.source-item { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.source-main { flex: 1; min-width: 0; }
.source-name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.source-host { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
.partial-hint { margin-left: 8px; }
</style>
