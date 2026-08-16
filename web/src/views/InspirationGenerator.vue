<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { GENRES, PRESET_STYLES } from '../utils/format';

defineOptions({ name: 'InspirationGenerator' });

const router = useRouter();

const genres = ref(['玄幻']);
const stylePresets = ref([]);
const styleIds = ref([]);
const styleLibrary = ref([]);
const styleLibsLoading = ref(false);
const generating = ref(false);
const statusText = ref('');
const ideas = ref([]);
const selectedId = ref(null);
const creating = ref(false);
const askOpen = ref(false);
const askAction = ref(null); // null | 'direct' | 'adjust'
const adjustOpen = ref(false);
const adjustForm = ref({ title: '', genre: '', logline: '', hook: '', concept: '', protagonistName: '', goldenFinger: '' });
const adjustSaving = ref(false);

const selectedIdea = computed(() => ideas.value.find((it) => it.id === selectedId.value) || null);

function toggleGenre(g) {
  const cur = genres.value;
  genres.value = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
}
function togglePreset(s) {
  const cur = stylePresets.value;
  stylePresets.value = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
}
function toggleStyleLib(id) {
  const cur = styleIds.value;
  styleIds.value = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

function regenEnabled() {
  return !generating.value && !!styleLibsLoading === false && (ideas.value.length || selectedId.value);
}

async function loadStyleLibrary() {
  styleLibsLoading.value = true;
  try {
    styleLibrary.value = await api.listStyles();
  } catch {
    styleLibrary.value = [];
  } finally {
    styleLibsLoading.value = false;
  }
}

async function generate() {
  if (!genres.value.length) return ElMessage.warning('请至少选择一个小说题材');
  if (generating.value) return;
  generating.value = true;
  statusText.value = '';
  ideas.value = [];
  selectedId.value = null;
  try {
    const data = await api.generateIdeas({
      genres: genres.value,
      stylePresets: stylePresets.value,
      styleIds: styleIds.value,
      count: 3
    }, {
      onStatus: (m) => { statusText.value = m; },
      onError: (m) => { if (m) ElMessage.error(m); }
    });
    ideas.value = (data?.ideas || []).map((it) => ({ ...it, expanded: false }));
    if (!ideas.value.length) ElMessage.info('本次没有生成到创意，请换个题材组合再试');
    statusText.value = '';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    generating.value = false;
  }
}

// 选中创意后：询问是否需要调整，再决定直接生成方案还是先进调整
function onPickIdea(it) {
  selectedId.value = it.id;
  askOpen.value = true;
  askAction.value = null;
}

function cancelAsk() { askOpen.value = false; askAction.value = null; }

function chooseDirect() {
  askAction.value = 'direct';
  cancelAsk();
  createFromIdea(selectedId.value);
}

function chooseAdjust() {
  askAction.value = 'adjust';
  const it = selectedIdea.value;
  if (!it) { cancelAsk(); return; }
  adjustForm.value = {
    title: it.title || '',
    genre: it.genre || genres.value[0] || '玄幻',
    logline: it.logline || '',
    hook: it.hook || '',
    concept: `${it.logline || ''}${it.hook ? `（开篇钩子：${it.hook}）` : ''}`,
    protagonistName: it.protagonist?.name || '',
    goldenFinger: it.protagonist?.golden_finger || ''
  };
  cancelAsk();
  adjustOpen.value = true;
}

async function confirmAdjust() {
  if (!adjustForm.value.title.trim()) return ElMessage.warning('请填写作品标题');
  if (adjustSaving.value) return;
  adjustSaving.value = true;
  try {
    const concept = adjustForm.value.concept.trim() ||
      `${adjustForm.value.logline || ''}${adjustForm.value.hook ? `（开篇钩子：${adjustForm.value.hook}）` : ''}`;
    const idea = { title: adjustForm.value.title, genre: adjustForm.value.genre, logline: adjustForm.value.logline, hook: adjustForm.value.hook, protagonist: { name: adjustForm.value.protagonistName, golden_finger: adjustForm.value.goldenFinger } };
    adjustOpen.value = false;
    await buildNovelFromIdea(idea, concept);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    adjustSaving.value = false;
  }
}

async function createFromIdea(id) {
  const it = ideas.value.find((x) => x.id === id);
  if (!it) return;
  const concept = `${it.logline || ''}${it.hook ? `（开篇钩子：${it.hook}）` : ''}`;
  await buildNovelFromIdea(it, concept);
}

async function buildNovelFromIdea(idea, concept) {
  if (creating.value) return;
  creating.value = true;
  try {
    const novel = await api.createNovel({
      title: idea.title,
      genre: idea.genre || genres.value[0] || '玄幻',
      concept,
      chapterWordCount: 2000,
      targetChapters: 20,
      stylePresets: stylePresets.value,
      styleIds: styleIds.value
    });
    ElMessage.success(`已创建《${idea.title}》，进入创作方案生成…`);
    router.push(`/novel/${novel.id}`);
  } catch (e) {
    ElMessage.error(e.message);
    creating.value = false;
  }
}

onMounted(loadStyleLibrary);
</script>

<template>
  <div class="idea-page">
    <div class="page-head">
      <div>
        <h2 class="page-title">灵感生成器</h2>
        <p class="page-sub">还没有灵感？选好题材与风格，AI 会批量产出数个可直接开写的小说创意，挑一个顺眼的就开写</p>
      </div>
      <el-button size="large" text @click="router.push('/')">← 返回书架</el-button>
    </div>

    <div class="card idea-config">
      <el-form label-width="110px" label-position="top">
        <el-form-item label="选择题材（可多选）">
          <el-checkbox-group v-model="genres" class="check-grid">
            <el-checkbox v-for="g in GENRES" :key="g" :value="g" class="check-item">{{ g }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="期望风格基调（可多选）">
          <div class="style-source">
            <span
              v-for="s in PRESET_STYLES"
              :key="s"
              class="style-tag"
              :class="{ active: stylePresets.includes(s) }"
              @click="togglePreset(s)"
            >{{ s }}</span>
          </div>
        </el-form-item>
        <el-form-item v-if="!styleLibsLoading && styleLibrary.length" label="风格库作者文风（可多选）">
          <div class="style-source">
            <span
              v-for="s in styleLibrary"
              :key="s.id"
              class="style-tag"
              :class="{ active: styleIds.includes(s.id) }"
              @click="toggleStyleLib(s.id)"
            >{{ s.name }}</span>
          </div>
        </el-form-item>
        <el-form-item>
          <div class="gen-actions">
            <el-button type="primary" size="large" :loading="generating" @click="generate">
              <el-icon style="margin-right: 6px"><MagicStick /></el-icon>
              {{ generating ? '构思中…' : (ideas.length ? '重新生成（换一批创意）' : '批量生成创意') }}
            </el-button>
            <span class="gen-hint">每次生成 3 个创意，不满意就重新生成，直到你满意为止</span>
          </div>
          <div v-if="generating" class="idea-progress">
            <el-progress :percentage="99" :stroke-width="6" :show-text="false" :indeterminate="true" :duration="3" />
            <span class="idea-progress-text">{{ statusText || 'AI 正在构思创意…' }}</span>
          </div>
          <div v-else-if="statusText" class="idea-status">{{ statusText }}</div>
        </el-form-item>
      </el-form>
    </div>

    <div v-if="ideas.length" class="idea-list">
      <div class="idea-section-title">为你生成的 {{ ideas.length }} 个创意（点击卡片预览详情）</div>
      <div
        v-for="it in ideas"
        :key="it.id"
        class="idea-card"
        :class="{ selected: selectedId === it.id, expanded: it.expanded }"
        @click="onPickIdea(it)"
      >
        <div class="idea-card-top">
          <span class="idea-genre">{{ it.genre }}</span>
          <span class="idea-title">{{ it.title }}</span>
          <span v-if="it.hook" class="idea-hook-label">钩子</span>
        </div>
        <div class="idea-logline">{{ it.logline }}</div>
        <div class="idea-hook">开篇钩子：{{ it.hook }}</div>
        <el-button
          text type="primary" size="small"
          class="idea-toggle"
          @click.stop="it.expanded = !it.expanded"
        >{{ it.expanded ? '收起详情' : '查看详情' }}</el-button>
        <div v-if="it.expanded" class="idea-detail">
          <template v-if="it.protagonist">
            <div class="idea-detail-block">
              <div class="idea-detail-title">主角</div>
              <div>{{ it.protagonist.name || '' }}<span v-if="it.protagonist.identity" class="muted">　{{ it.protagonist.identity }}</span></div>
              <div v-if="it.protagonist.golden_finger">金手指：{{ it.protagonist.golden_finger }}</div>
              <div v-if="it.protagonist.personality">性格：{{ it.protagonist.personality }}</div>
            </div>
          </template>
          <div v-if="it.selling_point && it.selling_point.length" class="idea-detail-block">
            <div class="idea-detail-title">核心卖点</div>
            <div v-for="(sp, i) in it.selling_point" :key="i">{{ sp }}</div>
          </div>
          <div v-if="it.outline_H5 && it.outline_H5.length" class="idea-detail-block">
            <div class="idea-detail-title">前五章大方向</div>
            <div v-for="(o, i) in it.outline_H5" :key="i" class="outline-line">{{ i + 1 }}. {{ o }}</div>
          </div>
          <div v-if="it.potential_risk" class="idea-detail-block">
            <div class="idea-detail-title">市场风险</div>
            <div class="risk-text">{{ it.potential_risk }}</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="selectedId && ideas.some((it) => it.id === selectedId)" class="fix-bottom-bar">
      <div class="fix-bar-inner">
        <el-button size="large" :loading="creating" type="primary" @click="chooseDirect">
          <el-icon style="margin-right: 6px"><MagicStick /></el-icon>
          就用这个创意，生成创作方案
        </el-button>
        <el-button size="large" plain :loading="creating" @click="chooseAdjust">
          <el-icon style="margin-right: 6px"><EditPen /></el-icon>
          先调整一下再生成
        </el-button>
        <span class="fix-bar-tip">可直接生成，也可先微调标题/剧情再生成创作方案</span>
      </div>
    </div>

    <el-dialog v-model="askOpen" title="开始创作" width="520px" :close-on-click-modal="false">
      <div class="ask-body">
        <div class="ask-title">《{{ selectedIdea?.title || '' }}》</div>
        <div class="ask-desc">{{ selectedIdea?.logline || '' }}</div>
        <div class="ask-hint">确定要基于这个创意生成创作方案吗？生成后 AI 会先规划全本大纲（创作方案），再逐章生成正文。</div>
      </div>
      <template #footer>
        <el-button @click="cancelAsk">再想想</el-button>
        <el-button @click="chooseAdjust">先调整一下</el-button>
        <el-button type="primary" :loading="creating" @click="chooseDirect">直接生成创作方案</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="adjustOpen" title="调整你的创意" width="600px" :close-on-click-modal="false" @close="() => { if (!creating) adjustSaving = false; }">
      <el-form :model="adjustForm" label-width="90px">
        <el-form-item label="作品标题" required>
          <el-input v-model="adjustForm.title" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="题材">
          <el-input v-model="adjustForm.genre" maxlength="10" />
        </el-form-item>
        <el-form-item v-if="adjustForm.protagonistName" label="主角名">
          <el-input v-model="adjustForm.protagonistName" maxlength="20" />
        </el-form-item>
        <el-form-item v-if="adjustForm.goldenFinger" label="金手指">
          <el-input v-model="adjustForm.goldenFinger" maxlength="80" />
        </el-form-item>
        <el-form-item label="剧情设定">
          <el-input
            v-model="adjustForm.concept"
            type="textarea"
            :rows="6"
            placeholder="一句话或一段话描述你的故事设定，生成方案时会以此为基础"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustOpen = false">取消</el-button>
        <el-button type="primary" :loading="adjustSaving" @click="confirmAdjust">
          确认调整并生成创作方案
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.idea-page {
  padding: 28px 32px;
  min-height: 100vh;
  background: #f7f8fc;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  max-width: 1080px;
  margin: 0 auto 20px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
  color: #1e1b4b;
  margin: 0 0 6px;
}
.page-sub {
  font-size: 13.5px;
  color: #6b7280;
  margin: 0;
}
.card {
  max-width: 1080px;
  margin: 0 auto 20px;
  background: #fff;
  border: 1px solid #eef0f6;
  border-radius: 12px;
  padding: 20px 24px;
}
.idea-config :deep(.el-form-item) {
  margin-bottom: 16px;
}
.check-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 2px;
}
.check-item {
  margin-right: 14px;
  margin-bottom: 4px;
}
.style-source {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.style-tag {
  padding: 4px 12px;
  border: 1px solid #e0e3ef;
  border-radius: 16px;
  font-size: 12.5px;
  color: #4b5563;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}
.style-tag.active {
  background: #4f46e5;
  color: #fff;
  border-color: #4f46e5;
}
.idea-status {
  margin-top: 10px;
  font-size: 13px;
  color: #6b7280;
}
.idea-list {
  max-width: 1080px;
  margin: 0 auto;
}
.idea-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 12px;
}
.idea-card {
  background: #fff;
  border: 1px solid #eef0f6;
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.idea-card:hover {
  border-color: #c7d2fe;
  box-shadow: 0 2px 12px rgba(79, 70, 229, 0.08);
}
.idea-card.selected {
  border-color: #4f46e5;
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
}
.idea-card.selected .idea-title::after {
  content: ' ✓';
  color: #4f46e5;
}
.idea-card-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.idea-genre {
  font-size: 12px;
  color: #4f46e5;
  background: #eef0ff;
  border-radius: 6px;
  padding: 2px 8px;
  font-weight: 600;
}
.idea-title {
  font-size: 17px;
  font-weight: 700;
  color: #1e1b4b;
}
.idea-hook-label {
  font-size: 11px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 6px;
  padding: 2px 6px;
}
.idea-logline {
  font-size: 13.5px;
  color: #374151;
  line-height: 1.7;
  margin-bottom: 6px;
}
.idea-hook {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.6;
  margin-bottom: 6px;
}
.idea-toggle {
  margin-top: 4px;
}
.idea-detail {
  border-top: 1px solid #f1f2f8;
  margin-top: 10px;
  padding-top: 12px;
}
.idea-detail-block {
  margin-bottom: 10px;
}
.idea-detail-title {
  font-size: 13px;
  font-weight: 700;
  color: #1e1b4b;
  margin-bottom: 4px;
}
.muted { color: #6b7280; }
.outline-line { font-size: 13px; color: #4b5563; line-height: 1.6; }
.risk-text { font-size: 13px; color: #b45309; }
.fix-bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  border-top: 1px solid #eef0f6;
  padding: 12px 24px;
  z-index: 20;
  backdrop-filter: blur(6px);
}
.fix-bar-inner {
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
}
.fix-bar-tip { font-size: 13px; color: #6b7280; }
.gen-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}
.gen-hint {
  font-size: 12.5px;
  color: #9ca3af;
}
.ask-body {
  padding: 4px 6px;
}
.ask-title {
  font-size: 18px;
  font-weight: 700;
  color: #1e1b4b;
  margin-bottom: 8px;
}
.ask-desc {
  font-size: 14px;
  color: #374151;
  line-height: 1.7;
  margin-bottom: 10px;
}
.ask-hint {
  font-size: 13px;
  color: #6b7280;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  padding: 10px 12px;
}
.idea-progress {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 12px;
  width: 100%;
}
.idea-progress-text {
  font-size: 13px;
  color: #6b7280;
}
</style>