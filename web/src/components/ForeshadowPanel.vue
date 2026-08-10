<script setup>
import { ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';

const store = useEditorStore();

const openCount = computed(() => store.foreshadowings.filter((f) => f.status === 'open').length);
const closedCount = computed(() => store.foreshadowings.length - openCount.value);

const addOpen = ref(false);
const analyzing = ref(false);
const form = ref({ content: '', chapter_index: null, note: '' });

function openAdd() {
  form.value = { content: '', chapter_index: store.activeChapter?.chapter_index || null, note: '' };
  addOpen.value = true;
}

async function addForeshadow() {
  if (!form.value.content.trim()) return ElMessage.warning('请填写伏笔内容');
  try {
    await store.addForeshadowing({
      content: form.value.content,
      chapter_index: form.value.chapter_index || 0,
      note: form.value.note
    });
    addOpen.value = false;
    ElMessage.success('已添加伏笔');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function toggleStatus(f) {
  const target = f.status === 'open' ? 'closed' : 'open';
  try {
    if (target === 'closed') {
      await ElMessageBox.confirm('标记为已回收？该伏笔将不再出现在生成提醒中。', '回收伏笔', { type: 'info', confirmButtonText: '已回收', cancelButtonText: '取消' });
    }
    await store.updateForeshadowing(f.id, {
      status: target,
      note: target === 'closed' ? (f.note || `（第${f.chapter_index}章回收）`) : (f.note || '')
    });
    ElMessage.success(target === 'closed' ? '已标记回收' : '已重新打开');
  } catch (e) {
    if (e !== 'cancel' && e?.message !== 'cancel') ElMessage.error(e?.message || '已取消');
  }
}

async function removeForeshadow(f) {
  try {
    await ElMessageBox.confirm('确定删除这条伏笔吗？', '删除伏笔', { type: 'warning' });
  } catch { return; }
  try {
    await store.removeForeshadowing(f.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function runAnalyze() {
  if (analyzing.value) return;
  analyzing.value = true;
  try {
    const data = await store.analyzeForeshadowings();
    const added = data.added?.length || 0;
    const closed = data.closed?.length || 0;
    ElMessage.success(`分析完成：新增 ${added} 条伏笔，回收 ${closed} 条`);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    analyzing.value = false;
  }
}
</script>

<template>
  <div class="foreshadow-panel">
    <div class="foreshadow-head">
      <div class="foreshadow-stats">
        <span class="stat-open" :title="`${openCount} 条待回收伏笔`">{{ openCount }} 待回收</span>
        <span class="stat-closed" :title="`${closedCount} 条已回收`">{{ closedCount }} 已回收</span>
      </div>
      <div class="foreshadow-ops">
        <el-tooltip content="AI 分析最近一章，自动识别新伏笔与已回收伏笔" placement="top">
          <el-button size="small" :loading="analyzing" @click="runAnalyze">
            <el-icon style="margin-right:4px"><MagicStick /></el-icon>智能分析
          </el-button>
        </el-tooltip>
        <el-button size="small" type="primary" @click="openAdd">
          <el-icon style="margin-right:4px"><Plus /></el-icon>添加
        </el-button>
      </div>
    </div>

    <div v-loading="store.foreshadowLoading" class="foreshadow-list">
      <el-empty v-if="!store.foreshadowings.length" description="还没有伏笔记录" :image-size="60">
        <div class="empty-tip">每章生成后 AI 会自动记录埋下的线索；也可以手动添加，避免前期埋的坑后期忘记填</div>
      </el-empty>

      <div
        v-for="f in store.foreshadowings"
        :key="f.id"
        class="foreshadow-item"
        :class="{ closed: f.status === 'closed' }"
      >
        <div class="foreshadow-body">
          <div class="foreshadow-content">{{ f.content }}</div>
          <div class="foreshadow-meta">
            <span class="meta-chapter">{{ f.chapter_index ? '第' + f.chapter_index + '章' : '手动添加' }}</span>
            <el-tag v-if="f.status === 'closed'" size="small" type="success" effect="plain">已回收{{ f.note ? ' · ' + f.note : '' }}</el-tag>
          </div>
        </div>
        <div class="foreshadow-actions">
          <el-tooltip :content="f.status === 'open' ? '标记为已回收' : '重新打开'">
            <el-icon class="act" @click="toggleStatus(f)"><CircleCheck v-if="f.status === 'open'" /><RefreshLeft v-else /></el-icon>
          </el-tooltip>
          <el-tooltip content="删除">
            <el-icon class="act danger" @click="removeForeshadow(f)"><Delete /></el-icon>
          </el-tooltip>
        </div>
      </div>
    </div>

    <el-dialog v-model="addOpen" title="添加伏笔" width="420px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="伏笔内容" required>
          <el-input v-model="form.content" type="textarea" :rows="3" maxlength="200" placeholder="如：那块令牌上的符文似乎与小明的身世有关" />
        </el-form-item>
        <el-form-item label="埋设章节">
          <el-input-number v-model="form.chapter_index" :min="0" :max="99999" placeholder="自动" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" maxlength="100" placeholder="可选，如：需在第20章前回收" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addOpen = false">取消</el-button>
        <el-button type="primary" @click="addForeshadow">添加</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.foreshadow-panel { height: 100%; display: flex; flex-direction: column; }
.foreshadow-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 6px;
}
.foreshadow-stats { display: flex; gap: 8px; font-size: 12px; }
.stat-open { color: #b45309; font-weight: 700; }
.stat-closed { color: #9ca3af; }
.foreshadow-ops { display: flex; gap: 6px; }
.foreshadow-list { flex: 1; overflow-y: auto; padding: 6px 12px 12px; }
.foreshadow-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}
.foreshadow-item.closed {
  background: #f5f6fd;
  border-color: #e5e7f0;
}
.foreshadow-item.closed .foreshadow-content {
  color: #9ca3af;
  text-decoration: line-through;
}
.foreshadow-body { flex: 1; min-width: 0; }
.foreshadow-content { font-size: 13px; color: #1e1b4b; line-height: 1.7; word-break: break-all; }
.foreshadow-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: #9ca3af; }
.foreshadow-actions { display: flex; gap: 8px; color: #9ca3af; flex-shrink: 0; }
.foreshadow-actions .act:hover { color: #059669; }
.foreshadow-actions .act.danger:hover { color: #ef4444; }
.empty-tip { font-size: 12px; color: #9ca3af; line-height: 1.7; max-width: 220px; }
</style>
