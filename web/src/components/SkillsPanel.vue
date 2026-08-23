<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { useEditorStore } from '../stores/editor';

const store = useEditorStore();
const router = useRouter();
const skillIds = ref([]);

const selectedSkills = computed(() => store.allSkills.filter((s) => skillIds.value.includes(s.id)));

const techniqueSkills = computed(() => selectedSkills.value.filter((s) => s.type === 'technique'));
const workflowSkills = computed(() => selectedSkills.value.filter((s) => s.type === 'workflow'));

function goSkills() {
  router.push('/skills');
}

onMounted(() => {
  store.loadSkills();
  skillIds.value = (store.novel?.skill_ids || []).slice();
});

async function onSkillsChange() {
  try {
    await store.saveSkills(skillIds.value);
    const count = skillIds.value.length;
    ElMessage.success(`已更新技能（${count} 项），后续生成将参考所选技能`);
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="skills-panel">
    <div class="panel-title">AI 写作技能</div>
    <div class="skills-tip">
      选定技能后，AI 在生成章节、润色和改写时会遵循这些技能要求。写作技法影响文笔与技巧，创作流程影响写作步骤。
    </div>
    <el-select
      v-model="skillIds"
      multiple
      collapse-tags
      collapse-tags-tooltip
      placeholder="选择要启用的 AI 写作技能"
      style="width: 100%"
      :loading="store.skillsLoading"
      @change="onSkillsChange"
    >
      <el-option v-for="s in store.allSkills" :key="s.id" :label="s.name" :value="s.id">
        <span>{{ s.name }}</span>
        <el-tag
          :type="s.type === 'technique' ? 'primary' : 'success'"
          size="small"
          effect="plain"
          style="margin-left: 8px"
        >
          {{ s.type === 'technique' ? '技法' : '流程' }}
        </el-tag>
      </el-option>
    </el-select>
    <div v-if="!store.allSkills.length" class="skills-empty">
      <el-empty description="技能库为空" :image-size="80">
        <el-button type="primary" plain size="small" @click="goSkills">去技能库创建</el-button>
      </el-empty>
    </div>
    <div v-else-if="selectedSkills.length" class="selected-list">
      <div class="selected-label">已选技能</div>
      <div v-for="s in selectedSkills" :key="s.id" class="selected-item">
        <div class="selected-head">
          <div class="selected-name">{{ s.name }}</div>
          <el-tag :type="s.type === 'technique' ? 'primary' : 'success'" size="small" effect="plain">
            {{ s.type === 'technique' ? '写作技法' : '创作流程' }}
          </el-tag>
        </div>
        <div class="selected-desc ellipsis">{{ s.description || '暂无说明' }}</div>
      </div>
    </div>
    <el-button text type="primary" size="small" style="margin-top: 12px" @click="goSkills">
      <el-icon style="margin-right: 4px"><Lightning /></el-icon> 管理技能库
    </el-button>
  </div>
</template>

<style scoped>
.skills-panel {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px;
}
.panel-title {
  font-weight: 700;
  font-size: 17px;
  margin-bottom: 14px;
  color: #1e1b4b;
}
.skills-tip {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.7;
  margin-bottom: 14px;
  padding: 10px 12px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
}
.skills-empty { margin-top: 8px; }
.selected-list { margin-top: 18px; max-width: 560px; }
.selected-label { font-size: 13px; color: #4f46e5; font-weight: 700; margin-bottom: 10px; }
.selected-item {
  padding: 12px 14px;
  background: #eef0ff;
  border-radius: 8px;
  margin-bottom: 8px;
}
.selected-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.selected-name { font-size: 14px; font-weight: 700; color: #1e1b4b; }
.selected-desc { font-size: 12.5px; color: #6b7280; margin-top: 4px; line-height: 1.6; }
</style>