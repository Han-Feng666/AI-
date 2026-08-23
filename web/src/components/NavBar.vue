<script setup>
import { computed } from 'vue';
import { useEditorStore } from '../stores/editor';

const store = useEditorStore();

const items = computed(() => {
  const base = [
    { id: 'chapters', label: '章节', icon: 'Notebook' },
    { id: 'characters', label: '角色', icon: 'User' },
    { id: 'settings', label: '设定', icon: 'Collection' },
    { id: 'foreshadowings', label: '伏笔', icon: 'Link' },
    { id: 'relationships', label: '关系网', icon: 'Share' },
    { id: 'styles', label: '风格', icon: 'Brush' },
    { id: 'skills', label: '技能', icon: 'Lightning' },
    { id: 'outline', label: '大纲', icon: 'Map' },
    { id: 'stats', label: '统计', icon: 'DataLine' },
    { id: 'setup', label: '创作设置', icon: 'MagicStick' }
  ];
  return base;
});

const chapterCount = computed(() => store.chapters.filter((c) => c.word_count).length);
const foreshadowCount = computed(() => store.foreshadowings.filter((f) => f.status === 'open').length);
</script>

<template>
  <div class="nav-bar">
    <div
      v-for="item in items"
      :key="item.id"
      class="nav-item"
      :class="{ active: store.workspace === item.id }"
      :title="item.label"
      @click="store.setWorkspace(item.id)"
    >
      <div class="nav-icon">
        <el-icon :size="20"><component :is="item.icon" /></el-icon>
      </div>
      <span class="nav-label">{{ item.label }}</span>
      <span
        v-if="item.id === 'chapters' && chapterCount"
        class="nav-badge"
        title="已写章节数"
      >{{ chapterCount }}</span>
      <span
        v-else-if="item.id === 'foreshadowings' && foreshadowCount"
        class="nav-badge"
        title="待回收伏笔数"
      >{{ foreshadowCount }}</span>
    </div>
  </div>
</template>

<style scoped>
.nav-bar {
  height: 100%;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}
.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 2px;
  border-radius: 10px;
  cursor: pointer;
  color: #6b7280;
  transition: background .12s, color .12s;
  border: 1px solid transparent;
}
.nav-item:hover { background: #f5f6fd; color: #4f46e5; }
.nav-item.active {
  background: #eef0ff;
  color: #4f46e5;
  border-color: #c7d2fe;
}
.nav-label { font-size: 11px; line-height: 1; }
.nav-icon { display: flex; align-items: center; justify-content: center; }
.nav-badge {
  position: absolute;
  top: 6px;
  right: 8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
</style>
