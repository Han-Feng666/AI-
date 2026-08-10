<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import api from '../api';

const store = useEditorStore();
const arcLoading = ref(false);
const arcData = ref(null);
const worldLoading = ref(false);
const worldData = ref(null);
const emotionLoading = ref(false);
const emotionData = ref(null);
const emotionRange = ref({ start: 1, end: 20 });

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
  try {
    await store.generatePlan({ concept: store.novel?.concept || '' });
    store.setWorkspace('chapters');
    ElMessage.success('已重新生成创作方案');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function loadArcPlan() {
  arcLoading.value = true;
  arcData.value = null;
  try {
    const result = await api.arcPlan(store.novelId);
    arcData.value = result;
    ElMessage.success('弧线规划已生成');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    arcLoading.value = false;
  }
}

async function loadWorldExpand() {
  worldLoading.value = true;
  worldData.value = null;
  try {
    const result = await api.worldExpand(store.novelId);
    worldData.value = result;
    ElMessage.success('世界设定已细化');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    worldLoading.value = false;
  }
}

async function loadEmotionCurve() {
  emotionLoading.value = true;
  emotionData.value = null;
  try {
    const result = await api.emotionCurve(store.novelId, emotionRange.value.start, emotionRange.value.end);
    emotionData.value = result;
    ElMessage.success('情绪曲线已生成');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    emotionLoading.value = false;
  }
}
</script>

<template>
  <div class="outline-panel">
    <div class="panel-head">
      <div class="panel-title">大纲</div>
      <el-button text type="primary" size="small" @click="regeneratePlan">
        <el-icon style="margin-right:4px"><Refresh /></el-icon> 重新生成方案
      </el-button>
    </div>

    <div v-if="store.novel.world_view" class="outline-block">
      <div class="outline-label"><el-icon><Globe /></el-icon> 世界观设定</div>
      <div class="outline-text">{{ store.novel.world_view }}</div>
    </div>

    <div v-if="store.novel.outline" class="outline-block">
      <div class="outline-label"><el-icon><Map /></el-icon> 剧情大纲</div>
      <div class="outline-text">{{ store.novel.outline }}</div>
    </div>

    <div v-if="store.factions && store.factions.length" class="outline-block">
      <div class="outline-label"><el-icon><OfficeBuilding /></el-icon> 势力/组织</div>
      <div class="fac-list">
        <div v-for="f in store.factions" :key="f.id" class="fac-item">
          <span class="fac-item-name">{{ f.name }}</span>
          <el-tag size="small" type="info">{{ f.type }}</el-tag>
          <el-tag v-if="f.stance" size="small" :type="f.stance === '正派' ? 'success' : f.stance === '邪派' ? 'danger' : 'info'">{{ f.stance }}</el-tag>
          <span class="fac-item-desc">{{ f.description }}</span>
        </div>
      </div>
    </div>

    <div class="outline-block">
      <div class="tool-head">
        <div class="outline-label"><el-icon><TrendCharts /></el-icon> 剧情弧线规划</div>
        <el-button size="small" :loading="arcLoading" @click="loadArcPlan">生成弧线</el-button>
      </div>
      <div v-if="arcData" class="arc-content">
        <div v-if="arcData.global_tension" class="arc-section">
          <span class="arc-key">全书紧张度：</span>{{ arcData.global_tension }}
        </div>
        <div v-if="arcData.pacing_notes" class="arc-section">
          <span class="arc-key">节奏建议：</span>{{ arcData.pacing_notes }}
        </div>
        <div v-if="arcData.arcs && arcData.arcs.length" class="arc-list">
          <div v-for="(arc, i) in arcData.arcs" :key="i" class="arc-card">
            <div class="arc-card-head">
              <span class="arc-card-name">{{ arc.name }}</span>
              <el-tag size="small" :type="arc.type === 'main' ? 'danger' : arc.type === 'dark' ? 'warning' : 'info'">{{ arc.type }}</el-tag>
              <el-tag v-if="arc.chapter_range" size="small" type="info" effect="plain">{{ arc.chapter_range }}</el-tag>
            </div>
            <div v-if="arc.theme" class="arc-card-line"><span class="arc-key">主题：</span>{{ arc.theme }}</div>
            <div v-if="arc.core_conflict" class="arc-card-line"><span class="arc-key">核心冲突：</span>{{ arc.core_conflict }}</div>
            <div v-if="arc.setup" class="arc-card-line"><span class="arc-key">起：</span>{{ arc.setup }}</div>
            <div v-if="arc.development" class="arc-card-line"><span class="arc-key">承：</span>{{ arc.development }}</div>
            <div v-if="arc.twist" class="arc-card-line"><span class="arc-key">转：</span>{{ arc.twist }}</div>
            <div v-if="arc.resolution" class="arc-card-line"><span class="arc-key">合：</span>{{ arc.resolution }}</div>
            <div v-if="arc.emotion_curve" class="arc-card-line"><span class="arc-key">情绪：</span>{{ arc.emotion_curve }}</div>
            <div v-if="arc.character_growth" class="arc-card-line"><span class="arc-key">角色变化：</span>{{ arc.character_growth }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="outline-block">
      <div class="tool-head">
        <div class="outline-label"><el-icon><Setting /></el-icon> 世界设定细化</div>
        <el-button size="small" :loading="worldLoading" @click="loadWorldExpand">细化设定</el-button>
      </div>
      <div v-if="worldData" class="world-content">
        <div v-if="worldData.power_system" class="world-section">
          <div class="world-section-title">力量体系</div>
          <div v-if="worldData.power_system.ceiling" class="world-line"><span class="arc-key">天花板：</span>{{ worldData.power_system.ceiling }}</div>
          <div v-if="worldData.power_system.sources" class="world-line"><span class="arc-key">来源：</span>{{ worldData.power_system.sources }}</div>
          <div v-if="worldData.power_system.conflict_potential" class="world-line"><span class="arc-key">冲突潜力：</span>{{ worldData.power_system.conflict_potential }}</div>
          <div v-if="worldData.power_system.levels" class="world-levels">
            <div v-for="(lv, i) in worldData.power_system.levels" :key="i" class="world-level-item">
              <span class="level-num">{{ lv.rank }}</span>
              <span class="level-name">{{ lv.name }}</span>
              <span class="level-desc">{{ lv.features }}{{ lv.threshold ? ' / 突破：' + lv.threshold : '' }}{{ lv.cost ? ' / 代价：' + lv.cost : '' }}</span>
            </div>
          </div>
        </div>
        <div v-if="worldData.social_structure" class="world-section">
          <div class="world-section-title">社会结构</div>
          <div v-if="worldData.social_structure.core_conflict" class="world-line"><span class="arc-key">核心矛盾：</span>{{ worldData.social_structure.core_conflict }}</div>
          <div v-if="worldData.social_structure.mobility" class="world-line"><span class="arc-key">流动性：</span>{{ worldData.social_structure.mobility }}</div>
        </div>
        <div v-if="worldData.geography" class="world-section">
          <div class="world-section-title">地理</div>
          <div v-if="worldData.geography.connections" class="world-line"><span class="arc-key">区域关系：</span>{{ worldData.geography.connections }}</div>
        </div>
        <div v-if="worldData.history" class="world-section">
          <div class="world-section-title">历史</div>
          <div v-if="worldData.history.hidden_truth" class="world-line"><span class="arc-key">被掩盖的真相：</span>{{ worldData.history.hidden_truth }}</div>
        </div>
        <div v-if="worldData.core_conflicts" class="world-section">
          <div class="world-section-title">核心矛盾</div>
          <div v-for="(c, i) in worldData.core_conflicts" :key="i" class="world-line">{{ c }}</div>
        </div>
      </div>
    </div>

    <div class="outline-block">
      <div class="tool-head">
        <div class="outline-label"><el-icon><DataLine /></el-icon> 章节情绪曲线</div>
        <div class="emotion-range">
          <el-input-number v-model="emotionRange.start" :min="1" :max="999" size="small" style="width:80px" />
          <span style="color:#9ca3af">~</span>
          <el-input-number v-model="emotionRange.end" :min="1" :max="999" size="small" style="width:80px" />
          <el-button size="small" :loading="emotionLoading" @click="loadEmotionCurve">分析</el-button>
        </div>
      </div>
      <div v-if="emotionData" class="emotion-content">
        <div class="emotion-score">
          <span class="arc-key">节奏评分：</span>
          <el-progress :percentage="emotionData.rhythm_score || 0" :color="emotionData.rhythm_score >= 70 ? '#10b981' : emotionData.rhythm_score >= 40 ? '#f59e0b' : '#ef4444'" style="width:200px" />
        </div>
        <div v-if="emotionData.overall_assessment" class="world-line">{{ emotionData.overall_assessment }}</div>
        <div v-if="emotionData.issues && emotionData.issues.length" class="emotion-issues">
          <div v-for="(iss, i) in emotionData.issues" :key="i" class="emotion-issue">
            <el-tag size="small" type="warning">{{ iss.type }}</el-tag>
            <span class="iss-chapters">{{ iss.chapters }}</span>
            <span class="iss-desc">{{ iss.description }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.outline-panel {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.panel-title { font-weight: 700; font-size: 17px; color: #1e1b4b; }
.outline-block { margin-bottom: 20px; max-width: 760px; }
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
  font-size: 14px;
  line-height: 1.9;
  color: #374151;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  padding: 14px;
  white-space: pre-wrap;
}
.tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.tool-head .outline-label { margin-bottom: 0; }
.fac-list { display: flex; flex-direction: column; gap: 8px; }
.fac-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  font-size: 13px;
}
.fac-item-name { font-weight: 600; color: #1e1b4b; }
.fac-item-desc { color: #6b7280; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arc-content, .world-content, .emotion-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.arc-section, .world-line {
  font-size: 13px;
  color: #374151;
  line-height: 1.8;
}
.arc-key { font-weight: 600; color: #1e1b4b; }
.arc-list { display: flex; flex-direction: column; gap: 10px; }
.arc-card {
  padding: 12px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
}
.arc-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.arc-card-name { font-weight: 700; font-size: 14px; color: #1e1b4b; }
.arc-card-line { font-size: 12px; color: #4b5563; line-height: 1.7; margin-top: 3px; }
.world-section {
  padding: 10px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
}
.world-section-title { font-weight: 700; font-size: 13px; color: #1e1b4b; margin-bottom: 6px; }
.world-levels { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.world-level-item { display: flex; align-items: baseline; gap: 6px; font-size: 12px; color: #4b5563; }
.level-num { width: 18px; height: 18px; border-radius: 50%; background: #6366f1; color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.level-name { font-weight: 600; }
.level-desc { color: #6b7280; }
.emotion-range { display: flex; align-items: center; gap: 6px; }
.emotion-score { display: flex; align-items: center; gap: 8px; }
.emotion-issues { display: flex; flex-direction: column; gap: 6px; }
.emotion-issue {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  font-size: 12px;
}
.iss-chapters { font-weight: 600; color: #92400e; }
.iss-desc { color: #6b7280; flex: 1; }
</style>
