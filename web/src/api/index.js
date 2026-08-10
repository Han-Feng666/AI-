import axios from 'axios';

const http = axios.create({
  baseURL: '/api',
  timeout: 60000
});

http.interceptors.response.use(
  (r) => r.data,
  (err) => {
    const msg = err?.response?.data?.error || err.message || '请求失败';
    return Promise.reject(new Error(msg));
  }
);

// 流式请求：解析后端 SSE，返回 AbortController 以便取消
export async function streamRequest(url, body, { onStatus, onDelta, onError, onProgress, idleTimeout = 120000 } = {}) {
  const ctrl = new AbortController();
  let timer;
  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), idleTimeout);
  };
  resetTimer();
  let resp;
  try {
    resp = await fetch(`/api${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('已停止');
    throw new Error('网络请求失败，请检查后端服务是否运行');
  }

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      msg = j.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!resp.body) {
    clearTimeout(timer);
    throw new Error('响应内容为空');
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const cleanup = () => clearTimeout(timer);

  const parse = async () => {
    try {
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (e.name === 'AbortError') throw new Error('已停止');
          throw new Error('连接中断');
        }
        resetTimer();
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          let obj;
          try {
            obj = JSON.parse(t.slice(5).trim());
          } catch { continue; }
          if (obj.type === 'status' && onStatus) onStatus(obj.message);
          else if (obj.type === 'delta' && onDelta) onDelta(obj.content);
          else if (obj.type === 'progress' && onProgress) onProgress(obj.progress, obj.message);
          else if (obj.type === 'error' && onError) onError(obj.message);
          else if (obj.type === 'done') return obj.data;
          else if (obj.type === 'aborted') throw new Error('已停止');
        }
      }
      throw new Error('连接中断');
    } finally {
      cleanup();
    }
  };

  const promise = parse();
  promise.abort = () => { clearTimeout(timer); ctrl.abort(); };
  return promise;
}

export const api = {
  // 小说
  listNovels: () => http.get('/novels'),
  getNovel: (id) => http.get(`/novels/${id}`),
  createNovel: (data) => http.post('/novels', data),
  updateNovel: (id, data) => http.put(`/novels/${id}`, data),
  deleteNovel: (id) => http.delete(`/novels/${id}`),

  // 大纲
  generatePlan: (id, data, handlers) => streamRequest(`/novels/${id}/plan`, data, handlers),
  revisePlan: (id, data, handlers) => streamRequest(`/novels/${id}/plan/revise`, data, handlers),

  // 方案版本化（Phase 3）
  listPlanVersions: (id) => http.get(`/novels/${id}/plan/versions`),
  getPendingPlan: (id) => http.get(`/novels/${id}/plan/pending`),
  acceptPlanVersion: (id, vid) => http.post(`/novels/${id}/plan/versions/${vid}/accept`),
  rollbackPlanVersion: (id, vid) => http.post(`/novels/${id}/plan/versions/${vid}/rollback`),
  getPlanDraft: (id) => http.get(`/novels/${id}/plan/draft`),
  savePlanDraft: (id, data) => http.put(`/novels/${id}/plan/draft`, data),

  // 生成任务 Job（Phase 2）
  getActiveJob: (id) => http.get(`/novels/${id}/job`).then((r) => r.job),
  listActiveJobs: () => http.get('/jobs/active').then((r) => r.jobs),

  // Manager 总管 AI（Phase 5 / Phase 6）
  managerChat: (novelId, body) => http.post('/manager/chat', body),
  managerAuthorize: (callId) => http.post(`/manager/tool/${callId}/authorize`),
  managerReject: (callId) => http.post(`/manager/tool/${callId}/reject`),
  managerMessages: (novelId) => http.get('/manager/messages', { params: { novel_id: novelId || undefined } }),
  managerClear: (novelId) => http.delete('/manager/messages', { params: { novel_id: novelId || undefined } }),

  // Phase 8：关系节点坐标
  getRelNodes: (id) => http.get(`/novels/${id}/relationship-nodes`).then((r) => r.nodes),
  saveRelNode: (id, cid, x, y) => http.put(`/novels/${id}/relationship-nodes/${cid}`, { x, y }),
  saveRelNodes: (id, nodes) => http.put(`/novels/${id}/relationship-nodes`, { nodes }),

  // 共享角色池（Phase 增强 1）
  listSharedCharacters: () => http.get('/shared-characters').then((r) => r.characters),
  createSharedCharacter: (body) => http.post('/shared-characters', body),
  updateSharedCharacter: (sid, body) => http.put(`/shared-characters/${sid}`, body),
  deleteSharedCharacter: (sid) => http.delete(`/shared-characters/${sid}`),
  introduceSharedCharacter: (novelId, sid) => http.post(`/novels/${novelId}/shared-characters/${sid}/introduce`),
  promoteToShared: (novelId, cid) => http.post(`/novels/${novelId}/characters/${cid}/promote`).then((r) => r),

  // Manager 长期记忆（Phase 增强 2）
  listManagerMemory: (novelId) => http.get('/manager/memory', { params: { novel_id: novelId || undefined } }).then((r) => r.memories),
  createManagerMemory: (body) => http.post('/manager/memory', body),
  updateManagerMemory: (mid, body) => http.put(`/manager/memory/${mid}`, body),
  deleteManagerMemory: (mid) => http.delete(`/manager/memory/${mid}`),

  // 章节
  getChapters: (id) => http.get(`/novels/${id}/chapters`),
  getChapter: (id, idx) => http.get(`/novels/${id}/chapters/${idx}`),
  updateChapter: (id, idx, data) => http.put(`/novels/${id}/chapters/${idx}`, data),
  deleteChapter: (id, idx) => http.delete(`/novels/${id}/chapters/${idx}`),
  generateChapter: (id, data, handlers) => streamRequest(`/novels/${id}/chapters/generate`, data, handlers),
  polishChapter: (id, idx, handlers) => streamRequest(`/novels/${id}/chapters/${idx}/polish`, {}, handlers),

  // 导出
  exportNovel: (id) => http.get(`/novels/${id}/export`, { responseType: 'text' }),

  // 对话
  getChat: (id) => http.get(`/novels/${id}/chat`),
  clearChat: (id) => http.delete(`/novels/${id}/chat`),
  sendChat: (id, data, handlers) => streamRequest(`/novels/${id}/chat`, data, handlers),

  // 角色
  getCharacters: (id) => http.get(`/novels/${id}/characters`),
  createCharacter: (id, data) => http.post(`/novels/${id}/characters`, data),
  updateCharacter: (id, cid, data) => http.put(`/novels/${id}/characters/${cid}`, data),
  deleteCharacter: (id, cid) => http.delete(`/novels/${id}/characters/${cid}`),
  analyzeCharacters: (id) => http.post(`/novels/${id}/characters/analyze`),

  // 势力
  getFactions: (id) => http.get(`/novels/${id}/factions`),
  createFaction: (id, data) => http.post(`/novels/${id}/factions`, data),
  updateFaction: (id, fid, data) => http.put(`/novels/${id}/factions/${fid}`, data),
  deleteFaction: (id, fid) => http.delete(`/novels/${id}/factions/${fid}`),

  // 关系
  getRelationships: (id) => http.get(`/novels/${id}/relationships`),
  createRelationship: (id, data) => http.post(`/novels/${id}/relationships`, data),
  updateRelationship: (id, rid, data) => http.put(`/novels/${id}/relationships/${rid}`, data),
  deleteRelationship: (id, rid) => http.delete(`/novels/${id}/relationships/${rid}`),

  // 伏笔追踪
  getForeshadowings: (id) => http.get(`/novels/${id}/foreshadowings`),
  createForeshadowing: (id, data) => http.post(`/novels/${id}/foreshadowings`, data),
  updateForeshadowing: (id, fid, data) => http.put(`/novels/${id}/foreshadowings/${fid}`, data),
  deleteForeshadowing: (id, fid) => http.delete(`/novels/${id}/foreshadowings/${fid}`),
  analyzeForeshadowings: (id) => http.post(`/novels/${id}/foreshadowings/analyze`),

  // AI 味检测 / 文风基准
  detectChapter: (id, idx) => http.post(`/novels/${id}/chapters/${idx}/detect`),
  extractStyle: (id) => http.post(`/novels/${id}/extract-style`),
  getAiTrend: (id) => http.get(`/novels/${id}/ai-trend`),
  saveStyleSamples: (id, samples) => http.post(`/novels/${id}/style-samples`, { samples }),

  // 世界观设定
  getWorldSettings: (id) => http.get(`/novels/${id}/world-settings`),
  createWorldSetting: (id, data) => http.post(`/novels/${id}/world-settings`, data),
  updateWorldSetting: (id, sid, data) => http.put(`/novels/${id}/world-settings/${sid}`, data),
  deleteWorldSetting: (id, sid) => http.delete(`/novels/${id}/world-settings/${sid}`),

  // 章节历史备份
  getBackups: (id, idx) => http.get(`/novels/${id}/chapters/${idx}/backups`),
  restoreBackup: (id, idx, bid) => http.post(`/novels/${id}/chapters/${idx}/backups/${bid}/restore`),

  // 上下文压缩
  compressContext: (id, handlers) => streamRequest(`/novels/${id}/compress`, {}, handlers),
  restoreContext: (id) => http.post(`/novels/${id}/compress/restore`),

  // 风格库
  listStyles: () => http.get('/styles'),
  getStyle: (id) => http.get(`/styles/${id}`),
  createStyle: (data, handlers) => streamRequest('/styles', data, handlers),
  updateStyle: (id, data) => http.put(`/styles/${id}`, data),
  deleteStyle: (id) => http.delete(`/styles/${id}`),

  // 设置
  getSettings: () => http.get('/settings'),
  saveSettings: (data) => http.put('/settings', data),
  testLLM: (llm_config) => http.post('/settings/test', { llm_config }),
  fetchModels: (llm_config) => http.post('/settings/models', { llm_config }),

  // LLM 预设
  getLLMPresets: () => http.get('/settings/llm-presets').then((r) => r.presets),
  saveLLMPreset: (name, llm_config) => http.post('/settings/llm-presets', { name, llm_config }),
  updateLLMPreset: (pid, data) => http.put(`/settings/llm-presets/${pid}`, data),
  deleteLLMPreset: (pid) => http.delete(`/settings/llm-presets/${pid}`),
  applyLLMPreset: (pid) => http.post(`/settings/llm-presets/${pid}/apply`).then((r) => r.llm_config),

  // 多 AI 大模型（同时启用多个，按任务路由）
  getLLMModels: () => http.get('/settings/llm-models'),
  createLLMModel: (model) => http.post('/settings/llm-models', model),
  updateLLMModel: (mid, patch) => http.put(`/settings/llm-models/${mid}`, patch),
  deleteLLMModel: (mid) => http.delete(`/settings/llm-models/${mid}`),
  testLLMRoute: (task) => http.post('/settings/llm-models/route-test', { task }),

  // 知识学习库
  importKnowledge: (data, handlers) => streamRequest('/knowledge/import', data, handlers),
  listKnowledge: (genre) => http.get('/knowledge/corpora', { params: genre ? { genre } : {} }),
  getKnowledge: (id) => http.get(`/knowledge/corpora/${id}`),
  getKnowledgeSamples: (id) => http.get(`/knowledge/corpora/${id}/samples`),
  deleteKnowledge: (id) => http.delete(`/knowledge/corpora/${id}`),
  listKnowledgeByGenres: (genres) => http.get('/knowledge/by-genres', { params: { genres } }),

  // 本地大模型
  getLocalModelStatus: () => http.get('/local-model/status'),
  detectOllama: () => http.post('/local-model/detect-ollama', {}),
  selectOllamaModel: (model, url) => http.post('/local-model/ollama/select', { model, url }),
  setLocalMode: (mode) => http.post('/local-model/mode', { mode }),
  setHfEndpoint: (endpoint) => http.post('/local-model/hf-endpoint', { endpoint }),
  offlineLearnCorpus: (id) => http.post(`/knowledge/corpora/${id}/offline-learn`, {}),
  autoLearn: (novelId) => http.post('/local-model/auto-learn', { novelId }),

  // 自主学习系统
  startAutoLearn: () => http.post('/local-model/auto-learn/start', {}),
  stopAutoLearn: () => http.post('/local-model/auto-learn/stop', {}),
  getAutoLearnStatus: () => http.get('/local-model/auto-learn/status'),
  triggerPendingTasks: () => http.post('/local-model/auto-learn/trigger', {}),
  enqueueAutoLearnTask: (task) => http.post('/local-model/auto-learn/enqueue', task),

  // 本地知识图谱
  getKnowledgeGraph: (novelId) => http.get(`/knowledge-graph/${novelId}`),
  analyzeTextGraph: (text) => http.post('/knowledge-graph/analyze', { text }),

  // RAG 缓存
  getRagCacheStatus: (novelId) => http.get(`/rag-cache/${novelId}`),
  clearRagCache: () => http.post('/rag-cache/clear', {}),
  searchRag: (novelId, query, topK) => http.post('/rag-cache/search', { novelId, query, topK }),

  // 本地对话测试
  localChatTest: (messages, sessionKey) => http.post('/local-model/chat-test', { messages, sessionKey }),

  // Ollama 内置安装器
  getOllamaInstallStatus: () => http.get('/ollama-installer/status'),
  getRecommendedModels: () => http.get('/ollama-installer/models'),
  installOllama: () => http.post('/ollama-installer/install', {}),
  pullModel: (model) => http.post('/ollama-installer/pull', { model }),

  // 内置推理引擎（transformers.js）
  getTransformersStatus: () => http.get('/transformers/status'),
  getBuiltinModels: () => http.get('/transformers/models'),
  installTransformers: (model, handlers) =>
    streamRequest('/transformers/install', { model }, handlers),

  // 本地模型生成章节（离线模式）
  localGenerateChapter: (novelId, chapterNumber, targetWords, handlers) =>
    streamRequest(`/local-model/generate-chapter`, { novelId, chapterNumber, targetWords }, handlers),

  // 取名系统
  namegen: (genre, type = 'character', count = 5) => http.get(`/namegen`, { params: { genre, type, count } }),
  namegenAI: (genre, type, count, context) => http.post('/namegen/ai', { genre, type, count, context }),

  // 章节大纲细化（场景级 beat）
  getChapterBeats: (novelId, chapterIndex) => http.post(`/novels/${novelId}/chapters/${chapterIndex}/beats`, {}),

  // 章节摘要自动生成
  autoSummary: (novelId, chapterIndex) => http.post(`/novels/${novelId}/chapters/${chapterIndex}/auto-summary`, {}),

  // 情节连贯性检查
  consistencyCheck: (novelId, chapterIndex) => http.post(`/novels/${novelId}/consistency-check`, { chapterIndex }),

  // 文笔风格学习
  styleLearn: (novelId, sampleText) => http.post(`/novels/${novelId}/style-learn`, { sampleText }),
  styleLearnFromChapters: (novelId, chapterCount) => http.post(`/novels/${novelId}/style-learn-from-chapters`, { chapterCount }),
  styleLearnOffline: (novelId) => http.post(`/novels/${novelId}/style-learn-offline`, {}),

  // 题材模板查询
  getGenreTemplates: (genre) => http.get(`/genre-templates/${genre}`),

  // 角色台词生成
  generateCharDialog: (novelId, characterName) => http.post(`/novels/${novelId}/character-dialog`, { characterName }),

  // 剧情弧线规划
  arcPlan: (novelId) => http.post(`/novels/${novelId}/arc-plan`),

  // 世界设定细化
  worldExpand: (novelId) => http.post(`/novels/${novelId}/world-expand`),

  // 章节情绪曲线分析
  emotionCurve: (novelId, start, end) => http.post(`/novels/${novelId}/emotion-curve`, { start, end }),

  // 联网搜索
  search: (query, opts = {}) => http.post('/search', { query, ...opts }),
  getSearchSettings: () => http.get('/search/settings'),
  saveSearchSettings: (data) => http.put('/search/settings', data),
};

export default api;
