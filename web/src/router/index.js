import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/Home.vue') },
  { path: '/novel/:id', name: 'editor', component: () => import('../views/Editor.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
  { path: '/styles', name: 'styles', component: () => import('../views/StyleLibrary.vue') },
  { path: '/ideas', name: 'ideas', component: () => import('../views/InspirationGenerator.vue') },
  { path: '/knowledge', name: 'knowledge', component: () => import('../views/KnowledgeBase.vue') },
  { path: '/shared-characters', name: 'shared-characters', component: () => import('../views/SharedCharacters.vue') },
  { path: '/skills', name: 'skills', component: () => import('../views/SkillsLibrary.vue') }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

export default router;
