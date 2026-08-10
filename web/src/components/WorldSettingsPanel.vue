<script setup>
import { ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';

const store = useEditorStore();

const CATEGORIES = ['人物', '地点', '势力', '物品', '时间线', '法术规则', '其他'];

const addOpen = ref(false);
const editId = ref(null);
const form = ref({ category: '其他', name: '', content: '' });

const grouped = computed(() => {
  const map = {};
  for (const s of store.worldSettings) {
    (map[s.category || '其他'] = map[s.category || '其他'] || []).push(s);
  }
  return map;
});

function openAdd() {
  editId.value = null;
  form.value = { category: '其他', name: '', content: '' };
  addOpen.value = true;
}

function openEdit(s) {
  editId.value = s.id;
  form.value = { category: s.category, name: s.name, content: s.content };
  addOpen.value = true;
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写设定名称');
  try {
    if (editId.value) {
      await store.updateWorldSetting(editId.value, form.value);
      ElMessage.success('已保存修改');
    } else {
      await store.addWorldSetting(form.value);
      ElMessage.success('已添加设定，生成章节时会自动注入');
    }
    addOpen.value = false;
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeSetting(s) {
  try {
    await ElMessageBox.confirm(`确定删除设定「${s.name}」吗？`, '删除设定', { type: 'warning' });
  } catch { return; }
  try {
    await store.removeWorldSetting(s.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="world-settings-panel">
    <div class="ws-head">
      <span class="ws-title">世界观设定</span>
      <el-button size="small" type="primary" plain @click="openAdd">
        <el-icon style="margin-right:4px"><Plus /></el-icon>新增设定
      </el-button>
    </div>
    <div class="ws-tip">
      记录人物、地点、势力、物品等恒定设定，生成章节时自动注入，保证长篇写作前后一致。
    </div>

    <div v-loading="store.worldSettingsLoading" class="ws-body">
      <el-empty v-if="!store.worldSettings.length" description="还没有设定，点击「新增设定」添加第一条" :image-size="54" />
      <div v-for="(list, cat) in grouped" :key="cat" class="ws-group">
        <div class="ws-cat">{{ cat }}（{{ list.length }}）</div>
        <div v-for="s in list" :key="s.id" class="ws-item">
          <div class="ws-item-main">
            <span class="ws-name">{{ s.name }}</span>
            <span v-if="s.content" class="ws-content ellipsis-2">{{ s.content }}</span>
          </div>
          <div class="ws-item-ops">
            <el-button link size="small" @click="openEdit(s)"><el-icon><Edit /></el-icon></el-button>
            <el-button link size="small" type="danger" @click="removeSetting(s)"><el-icon><Delete /></el-icon></el-button>
          </div>
        </div>
      </div>
    </div>

    <el-dialog v-model="addOpen" :title="editId ? '编辑设定' : '新增设定'" width="440px">
      <el-form label-width="64px">
        <el-form-item label="分类">
          <el-select v-model="form.category" style="width:100%">
            <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="如：青云门 / 灵石 / 天劫" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :rows="4" placeholder="描述该设定的事实，越具体越好。生成时会原样注入，AI 不得与之冲突。" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addOpen = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.world-settings-panel {
  height: 100%;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ws-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.ws-title { font-size: 15px; font-weight: 700; color: #1e1b4b; }
.ws-tip { font-size: 12px; color: #9ca3af; line-height: 1.6; margin-bottom: 10px; }
.ws-body { flex: 1; overflow-y: auto; }
.ws-group { margin-bottom: 14px; }
.ws-cat {
  font-size: 12px;
  font-weight: 700;
  color: #4f46e5;
  background: #eef2ff;
  display: inline-block;
  padding: 2px 10px;
  border-radius: 10px;
  margin-bottom: 6px;
}
.ws-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  margin-bottom: 6px;
}
.ws-item-main { min-width: 0; }
.ws-name { font-size: 13px; font-weight: 600; color: #374151; }
.ws-content { display: block; font-size: 12px; color: #6b7280; margin-top: 2px; line-height: 1.6; }
.ws-item-ops { display: flex; flex-shrink: 0; }
.ellipsis-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
