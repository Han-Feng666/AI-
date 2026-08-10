<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { AVATAR_COLORS, ROLE_TYPES } from '../utils/format';

const list = ref([]);
const loading = ref(false);
const dialog = ref(false);
const editing = ref(null);
const form = ref({ name: '', role_type: '配角', personality: '', background: '', description: '', avatar_color: '#6366f1' });

const introducedMap = computed(() => {
  // 简易按 name 统计被引入次数（前端无 characters 表里 shared_id 视图，只显示源 novel 数量）
  const m = {};
  list.value.forEach((c) => { m[c.name] = m[c.name] || (c.source_novel_id ? '有源' : ''); });
  return m;
});

async function load() {
  loading.value = true;
  try { list.value = await api.listSharedCharacters(); }
  catch (e) { ElMessage.error(e.message); }
  loading.value = false;
}

function openCreate() {
  editing.value = null;
  form.value = { name: '', role_type: '配角', personality: '', background: '', description: '', avatar_color: AVATAR_COLORS[0] };
  dialog.value = true;
}

function openEdit(c) {
  editing.value = c.id;
  form.value = { name: c.name, role_type: c.role_type, personality: c.personality, background: c.background, description: c.description, avatar_color: c.avatar_color || '#6366f1' };
  dialog.value = true;
}

async function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写角色名');
    return;
  }
  try {
    if (editing.value) {
      await api.updateSharedCharacter(editing.value, form.value);
      ElMessage.success('已更新（已同步所有引用了此角色的小说）');
    } else {
      await api.createSharedCharacter(form.value);
      ElMessage.success('已新增共享角色');
    }
    dialog.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); }
}

async function remove(c) {
  try { await ElMessageBox.confirm(`删除共享角色「${c.name}」？将解除所有小说中该角色的关联（小说内部角色条目会保留）。`, '删除', { type: 'warning' }); }
  catch { return; }
  try { await api.deleteSharedCharacter(c.id); ElMessage.success('已删除'); load(); }
  catch (e) { ElMessage.error(e.message); }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h2>共享角色池</h2>
      <p class="head-sub">这些角色可以跨书复用——Manager AI 引入会带 shared_id 关联；修改一处自动同步到所有引用了它的小说</p>
    </div>

    <el-button type="primary" @click="openCreate">
      <el-icon style="margin-right:6px"><Plus /></el-icon>新增共享角色
    </el-button>

    <div v-loading="loading" class="grid">
      <el-card v-for="c in list" :key="c.id" class="card">
        <div class="card-head">
          <span class="avatar" :style="{ background: c.avatar_color }">{{ c.name?.[0] || '?' }}</span>
          <div class="head-info">
            <div class="name">{{ c.name }}</div>
            <el-tag size="small" effect="plain">{{ c.role_type }}</el-tag>
          </div>
        </div>
        <div class="kw">
          <div class="line"><span>个性</span>{{ c.personality || '—' }}</div>
          <div class="line"><span>背景</span>{{ c.background || '—' }}</div>
          <div class="line"><span>描述</span>{{ c.description || '—' }}</div>
        </div>
        <div class="card-actions">
          <el-button link size="small" type="primary" @click="openEdit(c)">编辑</el-button>
          <el-button link size="small" type="danger" @click="remove(c)">删除</el-button>
        </div>
      </el-card>
      <el-empty v-if="!list.length && !loading" description="池子是空的，先把某本书里的角色提升为共享角色，或直接新增一个" :image-size="80" />
    </div>

    <el-dialog v-model="dialog" :title="editing ? '编辑共享角色' : '新增共享角色'" width="520px">
      <el-form :model="form" label-width="70px">
        <el-form-item label="名字" required>
          <el-input v-model="form.name" maxlength="20" />
        </el-form-item>
        <el-form-item label="定位">
          <el-select v-model="form.role_type" style="width:100%">
            <el-option v-for="r in ROLE_TYPES" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="色彩">
          <div class="color-row">
            <span
              v-for="c in AVATAR_COLORS"
              :key="c"
              class="color-dot"
              :style="{ background: c, outline: form.avatar_color === c ? '2px solid #6366f1' : 'none' }"
              @click="form.avatar_color = c"
            ></span>
          </div>
        </el-form-item>
        <el-form-item label="个性">
          <el-input v-model="form.personality" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="背景">
          <el-input v-model="form.background" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page { padding: 24px 28px; max-width: 1100px; margin: 0 auto; }
.page-head { margin-bottom: 18px; }
.page-head h2 { margin: 0 0 6px; font-size: 19px; color: #1e1b4b; }
.head-sub { margin: 0; font-size: 12.5px; color: #9ca3af; line-height: 1.6; }
.grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.card { border-radius: 10px; }
.card :deep(.el-card__body) { padding: 14px; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.avatar {
  width: 36px; height: 36px; border-radius: 50%;
  color: #fff; display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700;
}
.head-info .name { font-weight: 700; color: #1f2937; font-size: 14.5px; }
.head-info { display: flex; align-items: center; gap: 8px; }
.kw { font-size: 12px; line-height: 1.7; color: #4b5563; }
.kw .line { display: flex; gap: 8px; margin-bottom: 4px; }
.kw .line span { color: #9ca3af; min-width: 32px; }
.card-actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 6px; }
.color-row { display: flex; gap: 6px; flex-wrap: wrap; }
.color-dot {
  width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
  border: 1px solid #e5e7f0;
}
</style>
