<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { GENRES, STATUS_MAP, formatWords, formatDate, AVATAR_COLORS, splitGenres, PRESET_STYLES, readTxtFile } from '../utils/format';

const router = useRouter();
const novels = ref([]);
const loading = ref(false);
// 后台活动 Job（多本并行：Phase 增强后改用 SSE 实时接收，初次加载仍调一次 poll 兜底）
const activeJobs = ref({});
let jobsTimer = null;
let jobStream = null;
let streamFailCount = 0;
async function pollJobs() {
  try { const jobs = await api.listActiveJobs(); const m = {}; for (const j of jobs) m[j.novel_id] = j; activeJobs.value = m; } catch { /* ignore */ }
}
function startJobStream() {
  try { jobStream = new EventSource('/api/jobs/stream'); } catch { return; }
  jobStream.addEventListener('message', (e) => {
    try {
      const ev = JSON.parse(e.data);
      // snapshot：全量替换
      if (ev.kind === 'snapshot' && Array.isArray(ev.jobs)) {
        const m = {}; for (const j of ev.jobs) m[j.novel_id] = j; activeJobs.value = m;
        streamFailCount = 0;
        return;
      }
      // 增量：单个 job 状态变化 (kind=created/updated)
      if ((ev.kind === 'created' || ev.kind === 'updated') && ev.job) {
        const j = ev.job;
        if (j.novel_id == null) return;
        if (j.status === 'done' || j.status === 'failed' || j.status === 'aborted') {
          const m = { ...activeJobs.value };
          delete m[j.novel_id];
          activeJobs.value = m;
          if (j.status === 'done') {
            const stageMap = { plan:'方案生成', revise:'方案修订', generate_chapter:'章节生成', polish:'去 AI 味', compress:'压缩' };
            ElMessage.success(`《${j.novel_title || ''}》${stageMap[j.stage] || '任务'}已完成`);
          }
        } else {
          activeJobs.value = { ...activeJobs.value, [j.novel_id]: j };
        }
        streamFailCount = 0;
      }
    } catch { /* ignore */ }
  });
  jobStream.onerror = () => {
    // SSE 断开重连失败兜底 — 退回轮询
    streamFailCount++;
    try { jobStream.close(); } catch { /* ignore */ }
    jobStream = null;
    if (streamFailCount <= 3 && !jobsTimer) {
      jobsTimer = setInterval(pollJobs, 4000);
    }
  };
}
function jobLabel(nid) {
  const j = activeJobs.value[nid];
  if (!j) return '';
  const map = { plan: '正在生成方案', revise: '正在修订方案', generate_chapter: '正在写章节', polish: '去 AI 味中', compress: '正在压缩' };
  return map[j.stage] || '生成中';
}
const dialogOpen = ref(false);
const saving = ref(false);
const importOpen = ref(false);
const importing = ref(false);
const importTitle = ref('');
const importFile = ref(null);
const importResult = ref(null);
const importPreview = ref(null);
const importTxtContent = ref('');

function openImport() {
  importOpen.value = true;
  importPreview.value = null;
  importTxtContent.value = '';
  importFile.value = null;
}

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
  importPreview.value = null;
  importTxtContent.value = '';
}

async function doImport() {
  if (!importFile.value) { ElMessage.warning('请选择 TXT 文件'); return; }
  if (!importTitle.value.trim()) { ElMessage.warning('请填写作品标题'); return; }
  if (importFile.value.size > 5 * 1024 * 1024) { ElMessage.warning('文件过大，请控制在 5MB 以内'); return; }
  importing.value = true;
  try {
    const text = await readTxtFile(importFile.value);
    importTxtContent.value = text;
    const data = await api.importTxtPreview({ content: text });
    importPreview.value = data;
  } catch (e) {
    importPreview.value = null;
    ElMessage.error(e.message || '解析失败');
  } finally {
    importing.value = false;
  }
}

async function confirmImport() {
  if (!importTxtContent.value) return;
  importing.value = true;
  try {
    const data = await api.importTxt({ title: importTitle.value.trim(), content: importTxtContent.value });
    importResult.value = data;
    importPreview.value = null;
  } catch (e) {
    ElMessage.error(e.message || '导入失败');
  } finally {
    importing.value = false;
  }
}

function backToPreview() {
  importResult.value = null;
  importPreview.value = null;
  importTxtContent.value = '';
}

function finishImport() {
  const novel = importResult.value?.novel;
  if (novel) {
    importOpen.value = false;
    importResult.value = null;
    importPreview.value = null;
    importTxtContent.value = '';
    importFile.value = null;
    importTitle.value = '';
    router.push(`/novel/${novel.id}`);
  }
}

const form = ref({
  title: '',
  genre: ['玄幻'],
  stylePresets: [],
  concept: '',
  chapterWordCount: 2000,
  targetChapters: 20,
  knowledgeCorpusIds: []
});

const availableKnowledge = ref([]);
const knowledgeLoading = ref(false);

async function loadKnowledgeForGenres() {
  const genres = form.value.genre;
  if (!genres || !genres.length) {
    availableKnowledge.value = [];
    return;
  }
  knowledgeLoading.value = true;
  try {
    availableKnowledge.value = await api.listKnowledgeByGenres(genres.join(','));
  } catch {
    availableKnowledge.value = [];
  } finally {
    knowledgeLoading.value = false;
  }
}

function toggleKnowledge(id) {
  const cur = form.value.knowledgeCorpusIds;
  form.value.knowledgeCorpusIds = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
}

const coverColors = AVATAR_COLORS;

function chapterProgress(n) {
  const t = Number(n.target_chapters);
  if (!t || t <= 0) return 0;
  return Math.min(100, Math.round(((n.chapter_count || 0) / t) * 100));
}

function toggleStyle(s) {
  const cur = form.value.stylePresets;
  form.value.stylePresets = cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s];
}

async function load() {
  loading.value = true;
  try {
    novels.value = await api.listNovels();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function createNovel() {
  if (!form.value.title.trim()) {
    ElMessage.warning('请填写作品标题');
    return;
  }
  saving.value = true;
  try {
    const novel = await api.createNovel({
      ...form.value,
      genre: form.value.genre.join(','),
      stylePresets: form.value.stylePresets,
      knowledgeCorpusIds: form.value.knowledgeCorpusIds,
      cover_color: coverColors[Math.floor(Math.random() * coverColors.length)]
    });
    dialogOpen.value = false;
    form.value = { title: '', genre: ['玄幻'], stylePresets: [], concept: '', chapterWordCount: 2000, targetChapters: 20, knowledgeCorpusIds: [] };
    availableKnowledge.value = [];
    router.push(`/novel/${novel.id}`);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function removeNovel(novel) {
  try {
    await ElMessageBox.confirm(
      `删除《${novel.title || '未命名'}》后，其所有章节、角色与对话记录将一并删除，且不可恢复。确定删除吗？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  try {
    await api.deleteNovel(novel.id);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

onMounted(() => { load(); pollJobs(); startJobStream(); });
watch(() => form.value.genre, () => loadKnowledgeForGenres(), { deep: true });
onBeforeUnmount(() => { if (jobsTimer) clearInterval(jobsTimer); if (jobStream) { try { jobStream.close(); } catch {} jobStream = null; } });
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">我的书架</h2>
        <p class="page-sub">所有作品保存在本地；每本小说拥有独立的世界观、角色、章节与记忆，互不干扰，点击即可继续创作</p>
      </div>
      <div class="head-actions">
        <el-button size="large" plain @click="router.push('/shared-characters')">
          <el-icon style="margin-right:6px"><UserFilled /></el-icon>共享角色池
        </el-button>
        <el-button size="large" plain @click="openImport">
          <el-icon style="margin-right:6px"><Upload /></el-icon>导入 TXT
        </el-button>
        <el-button type="primary" size="large" @click="dialogOpen = true">
          <el-icon style="margin-right:6px"><Plus /></el-icon>新建小说
        </el-button>
      </div>
    </div>

    <div v-loading="loading" class="novel-grid" :style="{ minHeight: loading ? '200px' : 'auto' }">
      <el-empty v-if="!loading && !novels.length" description="书架空空如也，创建你的第一部作品吧">
        <el-button type="primary" @click="dialogOpen = true">开始创作</el-button>
      </el-empty>

      <div
        v-for="n in novels"
        :key="n.id"
        class="novel-card"
        @click="router.push(`/novel/${n.id}`)"
      >
        <div class="cover" :style="{ background: n.cover_color || '#6366f1' }">
          <div v-if="jobLabel(n.id)" class="job-badge">{{ jobLabel(n.id) }}</div>
          <div class="cover-title">{{ n.title || '未命名' }}</div>
          <div class="cover-genre">{{ splitGenres(n.genre).join('、') || '未分类' }}</div>
          <div class="cover-deco"></div>
        </div>
          <div class="card-body">
            <div class="card-stats">
              <div class="stat">
                <div class="stat-num">{{ n.chapter_count }}</div>
                <div class="stat-label">章节</div>
              </div>
              <div class="stat">
                <div class="stat-num">{{ formatWords(n.total_words) }}</div>
                <div class="stat-label">总字数</div>
              </div>
              <div class="stat">
                <div class="stat-num">{{ n.character_count }}</div>
                <div class="stat-label">角色</div>
              </div>
            </div>
            <div v-if="n.style_presets?.length" class="preset-tags">
              <span v-for="s in n.style_presets.slice(0, 3)" :key="s" class="preset-tag">{{ s }}</span>
              <span v-if="n.style_presets.length > 3" class="preset-more">+{{ n.style_presets.length - 3 }}</span>
            </div>
            <div class="progress-wrap">
              <div class="progress-bar" :style="{ width: chapterProgress(n) + '%' }"></div>
            </div>
            <div class="progress-meta">
              <span class="progress-text">
                {{ n.target_chapters ? `已写 ${n.chapter_count} / ${n.target_chapters} 章 · ${chapterProgress(n)}%` : '章节规划未生成' }}
              </span>
            </div>
            <div class="card-meta">
              <el-tag :type="(STATUS_MAP[n.status] || STATUS_MAP.draft).type" size="small" effect="light">
                {{ (STATUS_MAP[n.status] || STATUS_MAP.draft).text }}
              </el-tag>
              <span class="update-time">更新于 {{ formatDate(n.updated_at) }}</span>
            </div>
          </div>
          <div class="enter-btn" :class="{ 'has-content': (n.chapter_count || 0) > 0 }">
            {{ (n.chapter_count || 0) > 0 ? '继续创作' : '开始创作' }}
          </div>
        <div class="card-actions">
          <el-button link type="danger" size="small" @click.stop="removeNovel(n)">
            <el-icon><Delete /></el-icon>删除
          </el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="dialogOpen" title="新建小说" width="560px" :close-on-click-modal="false">
      <el-form :model="form" label-width="100px">
        <el-form-item label="作品标题" required>
          <el-input v-model="form.title" placeholder="给作品起一个名字" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="小说类型（可多选）">
          <el-checkbox-group v-model="form.genre" class="check-grid">
            <el-checkbox v-for="g in GENRES" :key="g" :value="g" class="check-item">{{ g }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="创作风格（可多选）">
          <div class="style-target">
            <div v-if="!form.stylePresets.length" class="style-target-empty">点击下方风格标签选择，可多选融合多种文风</div>
            <span v-for="s in form.stylePresets" :key="s" class="style-pill">{{ s }}<i class="x" @click.stop="form.stylePresets = form.stylePresets.filter(x=>x!==s)">×</i></span>
          </div>
          <div class="style-source">
            <span
              v-for="s in PRESET_STYLES"
              :key="s"
              class="style-tag"
              :class="{ active: form.stylePresets.includes(s) }"
              @click="toggleStyle(s)"
            >{{ s }}</span>
          </div>
        </el-form-item>
        <el-form-item label="知识学习库">
          <div class="knowledge-section">
            <div v-if="knowledgeLoading" class="knowledge-loading">
              <el-icon class="is-loading"><Loading /></el-icon>
              正在加载匹配的知识库…
            </div>
            <template v-if="availableKnowledge.length">
              <div class="knowledge-hint">以下是与所选题材匹配的已学习知识库，勾选后 AI 会参考其文笔/剧情/逻辑进行创作：</div>
              <div class="knowledge-list">
                <div
                  v-for="k in availableKnowledge"
                  :key="k.id"
                  class="knowledge-tag"
                  :class="{ active: form.knowledgeCorpusIds.includes(k.id) }"
                  @click="toggleKnowledge(k.id)"
                >
                  <el-icon v-if="form.knowledgeCorpusIds.includes(k.id)" class="check-icon"><CircleCheck /></el-icon>
                  {{ k.title }}
                  <span class="k-genre">{{ k.genre }}</span>
                </div>
              </div>
            </template>
            <div v-if="!knowledgeLoading && !availableKnowledge.length" class="knowledge-empty">
              暂无匹配的知识库。
              <el-link type="primary" @click="router.push('/knowledge')">前往知识学习库导入</el-link>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="灵感想法">
          <el-input
            v-model="form.concept"
            type="textarea"
            :rows="4"
            placeholder="一句话或一段话描述你的想法，例如：一个少年在废土末世觉醒空间异能，靠着收集物资和建造避难所，一步步重建文明…"
          />
        </el-form-item>
        <el-form-item label="每章字数">
          <el-slider
            v-model="form.chapterWordCount"
            :min="500" :max="8000" :step="500"
            show-input
            :format-tooltip="(v) => v + ' 字'"
          />
        </el-form-item>
        <el-form-item>
          <template #label>
            全本总章数
            <el-tooltip content="决定全书共多少章。AI 会先一次性规划完整分章大纲（含每章标题与梗概），之后逐章生成正文。可在创作过程中重新生成方案来调整。" placement="top">
              <el-icon class="field-help"><QuestionFilled /></el-icon>
            </el-tooltip>
          </template>
          <el-input-number v-model="form.targetChapters" :min="1" :max="2000" />
          <span class="tip-text">这是整部小说的总章数，AI 会先规划全本大纲再逐章创作</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="createNovel">创建并开始创作</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importOpen" title="导入 TXT 开始改编" width="620px" :close-on-click-modal="false">
      <!-- 第 1 步：填写标题 + 选择文件 -->
      <div v-if="!importResult && !importPreview" class="import-body">
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
                <div class="el-upload__tip">支持 UTF-8 / GBK 等常见编码的 .txt 全文小说，单文件 ≤ 5MB。选好文件后先预览拆分结果，确认后再正式导入。</div>
              </template>
            </el-upload>
          </el-form-item>
        </el-form>
      </div>

      <!-- 第 2 步：预览拆分结果 -->
      <div v-else-if="importPreview && !importResult" class="import-preview">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          :title="`解析到 ${importPreview.total || 0} 个章节，共约 ${(importPreview.total_words / 10000).toFixed(1)} 万字${importPreview.splitted ? '（部分无标题段落已自动分段）' : ''}`"
        />
        <div class="import-preview-list" v-loading="importing">
          <div v-for="c in importPreview.chapters" :key="c.index" class="import-preview-item">
            <span class="ip-idx">#{{ c.index }}</span>
            <span class="ip-title">{{ c.title }}</span>
            <span class="ip-words">{{ c.word_count }} 字</span>
            <span class="ip-head">{{ c.content_head }}</span>
          </div>
        </div>
        <div class="import-preview-hint">确认拆分无误后点击「开始导入」，将创建一本新书并写入全部章节，之后可在详情页进行整本改编。</div>
      </div>

      <!-- 第 3 步：导入成功 -->
      <div v-else class="import-result">
        <el-result
          icon="success"
          :title="`已导入《${importResult.novel?.title || ''}》`"
          :sub-title="`成功拆分 ${importResult.imported || 0} 个章节${importResult.splitted ? '（含无标题段落自动分段）' : ''}，可在详情页对该书进行整本改编`"
        >
          <template #extra>
            <el-button type="primary" @click="finishImport">进入改编</el-button>
          </template>
        </el-result>
      </div>

      <template #footer v-if="!importResult">
        <template v-if="!importPreview">
          <el-button @click="importOpen = false">取消</el-button>
          <el-button type="primary" :loading="importing" :disabled="!importFile || !importTitle.trim()" @click="doImport">解析预览</el-button>
        </template>
        <template v-else>
          <el-button @click="backToPreview">重新选择</el-button>
          <el-button type="primary" :loading="importing" @click="confirmImport">开始导入</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}
.head-actions { display: flex; gap: 8px; align-items: center; }
.import-body { padding: 4px 8px; }
.import-preview { padding: 4px 8px; }
.import-preview-list {
  margin-top: 12px;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #e5e7f0;
  border-radius: 8px;
}
.import-preview-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #f1f3f9;
  font-size: 12.5px;
}
.import-preview-item:last-child { border-bottom: none; }
.ip-idx { color: #4f46e5; font-weight: 600; flex-shrink: 0; min-width: 34px; }
.ip-title { font-weight: 600; color: #1e1b4b; flex-shrink: 0; }
.ip-words { color: #9ca3af; flex-shrink: 0; }
.ip-head { color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.import-preview-hint {
  margin-top: 12px;
  font-size: 12px;
  color: #6b7280;
  line-height: 1.7;
  background: #fafbff;
  border: 1px dashed #c7d2fe;
  border-radius: 8px;
  padding: 10px 12px;
}
.import-result :deep(.el-result__title) { font-size: 18px; }
.import-result :deep(.el-result__subtitle) { line-height: 1.7; padding: 0 12px; }
.page-title { margin: 0; font-size: 24px; font-weight: 700; }
.page-sub { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.novel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 18px;
}
.novel-card {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(20,24,80,.08);
  cursor: pointer;
  transition: transform .15s, box-shadow .15s;
  position: relative;
}
.novel-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 20px rgba(20,24,80,.12);
}
.cover {
  height: 130px;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 12px;
}
.cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.15), transparent 60%);
}
.job-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  padding: 2px 8px;
  background: rgba(255,255,255,0.9);
  color: #4f46e5;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.15);
  display: flex;
  align-items: center;
  gap: 4px;
}
.job-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4f46e5;
  animation: job-pulse 1.2s infinite;
}
@keyframes job-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.cover-title {
  position: relative;
  z-index: 1;
  color: #fff;
  font-size: 17px;
  font-weight: 700;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0,0,0,.3);
}
.cover-genre {
  position: relative;
  z-index: 1;
  margin-top: 6px;
  color: rgba(255,255,255,.85);
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid rgba(255,255,255,.5);
  border-radius: 20px;
}
.card-body { padding: 14px 16px 12px; }
.card-stats { display: flex; margin-bottom: 10px; }
.stat { flex: 1; }
.stat-num { font-size: 16px; font-weight: 700; color: #1f2937; }
.stat-label { font-size: 12px; color: #9ca3af; margin-top: 2px; }
.progress-wrap {
  height: 6px;
  background: #eef0f6;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 6px;
}
.progress-bar {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #6366f1, #8b5cf6);
  transition: width .3s;
}
.progress-meta { margin-bottom: 10px; }
.progress-text { font-size: 11px; color: #9ca3af; }
.card-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.update-time { font-size: 11px; color: #9ca3af; }
.card-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  opacity: 0;
  transition: opacity .15s;
  background: rgba(0,0,0,.35);
  border-radius: 8px;
}
.novel-card:hover .card-actions { opacity: 1; }
.card-actions :deep(.el-button) { color: #fff; }
.tip-text { margin-left: 10px; color: #9ca3af; font-size: 12px; }
.field-help {
  color: #c0c4dd;
  cursor: help;
  vertical-align: middle;
  margin-left: 4px;
}
.field-help:hover { color: #6366f1; }
.check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(105px, 1fr));
  gap: 4px 10px;
  width: 100%;
}
.check-item { margin-right: 0; min-width: 0; }
.check-item :deep(.el-checkbox__label) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.preset-tag {
  font-size: 11px;
  color: #6366f1;
  background: #eef2ff;
  border-radius: 999px;
  padding: 1px 8px;
}
.preset-more { font-size: 11px; color: #9ca3af; }
.enter-btn {
  padding: 8px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: #8b5cf6;
  background: #f5f3ff;
  border-top: 1px solid #f0edfb;
  transition: background .15s;
}
.enter-btn.has-content { color: #fff; background: linear-gradient(90deg, #6366f1, #8b5cf6); }
.novel-card:hover .enter-btn { filter: brightness(1.05); }
.style-target {
  min-height: 32px;
  width: 100%;
  border: 1px dashed #c7d2fe;
  border-radius: 8px;
  padding: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  background: #fafaff;
}
.style-target-empty { color: #9ca3af; font-size: 12px; padding: 2px 4px; }
.style-pill {
  background: #6366f1;
  color: #fff;
  font-size: 12px;
  border-radius: 999px;
  padding: 2px 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.style-pill .x { cursor: pointer; font-style: normal; opacity: .8; }
.style-pill .x:hover { opacity: 1; }
.style-source {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  max-height: 130px;
  overflow-y: auto;
  align-content: flex-start;
}
.style-tag {
  flex-shrink: 0;
  font-size: 12px;
  color: #6b7280;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  padding: 2px 10px;
  cursor: pointer;
  transition: all .15s;
  user-select: none;
}
.style-tag:hover { border-color: #6366f1; color: #6366f1; }
.style-tag.active {
  background: #6366f1;
  border-color: #6366f1;
  color: #fff;
}
.knowledge-section { width: 100%; }
.knowledge-loading { display: flex; align-items: center; gap: 6px; color: #9ca3af; font-size: 12px; padding: 4px 0; }
.knowledge-hint { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
.knowledge-list { display: flex; flex-wrap: wrap; gap: 8px; }
.knowledge-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: #374151;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 4px 12px;
  cursor: pointer;
  transition: all .15s;
  user-select: none;
}
.knowledge-tag:hover { border-color: #059669; color: #059669; }
.knowledge-tag.active {
  background: #ecfdf5;
  border-color: #059669;
  color: #059669;
  font-weight: 600;
}
.knowledge-tag .check-icon { color: #059669; }
.knowledge-tag .k-genre { font-size: 10px; color: #9ca3af; margin-left: 4px; }
.knowledge-tag.active .k-genre { color: #059669; opacity: .7; }
.knowledge-empty { font-size: 12px; color: #9ca3af; }
</style>
