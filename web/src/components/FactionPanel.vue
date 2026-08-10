<script setup>
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import { FACTION_TYPES, FACTION_STANCES } from '../utils/format';

const store = useEditorStore();
const dialogOpen = ref(false);
const editingId = ref(null);

const form = ref({ name: '', type: '帮派', description: '', power_level: '', territory: '', leader: '', stance: '中立' });

const stanceTagType = (s) => {
  const map = { '正派': 'success', '中立': 'info', '邪派': 'danger' };
  return map[s] || 'info';
};

function openCreate() {
  editingId.value = null;
  form.value = { name: '', type: '帮派', description: '', power_level: '', territory: '', leader: '', stance: '中立' };
  dialogOpen.value = true;
}

function openEdit(f) {
  editingId.value = f.id;
  form.value = {
    name: f.name, type: f.type, description: f.description,
    power_level: f.power_level, territory: f.territory, leader: f.leader, stance: f.stance
  };
  dialogOpen.value = true;
}

async function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写势力名');
    return;
  }
  try {
    if (editingId.value) {
      await store.updateFaction(editingId.value, form.value);
    } else {
      await store.createFaction(form.value);
    }
    dialogOpen.value = false;
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function remove(f) {
  try {
    await ElMessageBox.confirm(`确定删除势力「${f.name}」吗？`, '删除势力', { type: 'warning' });
  } catch { return; }
  try {
    await store.deleteFaction(f.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="fac-panel">
    <div class="fac-actions">
      <el-button type="primary" size="small" @click="openCreate">
        <el-icon style="margin-right:4px"><Plus /></el-icon>添加势力
      </el-button>
    </div>

    <div class="fac-grid">
      <div v-for="f in store.factions" :key="f.id" class="fac-card" @click="openEdit(f)">
        <div class="fac-head">
          <span class="fac-name">{{ f.name }}</span>
          <el-tag :type="stanceTagType(f.stance)" size="small" effect="light" style="margin-left:6px">
            {{ f.stance }}
          </el-tag>
        </div>
        <div class="fac-type">{{ f.type }}</div>
        <div class="fac-desc ellipsis">{{ f.description || '暂无描述' }}</div>
        <div v-if="f.leader" class="fac-meta ellipsis">首领：{{ f.leader }}</div>
        <div v-if="f.territory" class="fac-meta ellipsis">领地：{{ f.territory }}</div>
        <div v-if="f.power_level" class="fac-meta ellipsis">实力：{{ f.power_level }}</div>
        <div class="fac-del" @click.stop="remove(f)">
          <el-icon><Delete /></el-icon>
        </div>
      </div>
      <el-empty v-if="!store.factions.length" description="还没有势力，方案生成时会自动创建，也可手动添加" :image-size="60" />
    </div>

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑势力' : '添加势力'" width="480px">
      <el-form :model="form" label-width="70px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" maxlength="30" placeholder="势力名称" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="form.type" style="width: 100%">
            <el-option v-for="t in FACTION_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="立场">
          <el-select v-model="form.stance" style="width: 100%">
            <el-option v-for="s in FACTION_STANCES" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="首领">
          <el-input v-model="form.leader" maxlength="20" placeholder="势力首领名字" />
        </el-form-item>
        <el-form-item label="领地">
          <el-input v-model="form.territory" maxlength="30" placeholder="势力所在地/势力范围" />
        </el-form-item>
        <el-form-item label="实力">
          <el-input v-model="form.power_level" maxlength="20" placeholder="如：一流势力、顶尖、新晋" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="form.description" type="textarea" :rows="3" placeholder="势力背景、特色、目标等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fac-panel { height: 100%; overflow-y: auto; padding: 18px 20px; }
.fac-actions { display: flex; gap: 8px; margin-bottom: 14px; }
.fac-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.fac-card {
  position: relative;
  padding: 12px;
  border: 1px solid #eef0f6;
  border-radius: 10px;
  cursor: pointer;
  transition: box-shadow .12s;
}
.fac-card:hover { box-shadow: 0 2px 8px rgba(20,24,80,.08); }
.fac-head { display: flex; align-items: center; }
.fac-name { font-size: 14px; font-weight: 600; }
.fac-type { font-size: 11px; color: #8b5cf6; margin-top: 2px; }
.fac-desc { font-size: 12px; color: #6b7280; margin-top: 6px; }
.fac-meta { font-size: 11px; color: #9ca3af; margin-top: 3px; }
.fac-del {
  opacity: 0;
  position: absolute;
  top: 8px; right: 8px;
  color: #ef4444;
  transition: opacity .12s;
}
.fac-card:hover .fac-del { opacity: 1; }
</style>
