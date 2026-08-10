<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { useEditorStore } from '../stores/editor';

const store = useEditorStore();
const router = useRouter();
const styleIds = ref([]);

const selectedStyles = computed(() => store.allStyles.filter((s) => styleIds.value.includes(s.id)));

function goStyles() {
  router.push('/styles');
}

onMounted(() => {
  store.loadStyles();
  styleIds.value = (store.novel?.style_ids || []).slice();
});

async function onStylesChange() {
  try {
    await store.saveStyles(styleIds.value);
    ElMessage.success('风格已更新，后续生成将参考所选风格');
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="style-panel">
    <div class="panel-title">写作风格</div>
    <div class="style-tip">
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
    <div v-if="!store.allStyles.length" class="style-empty">
      <el-empty description="风格库为空" :image-size="80">
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
    <el-button text type="primary" size="small" style="margin-top: 12px" @click="goStyles">
      <el-icon style="margin-right: 4px"><Brush /></el-icon> 管理风格库
    </el-button>
  </div>
</template>

<style scoped>
.style-panel {
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
.style-tip {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.7;
  margin-bottom: 14px;
  padding: 10px 12px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
}
.style-empty { margin-top: 8px; }
.selected-list { margin-top: 18px; max-width: 560px; }
.selected-label { font-size: 13px; color: #4f46e5; font-weight: 700; margin-bottom: 10px; }
.selected-item {
  padding: 12px 14px;
  background: #eef0ff;
  border-radius: 8px;
  margin-bottom: 8px;
}
.selected-name { font-size: 14px; font-weight: 700; color: #1e1b4b; }
.selected-desc { font-size: 12.5px; color: #6b7280; margin-top: 4px; line-height: 1.6; }
</style>
