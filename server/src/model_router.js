// 多模型路由：同一部小说可同时启用多个 AI 大模型，按任务类型分发
// settings 表新增键 llm_models = JSON 数组，每条为 { id, name, enabled, tasks[], config }
import { getSetting, setSetting } from './db.js';
import { normalizeLLMConfig } from './lib.js';

// 任务类型定义（前端展示用）
export const TASK_TYPES = {
  writing: { name: '章节正文 / 润色', desc: '正文生成、打磨、续写，对文笔与一致性要求最高' },
  planning: { name: '大纲 / 规划', desc: '整体方案、大纲、剧情弧线、章节规划' },
  chat: { name: '对话 / 总管 AI', desc: '与 AI 聊天、总管式创作对话' },
  summary: { name: '摘要 / 记忆', desc: '章节摘要、记忆压缩、事实提取，追求速度与稳定' },
  analysis: { name: '分析 / 检测', desc: 'AI 味检测、风格学习、一致性检查、取名等' },
  research: { name: '联网 / 知识', desc: '联网搜索、知识库学习' }
};

export function getModels() {
  try {
    const list = JSON.parse(getSetting('llm_models') || '[]');
    if (!Array.isArray(list)) return [];
    return list.map((m) => m && m.id ? { ...m, config: normalizeLLMConfig(m.config || {}) } : m);
  } catch {
    return [];
  }
}

export function saveModels(models) {
  const safe = (Array.isArray(models) ? models : [])
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id,
      name: m.name || '未命名模型',
      enabled: !!m.enabled,
      tasks: Array.isArray(m.tasks) ? m.tasks : [],
      config: normalizeLLMConfig(m.config || {})
    }));
  setSetting('llm_models', JSON.stringify(safe));
  return safe;
}

function isUsable(cfg) {
  if (!cfg || !cfg.model) return false;
  if (cfg.provider === 'ollama' || cfg.provider === 'transformers') return true;
  return !!cfg.apiKey;
}

// 路由：返回某个任务应使用的模型配置；未配置多模型时返回 null（调用方回退到默认配置）
export function getTaskConfig(task) {
  if (!task) return null;
  const models = getModels().filter(
    (m) => m.enabled && Array.isArray(m.tasks) && m.tasks.includes(task)
  );
  if (!models.length) return null;
  const usable = models.find((m) => isUsable(m.config));
  const chosen = usable || models[0];
  return chosen ? normalizeLLMConfig(chosen.config) : null;
}

// 当前启用的模型概览（Settings 页展示 + 健康检测用）
export function getActiveModels() {
  return getModels().filter((m) => m.enabled);
}

// 生成唯一 id
export function genModelId() {
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

// 移除某任务在所有模型上的指派（改默认时用）
export function unassignTask(task) {
  const models = getModels().map((m) => ({
    ...m,
    tasks: Array.isArray(m.tasks) ? m.tasks.filter((t) => t !== task) : []
  }));
  saveModels(models);
}
