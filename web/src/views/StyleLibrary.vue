<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { formatDate, readTxtFile } from '../utils/format';
import FanqieImportDialog from '../components/FanqieImportDialog.vue';
import FanqieBatchBar from '../components/FanqieBatchBar.vue';
import BookSearchDialog from '../components/BookSearchDialog.vue';

const styles = ref([]);
const loading = ref(false);
const fanqieOpen = ref(false);
const bookSearchOpen = ref(false);
const dialogOpen = ref(false);
const analyzing = ref(false);
const analyzeStatus = ref('');
const analyzeProgress = ref(0);
const detailOpen = ref(false);
const current = ref(null);
const editOpen = ref(false);
const editForm = ref({ name: '', notes: '' });

const form = ref({ name: '', notes: '', sourceText: '' });
const fileInput = ref(null);
const uploadRef = ref(null);

// 风格 DNA / 切片浏览
const SCENE_TAGS = ['对话', '动作/打斗', '心理', '环境', '开篇', '悬念/转折', '日常', '情绪高潮'];
const dnaOpen = ref(false);
const dnaData = ref(null);
const slices = ref([]);
const slicesLoading = ref(false);
const activeTag = ref('');
const retagging = ref(false);
const retagStatus = ref('');

const DNA_LABELS = {
  avg_sentence_length: '平均句长(字)',
  short_sentence_ratio: '短句占比(%)',
  long_sentence_ratio: '长句占比(%)',
  dialogue_ratio: '对话占比(%)',
  avg_paragraph_length: '段落均长(字)',
  comma_period_ratio: '逗句比',
  exclaim_per_1k: '感叹号/千字',
  question_per_1k: '问号/千字',
  action_words_per_1k: '动作词/千字',
  emotion_words_per_1k: '情绪词/千字'
};

function parseDNA(s) {
  if (!s?.style_dna) return null;
  try { return JSON.parse(s.style_dna); } catch { return null; }
}

function safeTags(s) {
  if (!s?.scene_tags) return [];
  try {
    const t = typeof s.scene_tags === 'string' ? JSON.parse(s.scene_tags) : s.scene_tags;
    return Array.isArray(t) ? t : [];
  } catch { return []; }
}

async function openDna(s) {
  dnaData.value = parseDNA(s);
  activeTag.value = '';
  slices.value = [];
  dnaOpen.value = true;
  await loadSlices(s.id);
}

async function loadSlices(styleId) {
  slicesLoading.value = true;
  try {
    const r = await api.getStyleSlices(styleId, activeTag.value || undefined);
    slices.value = r.slices || [];
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    slicesLoading.value = false;
  }
}

function pickTag(tag) {
  activeTag.value = activeTag.value === tag ? '' : tag;
  if (current.value) loadSlices(current.value.id);
}

async function retagStyle() {
  const s = current.value;
  if (!s) return;
  retagging.value = true;
  retagStatus.value = '准备中…';
  try {
    await api.retagStyle(s.id, {
      onStatus: (m) => { retagStatus.value = m; },
      onError: (m) => { throw new Error(m); }
    });
    ElMessage.success('切片与打标已更新');
    const fresh = await api.getStyle(s.id);
    current.value = fresh;
    dnaData.value = parseDNA(fresh);
    const idx = styles.value.findIndex((x) => x.id === s.id);
    if (idx > -1) styles.value[idx] = fresh;
    await loadSlices(s.id);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    retagging.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    styles.value = await api.listStyles();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { name: '', notes: '', sourceText: '' };
  analyzeStatus.value = '';
  uploadRef.value?.clearFiles();
  dialogOpen.value = true;
}

async function createStyle() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写风格名称');
  if (!form.value.sourceText.trim()) return ElMessage.warning('请粘贴或上传要分析的小说文本');
  analyzing.value = true;
  analyzeProgress.value = 0;
  analyzeStatus.value = '正在分块处理全文…';
  try {
    const data = await api.createStyle({
      name: form.value.name,
      notes: form.value.notes,
      sourceText: form.value.sourceText
    }, {
      onStatus: (m) => { analyzeStatus.value = m; },
      onProgress: (pct) => { analyzeProgress.value = pct; },
      onError: (m) => { throw new Error(m); }
    });
    styles.value.unshift(data.style);
    dialogOpen.value = false;
    ElMessage.success('风格提取成功');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    analyzing.value = false;
  }
}

async function onFileChange(uploadFile) {
  const raw = uploadFile.raw;
  if (!raw) return;
  if (!/\.(txt|md|text)$/i.test(raw.name) && raw.type !== 'text/plain') {
    ElMessage.warning('请选择 .txt 或纯文本文件');
    uploadRef.value?.clearFiles();
    return;
  }
  try {
    form.value.sourceText = await readTxtFile(raw);
    ElMessage.success(`已读取「${raw.name}」`);
  } catch (e) {
    ElMessage.error(`读取文件失败：${e.message}`);
  }
  // 立即清空 upload 内部 fileList，否则 :limit 会阻止连续导入第二个文件
  uploadRef.value?.clearFiles();
}

function showDetail(s) {
  current.value = s;
  detailOpen.value = true;
}

function openEdit(s) {
  editForm.value = { name: s.name, notes: s.notes };
  editOpen.value = true;
}

async function saveEdit() {
  if (!editForm.value.name.trim()) return ElMessage.warning('名称不能为空');
  try {
    const updated = await api.updateStyle(current.value.id, editForm.value);
    const idx = styles.value.findIndex((x) => x.id === current.value.id);
    if (idx > -1) styles.value[idx] = updated;
    if (current.value?.id === updated.id) current.value = updated;
    editOpen.value = false;
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeStyle(s) {
  try {
    await ElMessageBox.confirm(`确定删除风格「${s.name}」吗？已引用该风格的小说会失去此风格参考。`, '删除风格', { type: 'warning' });
  } catch { return; }
  try {
    await api.deleteStyle(s.id);
    styles.value = styles.value.filter((x) => x.id !== s.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return String(n);
}

const analysisFields = [
  ['overview', '总体文风'],
  ['perspective', '叙述视角'],
  ['sentence', '句式特征'],
  ['diction', '用词习惯'],
  ['dialogue', '对话风格'],
  ['description', '描写偏好'],
  ['emotion', '情感表达'],
  ['rhetoric', '修辞与禁忌'],
  ['chapter_opening', '开篇切入'],
  ['chapter_ending', '收尾方式']
];

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">风格库</h2>
        <p class="page-sub">导入你喜欢的小说文本，AI 自动提取作者写作风格并保存，创作时可单独或融合多种风格</p>
      </div>
      <el-button type="primary" size="large" @click="openCreate">
        <el-icon style="margin-right:6px"><Plus /></el-icon>导入并分析风格
      </el-button>
      <el-button size="large" @click="fanqieOpen = true">
        <el-icon style="margin-right:6px"><Connection /></el-icon>从番茄批量导入
      </el-button>
      <el-button size="large" @click="bookSearchOpen = true">
        <el-icon style="margin-right:6px"><Search /></el-icon>书源搜索导入
      </el-button>
    </div>

    <FanqieBatchBar @done="load" />
    <FanqieImportDialog v-model="fanqieOpen" default-target="style" @refresh="load" />
    <BookSearchDialog v-model="bookSearchOpen" default-target="style" @refresh="load" />

    <div v-loading="loading" class="style-grid" :style="{ minHeight: loading ? '200px' : 'auto' }">
      <el-empty v-if="!loading && !styles.length" description="风格库为空，导入一部小说的文本试试">
        <el-button type="primary" @click="openCreate">导入文本</el-button>
      </el-empty>

      <div v-for="s in styles" :key="s.id" class="style-card" @click="showDetail(s)">
        <div class="style-head">
          <div class="style-icon"><el-icon :size="20"><Brush /></el-icon></div>
          <div class="style-name">{{ s.name }}</div>
        </div>
        <div class="style-overview ellipsis">{{ s.analysis?.overview || '点击查看风格分析' }}</div>
        <div class="style-foot">
          <span class="style-time">{{ formatDate(s.updated_at) }}</span>
          <span class="style-ops" @click.stop>
            <el-icon class="op" @click="openEdit(s)"><Edit /></el-icon>
            <el-icon class="op danger" @click="removeStyle(s)"><Delete /></el-icon>
          </span>
        </div>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <el-dialog v-model="dialogOpen" title="导入文本 · 提取写作风格" width="620px" :close-on-click-modal="false">
      <el-form :model="form" label-width="80px">
        <el-form-item label="风格名称" required>
          <el-input v-model="form.name" maxlength="30" placeholder="如：张无忌_文风 / 《狂人日记》 / 悬疑冷峻风" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.notes" maxlength="100" placeholder="可选：来源作品、用途说明" />
        </el-form-item>
        <el-form-item label="小说文本" required>
          <el-upload
            ref="uploadRef"
            drag
            :auto-upload="false"
            :show-file-list="false"
            accept=".txt,.md,.text,text/plain"
            :on-change="onFileChange"
          >
            <div class="upload-tip">
              <el-icon :size="34" color="#9ca3af"><UploadFilled /></el-icon>
              <div class="upload-text">点击选择 .txt 文件（支持超大文本，AI 全文逐段分析，进度条实时展示）</div>
            </div>
          </el-upload>
          <el-input
            v-model="form.sourceText"
            type="textarea"
            :rows="8"
            placeholder="粘贴要分析的小说原文（建议 5000 字以上，越多分析越准确）"
          />
          <div class="text-hint">
            已输入 {{ formatNum(form.sourceText.length) }} 字
            <template v-if="form.sourceText.length > 10000">（文本较长，AI 将全文逐段分析，进度条实时展示处理进度）</template>
          </div>
        </el-form-item>
      </el-form>
      <div v-if="analyzing" class="analyze-status">
        <el-icon class="is-loading"><Loading /></el-icon> {{ analyzeStatus }}
        <el-progress v-if="analyzeProgress > 0" :percentage="analyzeProgress" :stroke-width="6" style="width:100%;margin-top:8px" />
      </div>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="analyzing" :disabled="!form.sourceText.trim()" @click="createStyle">
          <el-icon style="margin-right:4px"><MagicStick /></el-icon>提取写作风格
        </el-button>
      </template>
    </el-dialog>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailOpen" size="560px" :title="current?.name">
      <div v-if="current" class="detail-body">
        <el-tag v-if="current.notes" effect="plain" type="info" class="notes-tag">{{ current.notes }}</el-tag>
        <div class="dna-entry">
          <el-button size="small" type="primary" plain @click="openDna(current)">
            <el-icon style="margin-right:4px"><DataAnalysis /></el-icon>风格 DNA 与样本切片
          </el-button>
          <span class="dna-hint">{{ parseDNA(current) ? '已建立量化画像' : '未建立画像（可点上方按钮补建）' }}</span>
        </div>
        <div v-for="[key, label] in analysisFields" :key="key" class="field">
          <div class="field-label">{{ label }}</div>
          <div class="field-text">{{ current.analysis?.[key] || '—' }}</div>
        </div>
        <div v-if="current.analysis?.example?.length" class="field">
          <div class="field-label">代表性句段</div>
          <blockquote v-for="(e, i) in current.analysis.example" :key="i" class="example">{{ e }}</blockquote>
        </div>
        <div class="detail-ops">
          <el-button size="small" @click="openEdit(current)"><el-icon style="margin-right:4px"><Edit /></el-icon>编辑</el-button>
          <el-button size="small" type="danger" plain @click="removeStyle(current)"><el-icon style="margin-right:4px"><Delete /></el-icon>删除</el-button>
        </div>
      </div>
    </el-drawer>

    <!-- 风格 DNA + 样本切片抽屉 -->
    <el-drawer v-model="dnaOpen" size="620px" :title="`${current?.name} · 风格 DNA`">
      <div v-loading="slicesLoading" class="dna-body">
        <div v-if="dnaData" class="dna-grid">
          <div v-for="(label, key) in DNA_LABELS" :key="key" class="dna-cell">
            <div class="dna-val">{{ dnaData[key] ?? '—' }}</div>
            <div class="dna-label">{{ label }}</div>
          </div>
        </div>
        <el-empty v-else description="该风格还没有风格 DNA，点击下方按钮基于原文补建" :image-size="60" />
        <div v-if="dnaData?.top_bigrams?.length" class="field">
          <div class="field-label">高频词</div>
          <div class="field-text">{{ dnaData.top_bigrams.join('、') }}</div>
        </div>

        <div class="slice-head">
          <div class="field-label" style="margin:0">样本切片（{{ slices.length }}）</div>
          <el-button size="small" :loading="retagging" @click="retagStyle">
            <el-icon style="margin-right:4px"><Refresh /></el-icon>{{ retagging ? '处理中' : '重新切片/打标' }}
          </el-button>
        </div>
        <div v-if="retagging" class="retag-status">{{ retagStatus }}</div>
        <div class="tag-filter">
          <el-tag
            v-for="tag in SCENE_TAGS"
            :key="tag"
            :effect="activeTag === tag ? 'dark' : 'plain'"
            class="tag-chip"
            @click="pickTag(tag)"
          >{{ tag }}</el-tag>
        </div>
        <div v-if="slicesLoading" style="min-height:120px"></div>
        <blockquote v-for="s in slices" :key="s.id" class="slice-item">
          <div class="slice-tags">
            <el-tag v-for="t in safeTags(s)" :key="t" size="small" effect="plain" type="info">{{ t }}</el-tag>
          </div>
          {{ s.text }}
        </blockquote>
        <el-empty v-if="!slicesLoading && !slices.length" description="暂无切片（可点「重新切片/打标」基于原文补建）" :image-size="60" />
      </div>
    </el-drawer>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editOpen" title="编辑风格" width="420px">
      <el-form :model="editForm" label-width="70px">
        <el-form-item label="名称" required>
          <el-input v-model="editForm.name" maxlength="30" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.notes" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
.page-title { margin: 0; font-size: 24px; font-weight: 700; }
.page-sub { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.style-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.style-card {
  background: #fff;
  border-radius: 12px;
  padding: 18px;
  box-shadow: 0 1px 3px rgba(20,24,80,.08);
  cursor: pointer;
  transition: transform .15s, box-shadow .15s;
}
.style-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(20,24,80,.1); }
.style-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.style-icon {
  width: 36px; height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #eef0ff, #e0e7ff);
  color: #4f46e5;
  display: flex;
  align-items: center;
  justify-content: center;
}
.style-name { font-size: 15px; font-weight: 700; color: #1e1b4b; }
.style-overview { font-size: 12.5px; color: #6b7280; line-height: 1.7; min-height: 40px; }
.style-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f3f4f8; }
.style-time { font-size: 11px; color: #9ca3af; }
.style-ops { display: flex; gap: 10px; color: #9ca3af; }
.style-ops .op:hover { color: #4f46e5; }
.style-ops .op.danger:hover { color: #ef4444; }
.upload-tip { padding: 6px 0; }
.upload-text { font-size: 12px; color: #9ca3af; margin-top: 6px; }
.text-hint { font-size: 11px; color: #9ca3af; margin-top: 6px; }
.analyze-status { display: flex; align-items: center; gap: 8px; color: #4f46e5; font-size: 13px; padding: 10px 0; }
.detail-body { padding: 4px 2px; }
.notes-tag { margin-bottom: 14px; }
.field { margin-bottom: 16px; }
.field-label { font-size: 12px; color: #4f46e5; font-weight: 700; margin-bottom: 4px; }
.field-text { font-size: 13.5px; color: #374151; line-height: 1.8; white-space: pre-wrap; }
.example {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid #c7d2fe;
  background: #fafbff;
  color: #4b5563;
  font-size: 13px;
  line-height: 1.8;
}
.detail-ops { margin-top: 18px; display: flex; gap: 10px; }
.dna-entry { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.dna-hint { font-size: 11.5px; color: #9ca3af; }
.dna-body { padding: 4px 2px; }
.dna-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
.dna-cell { background: #fafbff; border: 1px solid #eef0f8; border-radius: 10px; padding: 10px 8px; text-align: center; }
.dna-val { font-size: 16px; font-weight: 700; color: #4f46e5; }
.dna-label { font-size: 11px; color: #9ca3af; margin-top: 3px; }
.slice-head { display: flex; justify-content: space-between; align-items: center; margin: 20px 0 8px; }
.retag-status { font-size: 12px; color: #4f46e5; margin-bottom: 8px; }
.tag-filter { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.tag-chip { cursor: pointer; }
.slice-item {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid #c7d2fe;
  background: #fafbff;
  color: #4b5563;
  font-size: 12.5px;
  line-height: 1.8;
  max-height: 140px;
  overflow: hidden;
}
.slice-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
</style>
