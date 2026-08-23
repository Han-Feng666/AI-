<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getGenDraft, getGenDraftMeta, clearGenDraft } from '../utils/format';
import { useEditorStore } from '../stores/editor';
import { useSettingsStore } from '../stores/settings';
import NavBar from '../components/NavBar.vue';
import ChapterList from '../components/ChapterList.vue';
import ChapterArea from '../components/ChapterArea.vue';
import ChatPanel from '../components/ChatPanel.vue';
import SetupPanel from '../components/SetupPanel.vue';
import CharacterPanel from '../components/CharacterPanel.vue';
import FactionPanel from '../components/FactionPanel.vue';
import WorldSettingsPanel from '../components/WorldSettingsPanel.vue';
import ForeshadowPanel from '../components/ForeshadowPanel.vue';
import RelationshipPanel from '../components/RelationshipPanel.vue';
import StylePanel from '../components/StylePanel.vue';
import SkillsPanel from '../components/SkillsPanel.vue';
import OutlinePanel from '../components/OutlinePanel.vue';
import StatsPanel from '../components/StatsPanel.vue';
import AdaptDialog from '../components/AdaptDialog.vue';
import api from '../api';
import { copyText, downloadText, formatWords, splitGenres } from '../utils/format';

const route = useRoute();
const router = useRouter();
const store = useEditorStore();
const settings = useSettingsStore();
const chatCollapsed = ref(false);
const leftCollapsed = ref(false);

const novelId = computed(() => Number(route.params.id));
const totalWords = computed(() => store.totalWords);
const hasLLM = computed(() => settings.isConfigured);

// 上下文估算：当前生成一章时注入模型的记忆量（字符数）
const contextChars = computed(() => {
  if (!store.novel) return 0;
  if (store.novel.context_compressed) return store.novel.compressed_context?.length || 0;
  const recent = store.chapters.filter((c) => c.word_count).slice(-3);
  const wc = recent.reduce((s, c) => s + (c.word_count || 0), 0);
  return wc + 8000;
});

// 生成完成询问弹窗
const askOpen = ref(false);
const askData = ref(null);

// 文风基准
const baselineOpen = ref(false);
const baselineForm = ref({ text: '' });
const extracting = ref(false);

function openBaseline() {
  baselineForm.value = { text: store.novel?.style_baseline || '' };
  baselineOpen.value = true;
}

async function saveBaseline() {
  try {
    await store.saveNovelSettings({ style_baseline: baselineForm.value.text.trim() });
    baselineOpen.value = false;
    ElMessage.success('文风基准已保存，生成与润色都会遵循');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function extractBaseline() {
  if (extracting.value) return;
  extracting.value = true;
  try {
    const r = await api.extractStyle(novelId.value);
    baselineForm.value.text = r.style_baseline;
    ElMessage.success('已从已写章节提炼文风基准');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    extracting.value = false;
  }
}

async function copyFolderPath() {
  const p = store.novel?.folder_path;
  if (!p) return ElMessage.warning('作品文件夹尚未创建');
  const ok = await copyText(p);
  ElMessage[ok ? 'success' : 'warning'](ok ? `已复制：${p}` : '复制失败，请手动复制');
}

// 真人文风参照：注入真人作家片段，让生成/润色模仿真人句法节奏
const samplesOpen = ref(false);
const samplesForm = ref({ text: '' });

function openSamples() {
  samplesForm.value = { text: store.novel?.style_samples || '' };
  samplesOpen.value = true;
}

async function saveSamples() {
  try {
    const r = await api.saveStyleSamples(novelId.value, samplesForm.value.text.trim());
    await store.refresh();
    samplesOpen.value = false;
    ElMessage.success('真人文风参照已保存，生成与润色都会模仿其节奏');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// 全书 AI 味走势
const trendOpen = ref(false);
const trendData = ref([]);
const trendLoading = ref(false);

async function openTrend() {
  trendOpen.value = true;
  trendLoading.value = true;
  trendData.value = [];
  try {
    const r = await api.getAiTrend(novelId.value);
    trendData.value = r.points || [];
    if (!trendData.value.length) ElMessage.info('还没有检测记录。生成/润色或点「AI 味检测」后会有每章评分。');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    trendLoading.value = false;
  }
}

function trendCls(score) {
  if (score <= 30) return 'ok';
  if (score <= 60) return 'warn';
  return 'bad';
}

watch(
  () => store.generationAsk,
  (v) => {
    if (v) {
      askData.value = v;
      askOpen.value = true;
    }
  }
);

function closeAsk() {
  askOpen.value = false;
  store.clearGenerationAsk();
}

async function polishAndClose() {
  const ch = askData.value?.chapter;
  closeAsk();
  if (ch) {
    try {
      await store.polishChapter();
      ElMessage.success('已按人类写作风格完成润色');
    } catch (e) {
      ElMessage.error(e.message);
    }
  }
}

function editAndClose() {
  const ch = askData.value?.chapter;
  closeAsk();
  if (ch) {
    store.activeChapter = store.activeChapter || ch;
    store.editContent = store.activeChapter.content || '';
    store.chapterEdit = true;
  }
}

async function compressContext() {
  if (store.busy) return;
  try {
    await store.compressContext();
    ElMessage.success('上下文已压缩，后续生成将使用故事状态简报，显著节省 tokens');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function restoreContext() {
  try {
    await ElMessageBox.confirm(
      '恢复完整上下文后，后续章节生成将重新参考「前情摘要 + 最近章节全文」。确定恢复吗？',
      '恢复完整上下文',
      { type: 'info', confirmButtonText: '恢复', cancelButtonText: '取消' }
    );
  } catch { return; }
  try {
    await store.restoreContext();
    ElMessage.success('已恢复完整上下文');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

onMounted(() => {
  store.switchTo(novelId.value).then(() => { checkGenDraft(); checkAutoAdapt(); }).catch((e) => ElMessage.error(e.message));
  if (!settings.loaded) settings.load();
});

// 同组件内切换到另一 novel 时切 slice（防止两本状态串扰）
watch(novelId, (nid) => {
  if (nid) store.switchTo(nid).then(() => { checkGenDraft(); checkAutoAdapt(); }).catch((e) => ElMessage.error(e.message));
});

// 从导入页跳转而来且带 adapt 标记时，自动打开改编对话框询问怎么改
async function checkAutoAdapt() {
  if (route.query.adapt !== '1') return;
  // 清除标记，避免刷新后重复弹出
  router.replace({ query: { ...route.query, adapt: undefined } });
  if (!store.novelId) return;
  try {
    await store.loadAdaptation();
  } catch (e) { /* 加载失败不阻塞弹窗 */ }
  const job = store.adaptJob;
  // 已有已完成的改编任务则不再打扰
  if (job && (job.status === 'adapting' || job.status === 'done' || job.status === 'plan_ready')) {
    store.adaptDialog = true;
    return;
  }
  try {
    await ElMessageBox.confirm(
      'TXT 解析完成。是否要为这本小说生成改编方案？\n\n你可以描述想怎么改（改节奏、换风格、改结局…），也可以让系统直接生成几个方案供你参考。',
      '整本改编',
      { confirmButtonText: '开始改编', cancelButtonText: '稍后再说', type: 'question', confirmButtonClass: 'el-button--primary' }
    );
    store.adaptDialog = true;
  } catch { /* 用户选择稍后再说，不弹窗 */ }
}

async function checkGenDraft() {
  if (!store.hasGenDraft()) return;
  const meta = getGenDraftMeta(novelId.value);
  const wordCount = meta?.text?.length || 0;
  try {
    await ElMessageBox.confirm(
      `检测到上次生成中断留下的草稿（约 ${wordCount} 字）。恢复后可继续编辑，保存后即为正式章节。`,
      '生成中断恢复',
      { confirmButtonText: '恢复草稿', cancelButtonText: '放弃', type: 'info' }
    );
    const restored = store.resumeGenDraft();
    if (restored) {
      if (restored.overwrite) {
        try {
          await ElMessageBox.confirm(
            `草稿对应的第 ${store.activeChapter.chapter_index} 章已有内容，恢复草稿将覆盖现有内容。确定覆盖吗？`,
            '覆盖已有章节',
            { type: 'warning', confirmButtonText: '覆盖', cancelButtonText: '取消' }
          );
        } catch {
          clearGenDraft(novelId.value);
          store.chapterEdit = false;
          ElMessage.info('已取消恢复，未修改任何章节');
          return;
        }
      }
      ElMessage.success('草稿已恢复，可继续编辑后保存');
    }
  } catch {
    clearGenDraft(novelId.value);
    ElMessage.info('已放弃中断的草稿');
  }
}

async function saveTitle() {
  if (!store.novel) return;
  try {
    await store.saveNovelSettings({ title: store.novel.title });
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function saveWordCount(v) {
  try {
    await store.saveNovelSettings({ chapter_word_count: v });
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function saveChapters(v) {
  try {
    await store.saveNovelSettings({ target_chapters: v });
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function exportNovel() {
  try {
    const text = await api.exportNovel(novelId.value);
    if (!text) {
      ElMessage.info('还没有可导出的内容');
      return;
    }
    const title = store.novel?.title || '未命名';
    downloadText(`${title}.md`, text);
    ElMessage.success('已导出为 Markdown 文件');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function copyAll() {
  try {
    const text = await api.exportNovel(novelId.value);
    const ok = await copyText(text);
    ElMessage[ok ? 'success' : 'warning'](ok ? '全书已复制到剪贴板' : '复制失败');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function deleteNovel() {
  try {
    await ElMessageBox.confirm(`确定删除《${store.novel.title}》吗？全部数据将不可恢复。`, '删除作品', { type: 'warning' });
  } catch { return; }
  try {
    await api.deleteNovel(novelId.value);
    ElMessage.success('已删除');
    router.push('/');
  } catch (e) {
    ElMessage.error('删除失败：' + e.message);
  }
}
</script>

<template>
  <div class="editor-page" v-loading="store.loadingNovel">
    <template v-if="store.novel">
      <!-- 顶部工具栏 -->
      <div class="editor-toolbar">
        <el-button text @click="router.push('/')">
          <el-icon style="margin-right:4px"><Back /></el-icon>书架
        </el-button>

        <div class="tool-title">
          <el-input
            v-model="store.novel.title"
            class="title-input"
            placeholder="作品标题"
            maxlength="40"
            @blur="saveTitle"
          />
          <el-tag v-if="store.novel.genre" size="small" effect="light" color="#eef0ff" class="genre-tag">
            {{ splitGenres(store.novel.genre).join('、') }}
          </el-tag>
        </div>

        <div class="tool-stats">
          <span class="stat-chip" title="全书总字数">
            <el-icon><Document /></el-icon>{{ formatWords(totalWords) }}
          </span>
          <span class="stat-chip" title="已写章节">
            <el-icon><Notebook /></el-icon>{{ store.chapters.filter(c => c.word_count).length }} / {{ store.chapters.length }} 章
          </span>
          <span
            class="stat-chip"
            :class="{ 'ctx-compressed': store.novel.context_compressed }"
            :title="store.novel.context_compressed ? '已启用压缩上下文，点击可恢复' : '当前生成参考的上下文记忆量（前情摘要+最近3章全文）'"
          >
            <el-icon><ScaleToOriginal /></el-icon>
            上下文约 {{ Math.round(contextChars / 1000) }}k 字
            <el-tag v-if="store.novel.context_compressed" size="small" type="success" effect="plain" style="margin-left:2px">已压缩</el-tag>
          </span>
        </div>

        <div class="tool-config">
          <span class="cfg-item">
            <span class="cfg-label">每章</span>
            <el-input-number
              :model-value="store.novel.chapter_word_count"
              :min="500" :max="8000" :step="500"
              size="small"
              controls-position="right"
              @change="saveWordCount"
            />
            <span class="cfg-unit">字</span>
          </span>
        </div>

        <div class="tool-actions">
          <template v-if="store.hasPlanned">
            <el-button
              size="small"
              :loading="extracting"
              title="设置本作文风基准：切换大模型后生成写法保持一致"
              @click="openBaseline"
            >
              <el-icon style="margin-right:4px"><MagicStick /></el-icon>文风基准
              <el-tag v-if="store.novel.style_baseline" size="small" type="success" effect="plain" style="margin-left:4px">已设</el-tag>
            </el-button>
            <el-button
              size="small"
              title="导入真人作家片段作为文风参照，生成与润色模仿其句子节奏，进一步去除 AI 味"
              @click="openSamples"
            >
              <el-icon style="margin-right:4px"><Reading /></el-icon>真人文风
              <el-tag v-if="store.novel.style_samples" size="small" type="success" effect="plain" style="margin-left:4px">已设</el-tag>
            </el-button>
            <el-button
              size="small"
              title="查看每章 AI 味检测评分走势"
              @click="openTrend"
            >
              <el-icon style="margin-right:4px"><TrendCharts /></el-icon>AI 味走势
            </el-button>
            <el-button
              v-if="!store.novel.context_compressed"
              size="small"
              :loading="store.busy"
              :disabled="store.busy"
              title="把已写内容压缩成故事状态简报，之后生成章节用它代替长上下文，节省 tokens"
              @click="compressContext"
            >
              <el-icon style="margin-right:4px"><Compress /></el-icon>{{ store.busy && store.busyLabel.includes('压缩') ? store.busyLabel : '压缩上下文' }}
            </el-button>
            <el-button v-else size="small" @click="restoreContext" title="撤销压缩，恢复完整上下文记忆">
              <el-icon style="margin-right:4px"><Unlock /></el-icon>恢复上下文
            </el-button>
          </template>
          <el-dropdown trigger="click">
            <el-button size="small">
              <el-icon style="margin-right:4px"><Download /></el-icon>导出<el-icon style="margin-left:4px"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="exportNovel">
                  <el-icon><Download /></el-icon>导出 Markdown 文件
                </el-dropdown-item>
                <el-dropdown-item @click="copyAll">
                  <el-icon><CopyDocument /></el-icon>一键复制全书
                </el-dropdown-item>
                <el-dropdown-item divided @click="copyFolderPath">
                  <el-icon><FolderOpened /></el-icon>复制作品文件夹路径
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button size="small" type="danger" plain @click="deleteNovel">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </div>

      <!-- 未配置模型提示 -->
      <div v-if="!hasLLM" class="llm-warning">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="尚未配置大模型 API"
        >
          <template #default>
            <span>在开始创作前，请先前往「模型设置」填入你的 API Key 与模型信息（支持 OpenAI / DeepSeek / Kimi / 通义 / 智谱 / Ollama 等）。</span>
            <el-button size="small" type="warning" style="margin-left:12px" @click="router.push('/settings')">去配置</el-button>
          </template>
        </el-alert>
      </div>

      <!-- 主体三栏：左导航 / 中间工作区 / 右侧 AI 对话 -->
      <div class="editor-body">
        <aside class="left-col" :class="{ collapsed: leftCollapsed }">
          <button class="collapse-btn" @click="leftCollapsed = !leftCollapsed">
            <el-icon><DArrowLeft v-if="!leftCollapsed" /><DArrowRight v-else /></el-icon>
          </button>
          <NavBar v-if="!leftCollapsed" />
        </aside>

        <section class="center-col">
          <template v-if="store.workspace === 'chapters'">
            <div class="chapter-work">
              <ChapterList class="chapter-nav" />
              <ChapterArea class="chapter-view" />
            </div>
          </template>
          <div v-else class="workspace-panel">
            <SetupPanel v-if="store.workspace === 'setup'" />
            <CharacterPanel v-else-if="store.workspace === 'characters'" />
            <FactionPanel v-else-if="store.workspace === 'factions'" />
            <WorldSettingsPanel v-else-if="store.workspace === 'settings'" />
            <ForeshadowPanel v-else-if="store.workspace === 'foreshadowings'" />
            <RelationshipPanel v-else-if="store.workspace === 'relationships'" />
            <StylePanel v-else-if="store.workspace === 'styles'" />
            <SkillsPanel v-else-if="store.workspace === 'skills'" />
            <OutlinePanel v-else-if="store.workspace === 'outline'" />
            <StatsPanel v-else-if="store.workspace === 'stats'" />
          </div>
        </section>

        <aside class="right-col" :class="{ collapsed: chatCollapsed }">
          <button class="collapse-btn right" @click="chatCollapsed = !chatCollapsed">
            <el-icon><DArrowRight v-if="!chatCollapsed" /><DArrowLeft v-else /></el-icon>
          </button>
          <ChatPanel v-if="!chatCollapsed" />
        </aside>
      </div>

      <!-- 生成完成询问弹窗 -->
      <el-dialog v-model="askOpen" width="460px" :close-on-click-modal="false" :show-close="false" class="ask-dialog">
        <div class="ask-body" v-if="askData">
          <div class="ask-icon">
            <el-icon :size="26"><CircleCheck /></el-icon>
          </div>
          <div class="ask-title">本章已完成</div>
          <div class="ask-desc">
            第 {{ askData.chapter.chapter_index }} 章「{{ askData.chapter.title }}」已生成，共 {{ formatWords(askData.chapter.word_count) }}。
            <template v-if="askData.autoPolished">已按设置自动去除 AI 味。</template>
            <template v-else>需要对其做进一步修改吗？</template>
          </div>
          <div class="ask-actions">
            <el-button v-if="!askData.autoPolished" type="primary" size="large" style="width:100%" @click="polishAndClose">
              <el-icon style="margin-right:6px"><MagicStick /></el-icon>去 AI 味润色
            </el-button>
            <el-button v-if="!askData.autoPolished" size="large" style="width:100%" @click="editAndClose">
              <el-icon style="margin-right:6px"><EditPen /></el-icon>手动修改本章
            </el-button>
            <el-button v-if="askData.autoPolished" size="large" style="width:100%" @click="editAndClose">
              <el-icon style="margin-right:6px"><EditPen /></el-icon>手动修改本章
            </el-button>
            <el-button type="success" plain size="large" style="width:100%" @click="closeAsk">
              <el-icon style="margin-right:6px"><Check /></el-icon>{{ askData.autoPolished ? '满意，不用改了' : '不用改了' }}
            </el-button>
          </div>
          <div class="ask-hint">点击「不用改了」后，可随时点击左侧「生成下一章」继续创作</div>
        </div>
      </el-dialog>

      <el-dialog v-model="baselineOpen" title="本作文风基准" width="560px">
        <div class="baseline-tip">
          生成与润色都会遵循此基准。设置后，即使切换大模型（例如 DeepSeek → GPT/Claude），
          写法与语感也会保持一致。可从已写章节一键提炼，也可手动编写。
        </div>
        <el-input
          v-model="baselineForm.text"
          type="textarea"
          :rows="7"
          placeholder="例如：平实白描，短句为主，多用具体细节与动作描写，少抒情议论；对话口语化、有来有往；用感官描写替代心理直述；结尾留余味……"
        />
        <template #footer>
          <el-button :loading="extracting" @click="extractBaseline">
            <el-icon style="margin-right:4px"><MagicStick /></el-icon>从已写章节一键提取
          </el-button>
          <el-button @click="baselineOpen = false">取消</el-button>
          <el-button type="primary" @click="saveBaseline">保存</el-button>
        </template>
      </el-dialog>

      <!-- 真人文风参照 -->
      <el-dialog v-model="samplesOpen" title="真人文风参照" width="560px">
        <div class="baseline-tip">
          粘贴一段真人作家的文字（几十到几百字即可，需来自公版或你拥有版权的文本）。
          生成与润色时会模仿这段文字的句子长短、语气、节奏与叙述口吻，让作品读起来更像真人手笔。
        </div>
        <el-input
          v-model="samplesForm.text"
          type="textarea"
          :rows="8"
          placeholder="例如：\n门前的槐树把影子横在路上。他站在影子里，袖口卷得老高，手腕上有道陈年烫痕。隔壁张家的狗远远叫了两声，又歇了。"
        />
        <template #footer>
          <el-button @click="samplesOpen = false">取消</el-button>
          <el-button type="primary" @click="saveSamples">保存</el-button>
        </template>
      </el-dialog>

      <!-- 全书 AI 味走势 -->
      <el-dialog v-model="trendOpen" title="全书 AI 味走势" width="520px">
        <div v-loading="trendLoading" class="trend-body">
          <div class="trend-tip">每章最近一次检测的综合评分（含 AI 高频词命中加分），30 分以下为合格。</div>
          <div v-if="!trendData.length && !trendLoading" class="trend-empty">暂无检测记录。</div>
          <div v-for="p in trendData" :key="p.chapter_index" class="trend-row">
            <span class="trend-ch">第 {{ p.chapter_index }} 章</span>
            <div class="trend-bar-wrap">
              <div class="trend-bar" :class="trendCls(p.score)" :style="{ width: Math.max(4, p.score) + '%' }"></div>
            </div>
            <span class="trend-score" :class="trendCls(p.score)">{{ p.score }} 分</span>
          </div>
        </div>
      </el-dialog>

      <AdaptDialog />
    </template>
  </div>
</template>

<style scoped>
.editor-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.editor-toolbar {
  background: #fff;
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
  flex-shrink: 0;
}
.tool-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.title-input { max-width: 300px; }
.title-input :deep(.el-input__wrapper) {
  background: transparent;
  box-shadow: none;
  font-size: 16px;
  font-weight: 700;
  color: #1e1b4b;
}
.tool-stats { display: flex; gap: 8px; }
.stat-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #6b7280;
  background: #f5f6fd;
  padding: 4px 10px;
  border-radius: 16px;
}
.tool-config .cfg-item { display: flex; align-items: center; gap: 6px; }
.cfg-label { font-size: 12px; color: #9ca3af; }
.cfg-unit { font-size: 12px; color: #9ca3af; }
.tool-actions { display: flex; gap: 8px; align-items: center; }
.llm-warning { flex-shrink: 0; }
.editor-body {
  flex: 1;
  display: flex;
  gap: 12px;
  min-height: 0;
}
.left-col {
  width: 92px;
  flex-shrink: 0;
  position: relative;
  transition: width .2s;
  height: 100%;
  overflow: hidden;
}
.left-col.collapsed { width: 8px; overflow: visible; }
.center-col {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.chapter-work {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  gap: 12px;
}
.chapter-nav {
  width: 280px;
  flex-shrink: 0;
  min-height: 0;
}
.chapter-view {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.workspace-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
  overflow: hidden;
}
.workspace-panel > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.right-col {
  width: 360px;
  flex-shrink: 0;
  position: relative;
  transition: width .2s;
  height: 100%;
  overflow: hidden;
}
.right-col.collapsed { width: 8px; overflow: visible; }
.collapse-btn {
  position: absolute;
  top: 10px;
  right: -12px;
  z-index: 10;
  width: 24px;
  height: 40px;
  border: none;
  border-radius: 0 8px 8px 0;
  background: #e5e7f0;
  color: #4f46e5;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: .85;
}
.collapse-btn.right {
  right: auto;
  left: -12px;
  border-radius: 8px 0 0 8px;
}
.collapse-btn:hover { opacity: 1; }
.stat-chip.ctx-compressed {
  background: #ecfdf5;
  color: #047857;
  cursor: pointer;
}
.ask-body { text-align: center; padding: 6px 10px 2px; }
.ask-icon {
  width: 56px; height: 56px;
  margin: 0 auto 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, #d1fae5, #a7f3d0);
  color: #059669;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ask-title { font-size: 19px; font-weight: 700; color: #1e1b4b; margin-bottom: 8px; }
.ask-desc { font-size: 13.5px; color: #6b7280; line-height: 1.8; margin-bottom: 20px; }
.ask-actions { display: flex; flex-direction: column; gap: 10px; }
.ask-hint { margin-top: 16px; font-size: 12px; color: #9ca3af; }
.baseline-tip {
  font-size: 13px;
  color: #6b7280;
  background: #eef2ff;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 14px;
  line-height: 1.8;
}
.trend-tip {
  font-size: 12.5px;
  color: #6b7280;
  margin-bottom: 14px;
}
.trend-empty { text-align: center; color: #9ca3af; padding: 24px 0; font-size: 13px; }
.trend-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.trend-ch { width: 64px; flex-shrink: 0; font-size: 12.5px; color: #4b5563; }
.trend-bar-wrap { flex: 1; background: #f1f3f9; border-radius: 5px; height: 10px; overflow: hidden; }
.trend-bar { height: 100%; border-radius: 5px; transition: width .3s; }
.trend-bar.ok { background: linear-gradient(90deg, #a7f3d0, #34d399); }
.trend-bar.warn { background: linear-gradient(90deg, #fde68a, #f59e0b); }
.trend-bar.bad { background: linear-gradient(90deg, #fecaca, #ef4444); }
.trend-score { width: 52px; flex-shrink: 0; text-align: right; font-size: 12.5px; font-weight: 700; }
.trend-score.ok { color: #059669; }
.trend-score.warn { color: #d97706; }
.trend-score.bad { color: #dc2626; }
</style>
