<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { useEditorStore } from '../stores/editor';
import CharacterPanel from './CharacterPanel.vue';
import FactionPanel from './FactionPanel.vue';
import RelationshipPanel from './RelationshipPanel.vue';
import ForeshadowPanel from './ForeshadowPanel.vue';
import WorldSettingsPanel from './WorldSettingsPanel.vue';
import { GENRES } from '../utils/format';

const store = useEditorStore();
const router = useRouter();
const activeTab = ref('chapters');
const useReference = ref(false);

function onTabChange(name) {
  if (name === 'foreshadowings') {
    store.loadForeshadowings();
  } else if (name === 'settings') {
    store.loadWorldSettings();
  }
}
const planForm = ref({
  concept: '',
  genre: '玄幻',
  chapterWordCount: 2000,
  targetChapters: 20
});
const styleIds = ref([]);
const planGenerating = ref(false);

const setupConcept = computed(() => store.novel?.concept || '');

const selectedStyles = computed(() => store.allStyles.filter((s) => styleIds.value.includes(s.id)));

function goStyles() {
  router.push('/styles');
}

onMounted(() => {
  store.loadStyles();
});

watch(
  () => store.novel,
  (n) => {
    if (n) {
      planForm.value.concept = n.concept || planForm.value.concept;
      planForm.value.genre = n.genre || planForm.value.genre;
      planForm.value.chapterWordCount = n.chapter_word_count || 2000;
      planForm.value.targetChapters = n.target_chapters || 20;
      styleIds.value = (n.style_ids || []).slice();
    }
  },
  { immediate: true }
);

async function startPlan() {
  if (planGenerating.value || store.busy) return;
  if (!planForm.value.concept.trim()) {
    ElMessage.warning('请先输入你的灵感想法');
    return;
  }
  planGenerating.value = true;
  try {
    await store.saveStyles(styleIds.value);
    await store.generatePlan(planForm.value);
    ElMessage.success('创作方案已生成，可以开始写章节了');
    activeTab.value = 'chapters';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    planGenerating.value = false;
  }
}

async function onStylesChange() {
  try {
    await store.saveStyles(styleIds.value);
    ElMessage.success('风格已更新，后续生成将参考所选风格');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function regeneratePlan() {
  try {
    await ElMessageBox.confirm(
      '重新生成将清空当前所有章节、角色与关系，且不可恢复。确定继续吗？',
      '重新生成创作方案',
      { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  planForm.value.concept = setupConcept.value;
  activeTab.value = 'setup';
  try {
    await store.generatePlan(planForm.value);
    ElMessage.success('已重新生成创作方案');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function selectChapter(idx) {
  store.selectChapter(idx);
}
</script>

<template>
  <div class="left-panel">
    <!-- 未规划：创作设置 -->
    <template v-if="!store.hasPlanned">
      <div class="panel-section">
        <div class="section-title">
          <el-icon><MagicStick /></el-icon> 创作设置
        </div>
        <el-form label-position="top" class="setup-form">
          <el-form-item label="灵感想法" required>
            <el-input
              v-model="planForm.concept"
              type="textarea"
              :rows="6"
              placeholder="描述你的想法：世界观、主角、核心冲突…"
            />
          </el-form-item>
          <el-form-item label="小说类型">
            <el-select v-model="planForm.genre" style="width: 100%">
              <el-option v-for="g in GENRES" :key="g" :label="g" :value="g" />
            </el-select>
          </el-form-item>
          <el-form-item label="每章字数">
            <el-slider v-model="planForm.chapterWordCount" :min="500" :max="8000" :step="500" show-input :format-tooltip="(v) => v + ' 字'" />
          </el-form-item>
          <el-form-item label="目标章节数">
            <el-input-number v-model="planForm.targetChapters" :min="1" :max="2000" />
          </el-form-item>
          <el-form-item label="写作风格（可选，可多选）">
            <el-select
              v-model="styleIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择已提取的写作风格"
              style="width: 100%"
              :loading="store.stylesLoading"
            >
              <el-option v-for="s in store.allStyles" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
            <div v-if="!store.allStyles.length" class="style-empty-tip">
              风格库为空，可前往
              <el-link type="primary" :underline="false" @click="goStyles">风格库</el-link>
              导入文本并提取文风
            </div>
          </el-form-item>
          <el-button
            type="primary"
            style="width: 100%"
            :loading="planGenerating || store.busy"
            @click="startPlan"
          >
            <el-icon style="margin-right:6px"><Sparkles /></el-icon>
            {{ store.busy ? store.busyLabel : 'AI 生成创作方案' }}
          </el-button>
          <div class="setup-tip">
            只需一个想法，AI 将自动生成书名、世界观、大纲、角色关系网与完整章节规划
          </div>
        </el-form>
      </div>
    </template>

    <!-- 已规划：tabs -->
    <template v-else>
      <el-tabs v-model="activeTab" class="panel-tabs" @tab-change="onTabChange">
        <el-tab-pane label="章节" name="chapters">
          <div class="chapter-list">
            <el-button
              type="primary"
              class="gen-next-btn"
              :loading="store.busy"
              :disabled="store.busy"
              @click="store.generateNextChapter({ useReference: useReference.value }).catch((e) => ElMessage.error(e.message || '生成失败'))"
            >
              <el-icon style="margin-right:6px"><EditPen /></el-icon>
              {{ store.busy ? store.busyLabel : '生成下一章' }}
            </el-button>
            <div class="gen-options">
              <el-checkbox v-model="useReference" size="small">参考同类热门小说</el-checkbox>
            </div>
            <div
              v-for="c in store.chapters"
              :key="c.chapter_index"
              class="chapter-item"
              :class="{ active: store.activeChapter && store.activeChapter.chapter_index === c.chapter_index }"
              @click="selectChapter(c.chapter_index)"
            >
              <div class="chapter-no">{{ c.chapter_index }}</div>
              <div class="chapter-info">
                <div class="chapter-title ellipsis">{{ c.title || `第${c.chapter_index}章` }}</div>
                <div class="chapter-sub">
                  <span v-if="c.word_count">{{ c.word_count }} 字</span>
                  <span v-else-if="c.summary" class="planned-tag">待创作</span>
                  <el-icon v-else><Loading /></el-icon>
                </div>
              </div>
              <div v-if="c.status === 'planned' && !c.word_count" class="chapter-badge">规划</div>
            </div>
            <el-empty v-if="!store.chapters.length" description="尚未生成章节规划" :image-size="60" />
          </div>
        </el-tab-pane>

        <el-tab-pane label="角色" name="characters">
          <CharacterPanel />
        </el-tab-pane>

        <el-tab-pane :label="'势力（' + (store.factions?.length || 0) + '）'" name="factions">
          <FactionPanel />
        </el-tab-pane>

        <el-tab-pane :label="'设定（' + store.worldSettings.length + '）'" name="settings">
          <WorldSettingsPanel />
        </el-tab-pane>

        <el-tab-pane :label="'伏笔（' + store.foreshadowings.filter(f => f.status === 'open').length + '）'" name="foreshadowings">
          <ForeshadowPanel />
        </el-tab-pane>

        <el-tab-pane label="关系网" name="relationships">
          <RelationshipPanel />
        </el-tab-pane>

        <el-tab-pane label="风格" name="styles">
          <div class="style-tab">
            <div class="style-tab-tip">
              生成章节与润色时会参考所选风格，多选可融合多种文风。
            </div>
            <el-select
              v-model="styleIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择要采用的写作风格"
              style="width: 100%"
              :loading="store.stylesLoading"
              @change="onStylesChange"
            >
              <el-option v-for="s in store.allStyles" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
            <div v-if="!store.allStyles.length" class="style-tab-empty">
              <el-empty description="风格库为空" :image-size="60">
                <el-button type="primary" plain size="small" @click="goStyles">去风格库导入</el-button>
              </el-empty>
            </div>
            <div v-else-if="selectedStyles.length" class="selected-list">
              <div class="selected-label">已选风格参考</div>
              <div v-for="s in selectedStyles" :key="s.id" class="selected-item">
                <div class="selected-name">{{ s.name }}</div>
                <div class="selected-desc ellipsis">{{ s.analysis?.overview || '' }}</div>
              </div>
            </div>
            <el-button text type="primary" size="small" style="margin-top: 10px" @click="goStyles">
              <el-icon style="margin-right: 4px"><Brush /></el-icon> 管理风格库
            </el-button>
          </div>
        </el-tab-pane>

        <el-tab-pane label="大纲" name="outline">
          <div class="outline-panel">
            <el-button text type="primary" size="small" style="margin-bottom:8px" @click="regeneratePlan">
              <el-icon style="margin-right:4px"><Refresh /></el-icon> 重新生成方案
            </el-button>
            <div v-if="store.novel.world_view" class="outline-block">
              <div class="outline-label"><el-icon><Globe /></el-icon> 世界观设定</div>
              <div class="outline-text">{{ store.novel.world_view }}</div>
            </div>
            <div v-if="store.novel.outline" class="outline-block">
              <div class="outline-label"><el-icon><Map /></el-icon> 剧情大纲</div>
              <div class="outline-text">{{ store.novel.outline }}</div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>

<style scoped>
.left-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.panel-section { padding: 16px; overflow-y: auto; }
.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 15px;
  margin-bottom: 14px;
  color: #1e1b4b;
}
.setup-tip {
  margin-top: 12px;
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.6;
}
.panel-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-tabs :deep(.el-tabs__header) { margin: 0; padding: 0 12px; }
.panel-tabs :deep(.el-tabs__content) { flex: 1; overflow: hidden; }
.panel-tabs :deep(.el-tab-pane) { height: 100%; }
.chapter-list { height: 100%; overflow-y: auto; padding: 12px; }
.gen-next-btn { width: 100%; margin-bottom: 6px; }
.gen-options { margin-bottom: 12px; padding-left: 2px; }
.chapter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  margin-bottom: 4px;
  transition: background .12s;
}
.chapter-item:hover { background: #f5f6fd; }
.chapter-item.active {
  background: #eef0ff;
  border-color: #c7d2fe;
}
.chapter-no {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 6px;
  background: #eef0ff;
  color: #4f46e5;
  font-weight: 700;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chapter-info { flex: 1; min-width: 0; }
.chapter-title { font-size: 13px; font-weight: 500; }
.chapter-sub { font-size: 11px; color: #9ca3af; margin-top: 2px; }
.chapter-badge {
  font-size: 10px;
  color: #b45309;
  background: #fef3c7;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.planned-tag { color: #b45309; }
.outline-panel { padding: 12px; overflow-y: auto; height: 100%; }
.outline-block { margin-bottom: 16px; }
.outline-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 14px;
  color: #1e1b4b;
  margin-bottom: 8px;
}
.outline-text {
  font-size: 13px;
  line-height: 1.9;
  color: #374151;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  padding: 12px;
  white-space: pre-wrap;
}
.style-empty-tip { font-size: 11px; color: #9ca3af; margin-top: 6px; line-height: 1.6; }
.style-tab { padding: 12px; overflow-y: auto; height: 100%; }
.style-tab-tip {
  font-size: 12px;
  color: #6b7280;
  line-height: 1.7;
  margin-bottom: 12px;
  padding: 10px 12px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
}
.style-tab-empty { margin-top: 4px; }
.selected-list { margin-top: 14px; }
.selected-label { font-size: 12px; color: #4f46e5; font-weight: 700; margin-bottom: 8px; }
.selected-item {
  padding: 10px 12px;
  background: #eef0ff;
  border-radius: 8px;
  margin-bottom: 8px;
}
.selected-name { font-size: 13px; font-weight: 700; color: #1e1b4b; }
.selected-desc { font-size: 11.5px; color: #6b7280; margin-top: 3px; line-height: 1.6; }
</style>
