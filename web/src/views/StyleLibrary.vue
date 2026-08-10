<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { formatDate } from '../utils/format';

const styles = ref([]);
const loading = ref(false);
const dialogOpen = ref(false);
const analyzing = ref(false);
const analyzeStatus = ref('');
const detailOpen = ref(false);
const current = ref(null);
const editOpen = ref(false);
const editForm = ref({ name: '', notes: '' });

const form = ref({ name: '', notes: '', sourceText: '' });
const fileInput = ref(null);

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
  dialogOpen.value = true;
}

async function createStyle() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写风格名称');
  if (!form.value.sourceText.trim()) return ElMessage.warning('请粘贴或上传要分析的小说文本');
  analyzing.value = true;
  analyzeStatus.value = '正在分析写作风格…';
  try {
    const data = await api.createStyle({
      name: form.value.name,
      notes: form.value.notes,
      sourceText: form.value.sourceText
    }, {
      onStatus: (m) => { analyzeStatus.value = m; },
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

function onFileChange(uploadFile) {
  const raw = uploadFile.raw;
  if (!raw) return;
  if (!/\.(txt|md|text)$/i.test(raw.name) && raw.type !== 'text/plain') {
    ElMessage.warning('请选择 .txt 或纯文本文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    form.value.sourceText = String(reader.result || '');
    ElMessage.success(`已读取「${raw.name}」`);
  };
  reader.readAsText(raw, 'utf-8');
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
    </div>

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
            drag
            :auto-upload="false"
            :show-file-list="false"
            :limit="1"
            accept=".txt,.md,.text,text/plain"
            :on-change="onFileChange"
          >
            <div class="upload-tip">
              <el-icon :size="34" color="#9ca3af"><UploadFilled /></el-icon>
              <div class="upload-text">点击选择 .txt 文件（支持千万字级超大文本，自动抽样分析）</div>
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
            <template v-if="form.sourceText.length > 60000">（文本较长，AI 将自动从开头、中间、结尾抽样分析，千万字级长篇同样适用）</template>
          </div>
        </el-form-item>
      </el-form>
      <div v-if="analyzing" class="analyze-status">
        <el-icon class="is-loading"><Loading /></el-icon> {{ analyzeStatus }}
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
</style>
