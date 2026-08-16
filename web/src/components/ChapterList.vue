<script setup>
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';

const store = useEditorStore();
const useReference = ref(false);

const written = computed(() => store.chapters.filter((c) => c.word_count > 0).length);
const target = computed(() => Number(store.novel?.target_chapters) || store.chapters.length || 0);
const progressPct = computed(() => {
  if (!target.value) return 0;
  return Math.min(100, Math.round((written.value / target.value) * 100));
});

function aiDotCls(score) {
  if (score <= 30) return 'ok';
  if (score <= 60) return 'warn';
  return 'bad';
}
</script>

<template>
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
    <div v-if="target" class="list-progress">
      <div class="lp-head">
        <span class="lp-text">已写 {{ written }} / {{ target }} 章</span>
        <span class="lp-pct">{{ progressPct }}%</span>
      </div>
      <div class="lp-track"><div class="lp-fill" :style="{ width: progressPct + '%' }"></div></div>
    </div>
    <div
      v-for="c in store.chapters"
      :key="c.chapter_index"
      class="chapter-item"
      :class="{ active: store.activeChapter && store.activeChapter.chapter_index === c.chapter_index }"
      @click="store.selectChapter(c.chapter_index)"
    >
      <div class="chapter-no">{{ c.chapter_index }}</div>
      <div class="chapter-info">
        <div class="chapter-title-line">
          <span class="chapter-title ellipsis">{{ c.title || `第${c.chapter_index}章` }}</span>
          <span
            v-if="c.ai_score != null"
            class="ai-dot"
            :class="aiDotCls(c.ai_score)"
            :title="'AI 味 ' + c.ai_score + ' 分'"
          ></span>
        </div>
        <div class="chapter-sub">
          <span v-if="c.word_count">{{ c.word_count }} 字</span>
          <span v-else-if="c.summary" class="planned-tag">待创作</span>
          <el-icon v-else class="chapter-loading"><Loading /></el-icon>
        </div>
      </div>
      <div v-if="c.status === 'planned' && !c.word_count" class="chapter-badge">规划</div>
    </div>
    <el-empty v-if="!store.chapters.length" description="尚未生成章节规划" :image-size="60" />
  </div>
</template>

<style scoped>
.chapter-list {
  height: 100%;
  overflow-y: auto;
  padding: 12px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
}
.gen-next-btn { width: 100%; margin-bottom: 6px; }
.gen-options { margin-bottom: 12px; padding-left: 2px; font-size: 12px; }
.list-progress { margin-bottom: 12px; padding: 8px 10px; background: #f5f6fd; border-radius: 8px; }
.lp-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
.lp-text { font-size: 11.5px; color: #6b7280; }
.lp-pct { font-size: 11.5px; font-weight: 700; color: #4f46e5; }
.lp-track { height: 5px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
.lp-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #6366f1, #8b5cf6); transition: width .3s; }
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
.chapter-title-line { display: flex; align-items: center; min-width: 0; }
.chapter-title { font-size: 13px; font-weight: 500; }
.ai-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 6px;
  flex-shrink: 0;
}
.ai-dot.ok { background: #34d399; }
.ai-dot.warn { background: #f59e0b; }
.ai-dot.bad { background: #ef4444; }
.chapter-sub { font-size: 11px; color: #9ca3af; margin-top: 2px; }
.chapter-loading { color: #9ca3af; }
.chapter-badge {
  font-size: 10px;
  color: #b45309;
  background: #fef3c7;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.planned-tag { color: #b45309; }
</style>
