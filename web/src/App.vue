<script setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingsStore } from './stores/settings';

const route = useRoute();
const settings = useSettingsStore();

const isDark = ref(false);

function applyDark(dark) {
  isDark.value = dark;
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('novel_studio_theme', dark ? 'dark' : 'light');
}

function toggleTheme() {
  applyDark(!isDark.value);
}

onMounted(() => {
  if (!settings.loaded) settings.load();
  applyDark(localStorage.getItem('novel_studio_theme') === 'dark');
});
</script>

<template>
  <el-config-provider>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <el-icon :size="26"><MagicStick /></el-icon>
          <div class="brand-text">
            <div class="brand-name">AI 小说工坊</div>
            <div class="brand-sub">智能创作引擎</div>
          </div>
        </div>
        <el-menu
          :default-active="route.path"
          router
          class="nav-menu"
        >
          <el-menu-item index="/">
            <el-icon><Collection /></el-icon>
            <span>我的书架</span>
          </el-menu-item>
          <el-menu-item index="/settings">
            <el-icon><Setting /></el-icon>
            <span>设置</span>
          </el-menu-item>
          <el-menu-item index="/styles">
            <el-icon><Brush /></el-icon>
            <span>风格库</span>
          </el-menu-item>
          <el-menu-item index="/knowledge">
            <el-icon><Reading /></el-icon>
            <span>知识学习库</span>
          </el-menu-item>
        </el-menu>
        <div class="sidebar-footer">
          <el-button link class="theme-toggle" @click="toggleTheme">
            <el-icon><Moon v-if="!isDark" /><Sunny v-else /></el-icon>
            <span>{{ isDark ? '浅色模式' : '深色模式' }}</span>
          </el-button>
          <el-tag :type="settings.isConfigured ? 'success' : 'danger'" effect="plain" size="small" round>
            {{ settings.isConfigured ? '模型已连接' : '未配置模型' }}
          </el-tag>
        </div>
      </aside>
      <main class="main">
        <router-view v-slot="{ Component }">
          <keep-alive :include="['InspirationGenerator']">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </main>
    </div>
  </el-config-provider>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: linear-gradient(180deg, #1e1b4b 0%, #312e81 100%);
  display: flex;
  flex-direction: column;
  color: #fff;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 22px 20px 18px;
}
.brand-name { font-size: 18px; font-weight: 700; letter-spacing: 1px; }
.brand-sub { font-size: 11px; color: #a5b4fc; margin-top: 2px; }
.nav-menu {
  flex: 1;
  border-right: none;
  background: transparent;
  padding: 0 10px;
}
.nav-menu :deep(.el-menu-item) {
  color: #c7d2fe;
  border-radius: 8px;
  margin-bottom: 4px;
}
.nav-menu :deep(.el-menu-item:hover) { background: rgba(255,255,255,0.08); color: #fff; }
.nav-menu :deep(.el-menu-item.is-active) {
  background: rgba(255,255,255,0.16);
  color: #fff;
}
.sidebar-footer {
  padding: 16px 20px;
  border-top: 1px solid rgba(255,255,255,0.12);
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.theme-toggle {
  color: #c7d2fe;
  font-size: 12px;
  padding: 0;
}
.theme-toggle:hover { color: #fff; }
.main {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
