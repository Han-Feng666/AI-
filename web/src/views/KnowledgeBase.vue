<script setup>
import { ref, onMounted, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { formatDate, GENRES, formatNumber } from '../utils/format';

const corpora = ref([]);
const loading = ref(false);
const dialogOpen = ref(false);
const importing = ref(false);
const importStatus = ref('');
const detailOpen = ref(false);
const current = ref(null);
const currentAnalysis = ref(null);
const fileInput = ref(null);

const form = ref({
  title: '',
  genre: '',
  author: '',
  content: ''
});

const filterGenre = ref('');

const filteredCorpora = computed(() => {
  if (!filterGenre.value) return corpora.value;
  return corpora.value.filter((c) => c.genre && c.genre.includes(filterGenre.value));
});

async function load() {
  loading.value = true;
  try {
    corpora.value = await api.listKnowledge();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function openImport() {
  form.value = { title: '', genre: '', author: '', content: '' };
  importStatus.value = '';
  dialogOpen.value = true;
}

function onFileChange(uploadFile) {
  const raw = uploadFile.raw;
  if (!raw) return;
  if (!/\.(txt|md|text)$/i.test(raw.name) && raw.type !== 'text/plain') {
    ElMessage.warning('请选择 .txt 或纯文本文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    form.value.content = String(reader.result || '');
    form.value.title = form.value.title || raw.name.replace(/\.(txt|md|text)$/i, '');
    ElMessage.success(`已读取「${raw.name}」（${formatNumber(form.value.content.length)} 字）`);
  };
  reader.readAsText(raw, 'utf-8');
}

async function doImport() {
  if (!form.value.content.trim()) return ElMessage.warning('请导入小说文本');
  if (!form.value.genre) return ElMessage.warning('请选择小说题材');
  importing.value = true;
  importStatus.value = '正在解析文本并分块…';
  try {
    const data = await api.importKnowledge({
      title: form.value.title || '未命名作品',
      genre: form.value.genre,
      author: form.value.author,
      content: form.value.content
    }, {
      onStatus: (m) => { importStatus.value = m; },
      onError: (m) => { throw new Error(m); }
    });
    corpora.value.unshift(data.corpus);
    dialogOpen.value = false;
    ElMessage.success('学习完成！该知识库已可在新建小说时勾选使用。');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    importing.value = false;
  }
}

async function showDetail(c) {
  current.value = c;
  detailOpen.value = true;
  currentAnalysis.value = null;
  try {
    const full = await api.getKnowledge(c.id);
    let parsed = null;
    try { parsed = JSON.parse(full.analysis); } catch { /* plain text */ }
    currentAnalysis.value = parsed || { raw: full.analysis };
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeCorpus(c) {
  try {
    await ElMessageBox.confirm(`确定删除知识库「${c.title}」吗？已引用该知识库的小说会失去参考。`, '删除知识库', { type: 'warning' });
  } catch { return; }
  try {
    await api.deleteKnowledge(c.id);
    corpora.value = corpora.value.filter((x) => x.id !== c.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function statusType(s) {
  return { learned: 'success', learning: 'warning', pending: 'info', failed: 'danger' }[s] || 'info';
}
function statusLabel(s) {
  return { learned: '已学习', learning: '学习中', pending: '待学习', failed: '学习失败' }[s] || s;
}

const analysisFields = [
  ['writing_style', '文笔风格'],
  ['plot_patterns', '剧情套路'],
  ['logic_rules', '逻辑规律'],
  ['worldview', '世界观构建'],
  ['character_craft', '人物塑造'],
  ['replicable_techniques', '可复用技法']
];

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">知识学习库</h2>
        <p class="page-sub">导入优秀小说 txt，AI 自动学习其文笔、剧情逻辑、人物塑造和世界观构建方式，创作同类小说时可勾选参考</p>
      </div>
      <el-button type="primary" size="large" @click="openImport">
        <el-icon style="margin-right:6px"><Plus /></el-icon>导入小说学习
      </el-button>
    </div>

    <div class="filter-bar">
      <el-select v-model="filterGenre" placeholder="按题材筛选" clearable size="default" style="width:200px">
        <el-option v-for="g in GENRES" :key="g" :label="g" :value="g" />
      </el-select>
      <span class="count-hint">共 {{ filteredCorpora.length }} 个知识库</span>
    </div>

    <div v-loading="loading" class="corpus-grid" :style="{ minHeight: loading ? '200px' : 'auto' }">
      <el-empty v-if="!loading && !corpora.length" description="知识库为空，导入一部优秀小说让它学习">
        <el-button type="primary" @click="openImport">导入小说</el-button>
      </el-empty>

      <div v-for="c in filteredCorpora" :key="c.id" class="corpus-card" @click="showDetail(c)">
        <div class="card-head">
          <div class="card-icon"><el-icon :size="20"><Reading /></el-icon></div>
          <div class="card-title-area">
            <div class="card-title">{{ c.title }}</div>
            <div class="card-meta">
              <el-tag size="small" effect="plain" type="info">{{ c.genre }}</el-tag>
              <el-tag size="small" :type="statusType(c.status)" effect="light">{{ statusLabel(c.status) }}</el-tag>
            </div>
          </div>
        </div>
        <div class="card-body">
          <span v-if="c.author" class="card-author">作者：{{ c.author }}</span>
          <span class="card-words">{{ formatNumber(c.total_words) }} 字</span>
        </div>
        <div class="card-foot">
          <span class="card-time">{{ formatDate(c.learned_at || c.created_at) }}</span>
          <span class="card-ops" @click.stop>
            <el-icon class="op danger" @click="removeCorpus(c)"><Delete /></el-icon>
          </span>
        </div>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <el-dialog v-model="dialogOpen" title="导入小说 · AI 学习分析" width="660px" :close-on-click-modal="false">
      <el-form :model="form" label-width="80px">
        <el-form-item label="作品名称">
          <el-input v-model="form.title" maxlength="50" placeholder="如：斗破苍穹 / 鬼吹灯 / 凡人修仙传" />
        </el-form-item>
        <el-form-item label="题材" required>
          <el-select v-model="form.genre" placeholder="选择小说题材" filterable style="width:100%">
            <el-option v-for="g in GENRES" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="作者">
          <el-input v-model="form.author" maxlength="30" placeholder="可选：原作者名" />
        </el-form-item>
        <el-form-item label="小说文本" required>
          <el-upload
            drag
            :auto-upload="false"
            :show-file-list="false"
            :limit="1"
            accept=".txt,.md,.text,text/plain"
            :on-change="onFileChange"
          >
            <div class="upload-tip">
              <el-icon :size="34" color="#9ca3af"><UploadFilled /></el-icon>
              <div class="upload-text">点击选择 .txt 文件（支持大文件，AI 从开头/中段/结尾三段采样学习）</div>
            </div>
          </el-upload>
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="6"
            placeholder="或直接粘贴小说原文（建议至少 1 万字，越多学习越充分）"
          />
          <div class="text-hint">
            已输入 {{ formatNumber(form.content.length) }} 字
            <template v-if="form.content.length > 30000">（文本较长，AI 将从开头、中间、结尾各取一段深度学习分析）</template>
          </div>
        </el-form-item>
      </el-form>
      <div v-if="importing" class="import-status">
        <el-icon class="is-loading"><Loading /></el-icon> {{ importStatus }}
      </div>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="importing" :disabled="!form.content.trim() || !form.genre" @click="doImport">
          <el-icon style="margin-right:4px"><MagicStick /></el-icon>开始学习
        </el-button>
      </template>
    </el-dialog>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailOpen" size="580px" :title="current?.title">
      <div v-if="current" class="detail-body">
        <div class="detail-meta">
          <el-tag size="small" effect="plain" type="info">{{ current.genre }}</el-tag>
          <el-tag size="small" :type="statusType(current.status)" effect="light">{{ statusLabel(current.status) }}</el-tag>
          <span v-if="current.author" class="meta-text">作者：{{ current.author }}</span>
          <span class="meta-text">{{ formatNumber(current.total_words) }} 字</span>
        </div>

        <div v-if="!currentAnalysis" class="loading-block">
          <el-icon class="is-loading" :size="24"><Loading /></el-icon>
          <span>正在加载分析结果…</span>
        </div>

        <template v-if="currentAnalysis">
          <template v-if="currentAnalysis.raw">
            <div class="field">
              <div class="field-text raw">{{ currentAnalysis.raw }}</div>
            </div>
          </template>
          <template v-else>
            <div v-for="[key, label] in analysisFields" :key="key" class="field">
              <div class="field-label">{{ label }}</div>
              <div class="field-text">{{ currentAnalysis[key] || '—' }}</div>
            </div>
          </template>
        </template>

        <div class="detail-ops">
          <el-button size="small" type="danger" plain @click="removeCorpus(current)">
            <el-icon style="margin-right:4px"><Delete /></el-icon>删除知识库
          </el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
.page-title { margin: 0; font-size: 24px; font-weight: 700; }
.page-sub { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.filter-bar { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.count-hint { font-size: 12px; color: #9ca3af; }
.corpus-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.corpus-card {
  background: #fff;
  border-radius: 12px;
  padding: 18px;
  box-shadow: 0 1px 3px rgba(20,24,80,.08);
  cursor: pointer;
  transition: transform .15s, box-shadow .15s;
}
.corpus-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(20,24,80,.1); }
.card-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.card-icon {
  width: 40px; height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, #ecfdf5, #d1fae5);
  color: #059669;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.card-title-area { flex: 1; min-width: 0; }
.card-title { font-size: 15px; font-weight: 700; color: #1e1b4b; margin-bottom: 6px; }
.card-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.card-body { font-size: 12.5px; color: #6b7280; display: flex; gap: 12px; margin-bottom: 10px; }
.card-foot { display: flex; justify-content: space-between; align-items: center; padding-top: 10px; border-top: 1px solid #f3f4f8; }
.card-time { font-size: 11px; color: #9ca3af; }
.card-ops { display: flex; gap: 10px; color: #9ca3af; }
.card-ops .op:hover { color: #ef4444; }
.upload-tip { padding: 6px 0; }
.upload-text { font-size: 12px; color: #9ca3af; margin-top: 6px; }
.text-hint { font-size: 11px; color: #9ca3af; margin-top: 6px; }
.import-status { display: flex; align-items: center; gap: 8px; color: #059669; font-size: 13px; padding: 10px 0; }
.detail-body { padding: 4px 2px; }
.detail-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
.meta-text { font-size: 12px; color: #6b7280; }
.loading-block { display: flex; align-items: center; gap: 8px; color: #9ca3af; padding: 20px 0; }
.field { margin-bottom: 16px; }
.field-label { font-size: 12px; color: #059669; font-weight: 700; margin-bottom: 4px; }
.field-text { font-size: 13.5px; color: #374151; line-height: 1.8; white-space: pre-wrap; }
.field-text.raw { white-space: pre-wrap; }
.detail-ops { margin-top: 24px; }
</style>
