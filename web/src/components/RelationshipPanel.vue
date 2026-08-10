<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import api from '../api';
import { RELATION_TYPES, AVATAR_COLORS, ROLE_COLORS } from '../utils/format';

const store = useEditorStore();
const svgEl = ref(null);
const viewport = ref({ x: 0, y: 0, zoom: 1 });
const SIZE = { w: 600, h: 380 };
let draggingNode = null;      // { id, startX, startY }
let panning = null;           // for canvas pan
const positions = ref(new Map());  // Map<characterId, {x, y}>
let nextIdSeed = 0;
let saveAllTimer = null;      // Phase 增强 8：拖拽保存防抖
let pendingSaveIds = new Set();

// 来回加一个本地 hover/drag 状态切换
const draggingId = ref(null);

const dialogOpen = ref(false);
const editingId = ref(null);
const form = ref({ source_id: null, target_id: null, relation_type: '朋友', description: '' });

const nodes = computed(() => {
  const chars = (store.characters || []);
  return chars.map((c) => {
    const pos = positions.value.get(c.id);
    return {
      id: c.id,
      name: c.name,
      role_type: c.role_type,
      color: c.avatar_color || ROLE_COLORS[c.role_type] || '#6366f1',
      r: c.role_type === '主角' || c.role_type === '主角团' || c.role_type === '大反派' ? 26 : ['反派', '导师', '红颜', '重要配角'].includes(c.role_type) ? 19 : 16,
      x: pos?.x ?? 0,
      y: pos?.y ?? 0
    };
  });
});

const links = computed(() => store.relationships || []);

function ensurePositions() {
  // 没坐标的人数再绕圆均匀分布
  const chars = (store.characters || []);
  const list = chars.filter((c) => !positions.value.has(c.id));
  const cx = SIZE.w / 2, cy = SIZE.h / 2, R = 130;
  list.forEach((c, i) => {
    const angle = ((i + nextIdSeed) / Math.max(8, chars.length)) * Math.PI * 2;
    positions.value.set(c.id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
  });
  nextIdSeed++;
}

async function loadPositions() {
  if (!store.novelId) return;
  try {
    const rows = await api.getRelNodes(store.novelId);
    rows.forEach((r) => positions.value.set(r.character_id, { x: r.x, y: r.y }));
  } catch { /* ignore */ }
  ensurePositions();
}

async function saveNode(id) {
  if (!store.novelId) return;
  const p = positions.value.get(id);
  if (!p) return;
  pendingSaveIds.add(id);
  if (saveAllTimer) clearTimeout(saveAllTimer);
  saveAllTimer = setTimeout(async () => {
    const ids = Array.from(pendingSaveIds);
    pendingSaveIds.clear();
    saveAllTimer = null;
    if (!ids.length || !store.novelId) return;
    const nodes = ids.map((cid) => {
      const pos = positions.value.get(cid);
      return pos ? { character_id: cid, x: pos.x, y: pos.y } : null;
    }).filter(Boolean);
    try { await api.saveRelNodes(store.novelId, nodes); } catch { /* ignore */ }
  }, 800);
}

async function saveAll() {
  if (!store.novelId) return;
  const nodes = [];
  positions.value.forEach((p, cid) => nodes.push({ character_id: cid, x: p.x, y: p.y }));
  try { await api.saveRelNodes(store.novelId, nodes); } catch { /* ignore */ }
}

function toLocal(e) {
  const rect = svgEl.value.getBoundingClientRect();
  const scale = SIZE.w / rect.width;
  return {
    x: ((e.clientX - rect.left) - viewport.value.x) / viewport.value.zoom * scale,
    y: ((e.clientY - rect.top) - viewport.value.y) / viewport.value.zoom * scale
  };
}

function onNodeDown(e, node) {
  e.stopPropagation();
  e.preventDefault();
  draggingNode = { id: node.id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
  draggingId.value = node.id;
}

function onNodeMove(e) {
  if (!draggingNode) return;
  const dx = (e.clientX - draggingNode.startX) / viewport.value.zoom;
  const dy = (e.clientY - draggingNode.startY) / viewport.value.zoom;
  const nx = Math.max(20, Math.min(SIZE.w - 20, draggingNode.origX + dx));
  const ny = Math.max(20, Math.min(SIZE.h - 20, draggingNode.origY + dy));
  positions.value.set(draggingNode.id, { x: nx, y: ny });
}

async function onNodeUp() {
  if (draggingNode) {
    await saveNode(draggingNode.id);
    draggingNode = null;
  }
  draggingId.value = null;
}

function onCanvasDown(e) {
  if (e.target.tagName === 'svg' || e.target.classList?.contains('rel-bg')) {
    panning = { startX: e.clientX, startY: e.clientY, origX: viewport.value.x, origY: viewport.value.y };
  }
}

function onCanvasMove(e) {
  if (panning) {
    viewport.value.x = panning.origX + (e.clientX - panning.startX);
    viewport.value.y = panning.origY + (e.clientY - panning.startY);
  }
}

function onCanvasUp() { panning = null; }

function onWheel(e) {
  e.preventDefault?.();
  const dir = e.deltaY > 0 ? -1 : 1;
  const factor = 1 + 0.1 * dir;
  viewport.value.zoom = Math.max(0.3, Math.min(3, viewport.value.zoom * factor));
}

function resetView() {
  viewport.value = { x: 0, y: 0, zoom: 1 };
}

async function showNodeInfo(c) {
  await ElMessageBox.alert(
    `<div style="line-height:1.8">角色：<b>${c.name}</b>（${c.role_type}）<br/>性格：${c.personality || '—'}<br/>背景：${c.background || '—'}<br/>描述：${c.description || '—'}</div>`,
    `角色 · ${c.name}`,
    { dangerouslyUseHTMLString: true, confirmButtonText: '知道了', showClose: false }
  ).catch(() => {});
}

function openCreate() {
  editingId.value = null;
  form.value = { source_id: null, target_id: null, relation_type: '朋友', description: '' };
  dialogOpen.value = true;
}

function openEdit(r) {
  editingId.value = r.id;
  form.value = {
    source_id: r.source_id, target_id: r.target_id,
    relation_type: r.relation_type, description: r.description
  };
  dialogOpen.value = true;
}

async function save() {
  if (!form.value.source_id || !form.value.target_id) {
    ElMessage.warning('请选择双方角色');
    return;
  }
  if (form.value.source_id === form.value.target_id) {
    ElMessage.warning('不能与自己建立关系');
    return;
  }
  try {
    if (editingId.value) {
      await store.updateRelationship(editingId.value, form.value);
    } else {
      await store.createRelationship(form.value);
    }
    dialogOpen.value = false;
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function remove(r) {
  try {
    await ElMessageBox.confirm('确定删除这条关系吗？', '删除关系', { type: 'warning' });
  } catch { return; }
  try {
    await store.deleteRelationship(r.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function recenterAll() {
  // 重排所有节点圆周分布
  positions.value.clear();
  ensurePositions();
  await saveAll();
  ElMessage.success('已自动布局');
}

watch(() => store.characters, ensurePositions, { deep: true });
watch(() => store.novelId, async (id) => { if (id) { positions.value.clear(); await loadPositions(); } });

onMounted(async () => {
  await loadPositions();
  window.addEventListener('mousemove', onNodeMove);
  window.addEventListener('mousemove', onCanvasMove);
  window.addEventListener('mouseup', onNodeUp);
  window.addEventListener('mouseup', onCanvasUp);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onNodeMove);
  window.removeEventListener('mousemove', onCanvasMove);
  window.removeEventListener('mouseup', onNodeUp);
  window.removeEventListener('mouseup', onCanvasUp);
});
</script>

<template>
  <div class="rel-panel">
    <div class="rel-actions">
      <el-button type="primary" size="small" @click="openCreate">
        <el-icon style="margin-right:4px"><Plus /></el-icon>添加关系
      </el-button>
      <el-button size="small" @click="recenterAll">
        <el-icon style="margin-right:4px"><RefreshRight /></el-icon>自动布局
      </el-button>
      <el-button size="small" @click="resetView">
        <el-icon style="margin-right:4px"><FullScreen /></el-icon>重置视图
      </el-button>
      <span class="rel-tip">拖拽圆点移动角色 · 滚轮缩放 · 拖空白平移 · 节点位置自动保存</span>
    </div>

    <div class="svg-wrap">
      <svg
        ref="svgEl"
        :viewBox="`0 0 ${SIZE.w} ${SIZE.h}`"
        class="rel-chart"
        @mousedown="onCanvasDown"
        @wheel.prevent="onWheel"
      >
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 Z" fill="#94a3b8" />
          </marker>
        </defs>
        <g class="viewport" :transform="`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`">
          <rect class="rel-bg" :x="0" :y="0" :width="SIZE.w" :height="SIZE.h" fill="transparent" />
          <!-- edges -->
          <g class="edges">
            <g v-for="l in links" :key="l.id">
              <line
                :x1="nodes.find(n => n.id === l.source_id)?.x"
                :y1="nodes.find(n => n.id === l.source_id)?.y"
                :x2="nodes.find(n => n.id === l.target_id)?.x"
                :y2="nodes.find(n => n.id === l.target_id)?.y"
                stroke="#94a3b8"
                stroke-width="1.5"
                marker-end="url(#arr)"
                opacity="0.7"
              />
              <text
                :x="((nodes.find(n => n.id === l.source_id)?.x || 0) + (nodes.find(n => n.id === l.target_id)?.x || 0)) / 2"
                :y="((nodes.find(n => n.id === l.source_id)?.y || 0) + (nodes.find(n => n.id === l.target_id)?.y || 0)) / 2"
                class="rel-label"
              >{{ l.relation_type }}</text>
            </g>
          </g>
          <!-- nodes -->
          <g class="nodes">
            <g
              v-for="n in nodes"
              :key="n.id"
              :transform="`translate(${n.x} ${n.y})`"
              class="rel-node"
              :class="{ dragging: draggingId === n.id }"
              @mousedown="(e) => onNodeDown(e, n)"
            >
              <circle :r="n.r" :fill="n.color" />
              <text class="node-label" :y="n.r + 14">{{ n.name }}</text>
            </g>
          </g>
        </g>
      </svg>
    </div>

    <div class="rel-list">
      <div v-for="r in store.relationships" :key="r.id" class="rel-item">
        <div class="rel-names">
          <span class="rel-name">{{ r.source_name }}</span>
          <span class="rel-type">{{ r.relation_type }}</span>
          <span class="rel-name">{{ r.target_name }}</span>
        </div>
        <div class="rel-desc ellipsis">{{ r.description || '' }}</div>
        <div class="rel-op">
          <el-icon class="op-edit" @click="openEdit(r)"><Edit /></el-icon>
          <el-icon class="op-del" @click="remove(r)"><Delete /></el-icon>
        </div>
      </div>
      <el-empty v-if="!store.relationships.length" description="添加角色关系，图会实时更新" :image-size="60" />
    </div>

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑关系' : '添加关系'" width="440px">
      <el-form :model="form" label-width="70px">
        <el-form-item label="角色 A" required>
          <el-select v-model="form.source_id" style="width: 100%" placeholder="选择角色">
            <el-option v-for="c in store.characters" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关系类型">
          <el-select v-model="form.relation_type" style="width: 100%" allow-create filterable default-first-option>
            <el-option v-for="r in RELATION_TYPES" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="角色 B" required>
          <el-select v-model="form.target_id" style="width: 100%" placeholder="选择角色">
            <el-option v-for="c in store.characters" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="关系细节" />
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
.rel-panel { height: 100%; overflow-y: auto; padding: 12px; }
.rel-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.rel-tip { font-size: 11px; color: #9ca3af; margin-left: auto; }
.svg-wrap { background: #fafbff; border: 1px solid #eef0f6; border-radius: 10px; padding: 0; height: 360px; overflow: hidden; }
.rel-chart { width: 100%; height: 360px; display: block; cursor: grab; }
.rel-chart:active { cursor: grabbing; }
.rel-node { cursor: grab; }
.rel-node.dragging { cursor: grabbing; }
.rel-node circle { stroke: #fff; stroke-width: 2; filter: drop-shadow(0 1px 3px rgba(0,0,0,.2)); }
.node-label { text-anchor: middle; font-size: 12px; fill: #1f2937; font-weight: 600; user-select: none; }
.rel-label { text-anchor: middle; font-size: 10px; fill: #64748b; }
.rel-list { margin-top: 10px; }
.rel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  margin-bottom: 6px;
}
.rel-names { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.rel-name { font-size: 13px; font-weight: 600; }
.rel-type { font-size: 11px; color: #4f46e5; background: #eef0ff; padding: 1px 8px; border-radius: 10px; }
.rel-desc { flex: 1; min-width: 0; font-size: 12px; color: #9ca3af; }
.rel-op { display: flex; gap: 6px; color: #9ca3af; cursor: pointer; }
.op-edit:hover { color: #4f46e5; }
.op-del:hover { color: #ef4444; }
</style>
