<script setup>
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import api from '../api';
import { ROLE_TYPES, AVATAR_COLORS, ROLE_COLORS } from '../utils/format';

const store = useEditorStore();
const dialogOpen = ref(false);
const editingId = ref(null);
const analyzing = ref(false);
const suggestOpen = ref(false);
const suggestions = ref([]);
const selectedSug = ref([]);

const form = ref({ name: '', role_type: '配角', personality: '', background: '', description: '', faction: '', age: '', goal: '', ability: '' });

const roleTagType = (rt) => {
  const map = { 主角: 'danger', 主角团: 'danger', 大反派: 'danger', 反派: 'danger', 导师: 'warning', 红颜: 'warning', 重要配角: 'warning', 配角: 'info' };
  return map[rt] || 'info';
};

function openCreate() {
  editingId.value = null;
  form.value = { name: '', role_type: '配角', personality: '', background: '', description: '', faction: '', age: '', goal: '', ability: '' };
  dialogOpen.value = true;
}

function openEdit(c) {
  editingId.value = c.id;
  form.value = {
    name: c.name, role_type: c.role_type, personality: c.personality,
    background: c.background, description: c.description,
    faction: c.faction || '', age: c.age || '', goal: c.goal || '', ability: c.ability || ''
  };
  dialogOpen.value = true;
}

async function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写角色名');
    return;
  }
  try {
    if (editingId.value) {
      await store.updateCharacter(editingId.value, form.value);
    } else {
      await store.createCharacter({
        ...form.value,
        avatar_color: ROLE_COLORS[form.value.role_type] || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]
      });
    }
    dialogOpen.value = false;
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function remove(c) {
  try {
    await ElMessageBox.confirm(`确定删除角色「${c.name}」吗？相关关系也会一并移除。`, '删除角色', { type: 'warning' });
  } catch { return; }
  try {
    await store.deleteCharacter(c.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function analyze() {
  analyzing.value = true;
  try {
    const list = await api.analyzeCharacters(store.novelId);
    if (!list || !list.length) {
      ElMessage.info('没有发现新的角色建议');
      return;
    }
    suggestions.value = list;
    selectedSug.value = list.map((_, i) => i);
    suggestOpen.value = true;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    analyzing.value = false;
  }
}

async function applySuggestions() {
  const picked = selectedSug.value.map((i) => suggestions.value[i]).filter(Boolean);
  const existing = new Set(store.characters.map((c) => c.name));
  const fresh = picked.filter((c) => !existing.has(c.name));
  if (!fresh.length) {
    ElMessage.info('所选角色均已存在');
    suggestOpen.value = false;
    return;
  }
  try {
    await store.applyAnalyzedCharacters(fresh);
    suggestOpen.value = false;
    ElMessage.success(`已添加 ${fresh.length} 个角色`);
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div class="char-panel">
    <div class="char-actions">
      <el-button type="primary" size="small" @click="openCreate">
        <el-icon style="margin-right:4px"><Plus /></el-icon>添加角色
      </el-button>
      <el-button size="small" :loading="analyzing" @click="analyze">
        <el-icon style="margin-right:4px"><MagicStick /></el-icon>智能分析
      </el-button>
    </div>

    <div class="char-grid">
      <div v-for="c in store.characters" :key="c.id" class="char-card" @click="openEdit(c)">
        <div class="char-avatar" :style="{ background: c.avatar_color || '#6366f1' }">
          {{ (c.name || '?').slice(0, 1) }}
        </div>
        <div class="char-info">
          <div class="char-name">
            {{ c.name }}
            <el-tag :type="roleTagType(c.role_type)" size="small" effect="light" style="margin-left:6px">
              {{ c.role_type }}
            </el-tag>
          </div>
          <div class="char-desc ellipsis">{{ c.personality || c.description || '暂无描述' }}</div>
          <div v-if="c.faction" class="char-faction ellipsis">势力：{{ c.faction }}</div>
        </div>
        <div class="char-del" @click.stop="remove(c)">
          <el-icon><Delete /></el-icon>
        </div>
      </div>
      <el-empty v-if="!store.characters.length" description="还没有角色，点击「智能分析」从章节中提取" :image-size="60" />
    </div>

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑角色' : '添加角色'" width="480px">
      <el-form :model="form" label-width="70px">
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" maxlength="20" placeholder="角色姓名" />
        </el-form-item>
        <el-form-item label="定位">
          <el-select v-model="form.role_type" style="width: 100%">
            <el-option v-for="r in ROLE_TYPES" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="性格">
          <el-input v-model="form.personality" placeholder="如：冷静果决、外冷内热" />
        </el-form-item>
        <el-form-item label="背景">
          <el-input v-model="form.background" type="textarea" :rows="2" placeholder="身世背景" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="form.description" type="textarea" :rows="3" placeholder="外貌、定位、与主角关系等" />
        </el-form-item>
        <el-form-item label="势力">
          <el-select v-model="form.faction" filterable allow-create clearable style="width: 100%" placeholder="选择或输入所属势力">
            <el-option v-for="f in store.factions" :key="f.id" :label="f.name" :value="f.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="年龄">
          <el-input v-model="form.age" maxlength="20" placeholder="如：25岁、少年、中年" />
        </el-form-item>
        <el-form-item label="目标">
          <el-input v-model="form.goal" type="textarea" :rows="2" placeholder="角色核心目标/动机" />
        </el-form-item>
        <el-form-item label="能力">
          <el-input v-model="form.ability" type="textarea" :rows="2" placeholder="特殊能力/武学/技能" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="suggestOpen" title="从章节中分析出的角色" width="520px">
      <div class="sug-list">
        <el-checkbox-group v-model="selectedSug" class="sug-group">
          <el-checkbox v-for="(s, i) in suggestions" :key="i" :value="i" class="sug-item">
            <span class="sug-name">{{ s.name }}</span>
            <el-tag size="small" type="info">{{ s.role_type }}</el-tag>
            <span class="sug-desc ellipsis">{{ s.personality || s.description }}</span>
          </el-checkbox>
        </el-checkbox-group>
      </div>
      <template #footer>
        <el-button @click="suggestOpen = false">取消</el-button>
        <el-button type="primary" @click="applySuggestions">添加所选角色</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.char-panel { height: 100%; overflow-y: auto; padding: 18px 20px; }
.char-actions { display: flex; gap: 8px; margin-bottom: 14px; }
.char-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.char-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid #eef0f6;
  border-radius: 10px;
  cursor: pointer;
  transition: box-shadow .12s;
  position: relative;
}
.char-card:hover { box-shadow: 0 2px 8px rgba(20,24,80,.08); }
.char-avatar {
  width: 40px; height: 40px;
  border-radius: 50%;
  color: #fff;
  font-weight: 700;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.char-info { flex: 1; min-width: 0; }
.char-name { font-size: 13px; font-weight: 600; }
.char-desc { font-size: 12px; color: #9ca3af; margin-top: 3px; }
.char-faction { font-size: 11px; color: #8b5cf6; margin-top: 2px; }
.char-del {
  opacity: 0;
  color: #ef4444;
  transition: opacity .12s;
}
.char-card:hover .char-del { opacity: 1; }
.sug-group { display: flex; flex-direction: column; gap: 8px; }
.sug-item { width: 100%; height: auto; margin-right: 0; padding: 8px; border: 1px solid #eef0f6; border-radius: 8px; display: flex; align-items: center; gap: 6px; }
.sug-name { font-weight: 600; }
.sug-desc { color: #9ca3af; font-size: 12px; max-width: 200px; }
</style>
