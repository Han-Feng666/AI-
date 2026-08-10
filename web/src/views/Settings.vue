<script setup>
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useSettingsStore } from '../stores/settings';
import api from '../api';

const store = useSettingsStore();
const testing = ref(false);
const testResult = ref(null);
const showKey = ref(false);

// 可用模型列表（从平台 /v1/models 拉取）
const fetchingModels = ref(false);
const modelOptions = ref([]);
const showModelSelect = ref(false);

// LLM 预设
const selectedPresetId = ref('');
const showSavePresetDialog = ref(false);
const newPresetName = ref('');
const savingPreset = ref(false);

// 多 AI 大模型（同时启用多个，按任务路由）
const taskOptions = ref([]);
const showModelDialog = ref(false);
const editingModel = ref(null);
const modelDraft = ref({ name: '', enabled: true, tasks: [], config: {} });
const savingModel = ref(false);
const checkTask = ref('writing');
const routingInfo = ref({});

async function loadModels() {
  try {
    const r = await store.loadModels();
    taskOptions.value = Object.entries(r.tasks || {}).map(([value, t]) => ({ value, label: t.name, desc: t.desc }));
  } catch (e) {
    ElMessage.error('加载多模型配置失败：' + e.message);
  }
}

function openAddModel() {
  editingModel.value = null;
  modelDraft.value = {
    name: '',
    enabled: true,
    tasks: ['writing'],
    config: { ...store.llm_config }
  };
  showModelDialog.value = true;
}

function openEditModel(m) {
  editingModel.value = m;
  modelDraft.value = {
    name: m.name || '',
    enabled: !!m.enabled,
    tasks: [...(m.tasks || [])],
    config: { ...(m.config || {}) }
  };
  showModelDialog.value = true;
}

async function saveModel() {
  const cfg = modelDraft.value.config;
  if (!cfg.baseUrl || !cfg.model) return ElMessage.warning('请填写 Base URL 与模型名称');
  if (!modelDraft.value.tasks.length) return ElMessage.warning('请至少指派一个任务类型');
  savingModel.value = true;
  try {
    const payload = {
      name: modelDraft.value.name || cfg.model,
      enabled: modelDraft.value.enabled,
      tasks: modelDraft.value.tasks,
      config: cfg
    };
    if (editingModel.value) {
      await store.updateModel(editingModel.value.id, payload);
      ElMessage.success('模型已更新');
    } else {
      await store.addModel(payload);
      ElMessage.success('模型已添加，可按任务类型同时启用');
    }
    showModelDialog.value = false;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    savingModel.value = false;
  }
}

async function toggleModel(m, val) {
  try {
    await store.updateModel(m.id, { enabled: val });
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeModel(m) {
  try {
    await store.deleteModel(m.id);
    ElMessage.success('已删除模型');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function taskLabel(task) {
  const t = taskOptions.value.find((o) => o.value === task);
  return t ? t.label : task;
}

async function checkRouting(task) {
  try {
    routingInfo.value = { task, ...(await api.testLLMRoute(task)) };
  } catch (e) {
    routingInfo.value = { task, routed: false, error: e.message };
  }
}

async function onPresetChange(pid) {
  if (!pid) return;
  try {
    await store.applyPreset(pid);
    testResult.value = null;
    ElMessage.success(`已切换到预设「${store.llm_presets.find(p=>p.id===pid)?.name || ''}」`);
    scheduleAutoFetch();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function saveAsPreset() {
  const name = newPresetName.value.trim();
  if (!name) return ElMessage.warning('请填写预设名称');
  savingPreset.value = true;
  try {
    await store.savePresetAs(name);
    ElMessage.success(`预设「${name}」已保存`);
    showSavePresetDialog.value = false;
    newPresetName.value = '';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    savingPreset.value = false;
  }
}

async function deletePreset(pid) {
  try {
    await store.deletePreset(pid);
    if (selectedPresetId.value === pid) selectedPresetId.value = '';
    ElMessage.success('预设已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// 防抖：Base URL / Key 变更后自动拉取模型（像 code 工具一样输入即拉取）
let fetchTimer = null;
let lastFetchKey = '';
function scheduleAutoFetch() {
  const cfg = store.llm_config;
  const key = `${cfg.baseUrl}|${cfg.apiKey}`;
  if (!cfg.baseUrl.trim() || (needKey.value && !cfg.apiKey.trim())) {
    modelOptions.value = [];
    showModelSelect.value = false;
    return;
  }
  if (key === lastFetchKey) return;
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => {
    lastFetchKey = key;
    fetchModels(true);
  }, 600);
}

// 作品存放位置
const storageRoot = ref('');
const migrateNovels = ref(true);
const savingStorage = ref(false);

// 联网搜索
const searchSettings = ref({ search_engine: 'duckduckgo', searx_url: '', bing_api_key: '', bing_endpoint: '' });
const savingSearch = ref(false);

async function loadSearchSettings() {
  try {
    searchSettings.value = await api.getSearchSettings();
  } catch { /* ignore */ }
}

async function saveSearchSettings() {
  savingSearch.value = true;
  try {
    await api.saveSearchSettings(searchSettings.value);
    ElMessage.success('搜索设置已保存');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    savingSearch.value = false;
  }
}

// 本地大模型
const localStatus = ref(null);
const localLoading = ref(false);
const detecting = ref(false);
const selectedOllamaModel = ref('');
const localMode = ref('auto');

async function loadLocalStatus() {
  localLoading.value = true;
  try {
    localStatus.value = await api.getLocalModelStatus();
    localMode.value = localStatus.value?.mode || 'auto';
    selectedOllamaModel.value = localStatus.value?.ollama?.selectedModel || '';
    if (localStatus.value?.transformers?.selectedModel) {
      transformersModel.value = localStatus.value.transformers.selectedModel;
    }
    hfEndpoint.value = localStatus.value?.hfEndpoint || localStatus.value?.transformers?.hfEndpoint || '';
    hfEndpointSaved.value = hfEndpoint.value;
  } catch { /* ignore */ } finally {
    localLoading.value = false;
  }
}

async function detectOllamaNow() {
  detecting.value = true;
  try {
    // 先检查后端是否存活
    const healthResp = await fetch('/api/health', { timeout: 5000 }).catch(() => null);
    if (!healthResp || !healthResp.ok) {
      ElMessage.error('内置服务未响应，请重启应用后重试。');
      return;
    }
    const result = await api.detectOllama();
    if (result.available) {
      ElMessage.success(`检测到 Ollama v${result.version || '?'}, 可用模型 ${result.models.length} 个`);
      await loadLocalStatus();
    } else {
      ElMessage.warning('未检测到 Ollama 服务。请确认 Ollama 已安装并正在运行（系统托盘有 Ollama 图标）。');
    }
  } catch (e) {
    if (e.message === 'Network Error' || e.message.includes('fetch')) {
      ElMessage.error('无法连接到内置服务，可能服务进程已崩溃。请重启应用后重试。');
    } else {
      ElMessage.error(e.message);
    }
  } finally {
    detecting.value = false;
  }
}

async function selectOllama() {
  if (!selectedOllamaModel.value) return ElMessage.warning('请选择一个模型');
  try {
    const url = localStatus.value?.ollama?.url || 'http://localhost:11434';
    await api.selectOllamaModel(selectedOllamaModel.value, url);
    ElMessage.success(`已选择 Ollama 模型：${selectedOllamaModel.value}`);
    await loadLocalStatus();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function setMode(mode) {
  try {
    await api.setLocalMode(mode);
    localMode.value = mode;
    ElMessage.success(`本地模式已设为：${{ auto: '自动（有云端用云端，无云端用本地）', always: '始终用本地', never: '始终用云端' }[mode]}`);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// 自主学习系统
const autoLearnStatus = ref(null);

async function loadAutoLearnStatus() {
  try {
    autoLearnStatus.value = await api.getAutoLearnStatus();
  } catch { /* ignore */ }
}

async function startAutoLearn() {
  try {
    const r = await api.startAutoLearn();
    ElMessage.success(`自主学习已启动，队列 ${r.queueLength} 个任务`);
    await loadAutoLearnStatus();
  } catch (e) { ElMessage.error(e.message); }
}

async function stopAutoLearn() {
  try {
    await api.stopAutoLearn();
    ElMessage.success('自主学习已停止');
    await loadAutoLearnStatus();
  } catch (e) { ElMessage.error(e.message); }
}

async function triggerPending() {
  try {
    const r = await api.triggerPendingTasks();
    ElMessage.success(`已触发 ${r.queueLength} 个待处理任务`);
    await loadAutoLearnStatus();
  } catch (e) { ElMessage.error(e.message); }
}

// 本地对话测试
const chatInput = ref('');
const chatMessages = ref([]);
const chatLoading = ref(false);
const chatSession = ref(`test_${Date.now()}`);

// Ollama 内置安装
const installing = ref(false);
const installProgress = ref({});
const recommendedModels = ref([]);
const showModelInstall = ref(false);
const pullingModel = ref('');
const pullProgress = ref({});

// 内置推理引擎（transformers.js）
const transformersModel = ref('Xenova/Qwen2.5-0.5B-Instruct');
const transformersInstalling = ref(false);
const transformersInstallProgress = ref(null);
// HuggingFace 镜像源（国内网络模型下载常失败）
const hfEndpoint = ref('');
const hfEndpointSaved = ref('');
const builtinModels = ref([]);

async function loadRecommendedModels() {
  try {
    const r = await api.getRecommendedModels();
    recommendedModels.value = r.models || [];
  } catch { /* ignore */ }
}

async function installOllamaNow() {
  installing.value = true;
  installProgress.value = { percent: 0, message: '正在初始化…' };
  try {
    // 使用 SSE 流式接收安装进度
    const ctrl = new AbortController();
    const resp = await fetch('/api/ollama-installer/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: ctrl,
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.type === 'progress') installProgress.value = d.data;
          else if (d.type === 'status') installProgress.value = { ...installProgress.value, message: d.message };
          else if (d.type === 'done') {
            ElMessage.success(`Ollama 安装成功！`);
            showModelInstall.value = true;
            await loadLocalStatus();
            await loadRecommendedModels();
          }
          else if (d.type === 'error') ElMessage.error(d.message);
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    if (e.message === 'Failed to fetch' || e.message === 'Network Error') {
      ElMessage.error('无法连接到内置服务。可能是服务进程已崩溃，请重启应用后重试。');
    } else {
      ElMessage.error('安装失败：' + e.message);
    }
  } finally {
    installing.value = false;
  }
}

async function pullModelNow(modelName) {
  if (pullingModel.value) return;
  pullingModel.value = modelName;
  pullProgress.value = { percent: 0 };
  try {
    const resp = await fetch('/api/ollama-installer/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.type === 'progress') pullProgress.value = d.data;
          else if (d.type === 'done') {
            ElMessage.success(`模型 ${modelName} 安装完成！`);
            await loadLocalStatus();
          }
          else if (d.type === 'error') ElMessage.error(d.message);
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    ElMessage.error('模型拉取失败：' + e.message);
  } finally {
    pullingModel.value = '';
  }
}

// ===== 内置推理引擎（transformers.js）=====
async function saveHfEndpoint() {
  try {
    const e = hfEndpoint.value.trim();
    const r = await api.setHfEndpoint(e);
    hfEndpointSaved.value = r.hfEndpoint || '';
    ElMessage.success(e ? `已启用镜像源：${e}` : '已使用官方源（huggingface.co）');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function installTransformers() {
  if (transformersInstalling.value) return;
  // 先保存镜像源，确保下载走用户配置的地址
  if (hfEndpoint.value.trim() !== hfEndpointSaved.value) {
    await saveHfEndpoint();
  }
  transformersInstalling.value = true;
  transformersInstallProgress.value = { percent: 0, message: '正在下载模型…' };
  try {
    const resp = await fetch('/api/transformers/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: transformersModel.value }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.type === 'progress') transformersInstallProgress.value = d.data;
          else if (d.type === 'status') transformersInstallProgress.value = { ...transformersInstallProgress.value, message: d.message };
          else if (d.type === 'done') {
            ElMessage.success('内置推理引擎模型安装完成！');
            transformersInstallProgress.value = { stage: 'done', percent: 100, message: '安装完成' };
            await loadLocalStatus();
          }
          else if (d.type === 'error') {
            ElMessage.error(d.message);
            transformersInstallProgress.value = { stage: 'error', message: d.message };
          }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    ElMessage.error('安装失败：' + e.message);
    transformersInstallProgress.value = { stage: 'error', message: e.message };
  } finally {
    transformersInstalling.value = false;
  }
}

async function selectTransformersModel(model) {
  transformersModel.value = model;
  try {
    await api.selectOllamaModel(model, '');
  } catch { /* ignore */ }
}

async function testTransformers() {
  ElMessage.info('正在测试内置推理引擎…');
  try {
    const r = await api.localChatTest(
      [{ role: 'user', content: '你好，请用一句话介绍你自己' }],
      'transformers-test'
    );
    ElMessage.success('推理成功：' + (r.content || '').slice(0, 50));
  } catch (e) {
    ElMessage.error('测试失败：' + e.message);
  }
}

async function loadBuiltinModels() {
  try {
    const r = await api.getBuiltinModels();
    builtinModels.value = r.models || [];
  } catch { /* ignore */ }
}

async function sendLocalChat() {
  if (!chatInput.value.trim()) return;
  chatMessages.value.push({ role: 'user', content: chatInput.value });
  chatInput.value = '';
  chatLoading.value = true;
  try {
    const r = await api.localChatTest(
      chatMessages.value.map((m) => ({ role: m.role, content: m.content })),
      chatSession.value
    );
    chatMessages.value.push({ role: 'assistant', content: r.content || r.reply || '' });
  } catch (e) {
    chatMessages.value.push({ role: 'assistant', content: '错误：' + e.message });
  } finally {
    chatLoading.value = false;
  }
}

onMounted(async () => {
  await store.load();
  storageRoot.value = store.novels_root || '';
  applyPreset();
  loadModels();
  loadLocalStatus();
  loadAutoLearnStatus();
  loadRecommendedModels();
  loadBuiltinModels();
  loadSearchSettings();
});

async function saveStorage() {
  const root = storageRoot.value.trim();
  if (!root) return ElMessage.warning('请填写作品存放目录');
  savingStorage.value = true;
  try {
    await store.saveNovelsRoot(root, migrateNovels.value);
    ElMessage.success(migrateNovels.value ? '存储位置已更新，已有作品已迁移' : '存储位置已更新');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    savingStorage.value = false;
  }
}

const PROVIDERS = [
  { value: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { value: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { value: 'moonshot', name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  { value: 'qwen', name: '通义千问 (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { value: 'zhipu', name: '智谱 (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { value: 'ollama', name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  { value: 'custom', name: '自定义 (OpenAI 兼容)', baseUrl: '', model: '' }
];

const needKey = computed(() => store.llm_config.provider !== 'ollama');

function formatToken(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function applyPreset() {
  const p = PROVIDERS.find((x) => x.value === store.llm_config.provider);
  if (!p) return;
  // 仅当用户尚未自定义时填充预设
  if (!store.llm_config.baseUrl) store.llm_config.baseUrl = p.baseUrl;
  if (!store.llm_config.model) store.llm_config.model = p.model;
}

function onProviderChange(val) {
  const p = PROVIDERS.find((x) => x.value === val);
  if (p) {
    store.llm_config.baseUrl = p.baseUrl;
    store.llm_config.model = p.model;
    testResult.value = null;
  }
}

async function save() {
  const cfg = store.llm_config;
  if (!cfg.baseUrl.trim()) return ElMessage.warning('请填写 API Base URL');
  if (!cfg.model.trim()) return ElMessage.warning('请填写模型名称');
  if (needKey.value && !cfg.apiKey.trim()) return ElMessage.warning('请填写 API Key');
  try {
    await store.save();
    ElMessage.success('设置已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function test() {
  const cfg = store.llm_config;
  if (!cfg.baseUrl.trim()) return ElMessage.warning('请填写 API Base URL');
  if (!cfg.model.trim()) return ElMessage.warning('请填写模型名称');
  if (needKey.value && !cfg.apiKey.trim()) return ElMessage.warning('请填写 API Key');
  testing.value = true;
  testResult.value = null;
  try {
    const r = await api.testLLM({ ...cfg });
    testResult.value = { ok: true, text: r.reply };
  } catch (e) {
    testResult.value = { ok: false, text: e.message };
  } finally {
    testing.value = false;
  }
}

// 拉取平台可用模型列表（通过后端代理 /v1/models），免去用户手动拼模型名
// auto=true：输入地址/密钥后自动触发；auto=false：用户点按钮触发
const fetchError = ref('');
async function fetchModels(auto = false) {
  const cfg = store.llm_config;
  if (!cfg.baseUrl.trim()) return auto ? null : ElMessage.warning('请先填写 API Base URL');
  if (needKey.value && !cfg.apiKey.trim()) return auto ? null : ElMessage.warning('请先填写 API Key');
  fetchingModels.value = true;
  fetchError.value = '';
  modelOptions.value = [];
  try {
    const r = await api.fetchModels({ ...cfg });
    const list = Array.isArray(r?.models) ? r.models : [];
    if (!list.length) {
      fetchError.value = '该平台未返回任何模型，请检查 Base URL 是否正确，或手动输入模型名';
      showModelSelect.value = false;
      if (!auto) ElMessage.warning('该平台未返回任何模型，请检查 Base URL 或手动填写模型名');
      return;
    }
    modelOptions.value = list.map((m) => ({ id: String(m.id || m), name: String(m.name || m.id || m) }));
    showModelSelect.value = true;
    // 自动拉取：若当前模型名不在列表中，自动选中第一个可用模型
    if (auto && !modelOptions.value.some((m) => m.id === store.llm_config.model)) {
      store.llm_config.model = modelOptions.value[0].id;
    }
    if (!auto) ElMessage.success(`已获取 ${modelOptions.value.length} 个可用模型，请在下拉中选择`);
  } catch (e) {
    showModelSelect.value = false;
    fetchError.value = e.message || '获取模型列表失败';
    if (!auto) ElMessage.error(fetchError.value);
  } finally {
    fetchingModels.value = false;
  }
}

</script>

<template>
  <div class="settings-page">
    <div class="page-head">
      <h2 class="page-title">设置</h2>
      <p class="page-sub">接入你自己的大模型 API；所有作品以「小说名文件夹 + 每章 TXT」的形式保存在本地指定目录</p>
    </div>

    <div class="settings-card">
      <h3 class="card-title">模型接入</h3>

      <div class="preset-bar">
        <el-select v-model="selectedPresetId" placeholder="切换已保存的 LLM 预设" clearable style="width: 280px" @change="onPresetChange">
          <el-option v-for="p in store.llm_presets" :key="p.id" :label="`${p.name} (${p.llm_config?.model || ''})`" :value="p.id" />
        </el-select>
        <el-button @click="showSavePresetDialog = true" :disabled="!store.llm_config.baseUrl">
          <el-icon style="margin-right:4px"><FolderAdd /></el-icon>存为预设
        </el-button>
        <el-button v-if="selectedPresetId" type="danger" plain @click="deletePreset(selectedPresetId)">
          <el-icon style="margin-right:4px"><Delete /></el-icon>删除预设
        </el-button>
      </div>
      <div class="field-tip" style="margin: 4px 0 16px">把当前配置（服务商 + URL + Key + 模型 + 参数）保存为命名预设，下次一键切换，免去反复填写。</div>

      <el-form label-position="top" style="max-width: 640px">
        <el-form-item label="模型服务商">
          <el-select v-model="store.llm_config.provider" style="width: 100%" @change="onProviderChange">
            <el-option v-for="p in PROVIDERS" :key="p.value" :label="p.name" :value="p.value" />
          </el-select>
        </el-form-item>

        <el-form-item label="API Base URL">
          <el-input v-model="store.llm_config.baseUrl" placeholder="https://api.deepseek.com 或 https://api.openai.com/v1" @input="scheduleAutoFetch" @blur="scheduleAutoFetch" />
        </el-form-item>

        <el-form-item :label="needKey ? 'API Key' : 'API Key（本地模型可留空）'">
          <el-input
            v-model="store.llm_config.apiKey"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
            show-password
            @input="scheduleAutoFetch"
            @blur="scheduleAutoFetch"
          />
        </el-form-item>

        <el-form-item :label="showModelSelect ? '模型（已自动获取可用列表，可直接选择）' : '模型名称'">
          <el-select
            v-if="showModelSelect"
            v-model="store.llm_config.model"
            placeholder="从可用模型中选择"
            filterable
            allow-create
            default-first-option
            style="width: 100%"
          >
            <el-option v-for="m in modelOptions" :key="m.id" :label="m.name" :value="m.id" />
          </el-select>
          <div v-else class="model-row">
            <el-input v-model="store.llm_config.model" placeholder="deepseek-chat / gpt-4o-mini / qwen-plus …" style="flex:1" />
            <el-button :loading="fetchingModels" @click="fetchModels(false)">
              <el-icon style="margin-right:4px"><Download /></el-icon>获取可用模型
            </el-button>
          </div>
          <div v-if="fetchingModels" class="fetch-loading"><el-icon class="is-loading"><Loading /></el-icon>正在获取可用模型列表…</div>
          <div v-else-if="fetchError" class="fetch-error"><el-icon><WarningFilled /></el-icon>{{ fetchError }}</div>
          <div class="field-tip" style="margin-top:6px">输入 Base URL 与 API Key 后会自动拉取该平台可用模型供选择；也可手动点「获取可用模型」。支持输入列表外的模型名。</div>
        </el-form-item>

        <div class="two-col">
          <el-form-item label="上下文长度（模型窗口）">
            <el-select v-model="store.llm_config.contextLength" style="width: 100%">
              <el-option v-for="n in [8192, 16384, 32768, 65536, 131072, 196608]" :key="n" :label="formatToken(n)" :value="n" />
            </el-select>
          </el-form-item>
          <el-form-item label="思考功能（Reasoning）">
            <el-select v-model="store.llm_config.reasoning" style="width: 100%">
              <el-option label="关闭" value="off" />
              <el-option label="低" value="low" />
              <el-option label="中" value="medium" />
              <el-option label="高" value="high" />
            </el-select>
          </el-form-item>
        </div>

        <div class="two-col">
          <el-form-item label="温度（越高越有创造性）">
            <el-slider v-model="store.llm_config.temperature" :min="0" :max="2" :step="0.1" show-input />
          </el-form-item>
          <el-form-item label="单次最大输出 Token">
            <el-input-number v-model="store.llm_config.maxTokens" :min="512" :max="128000" :step="512" style="width:100%" />
          </el-form-item>
        </div>
        <div class="field-tip">
          上下文长度决定单次请求能携带的设定与历史；输出 Token 为单次生成上限；思考功能仅对支持推理的模型生效（如 OpenAI o 系列 / Qwen thinking / Ollama think）。
        </div>
        <div class="memory-tip">
          记忆保障：系统会自动为每章生成「长效摘要」形成记忆链，正文一次性写不完时会自动续写到整章完成，历史超出上下文时会优先保证摘要与伏笔记忆，因此常规范围内这两个数值不会导致小说「失忆」或章节截断。
        </div>

        <el-form-item>
          <div class="polish-switch">
            <el-switch
              v-model="store.llm_config.autoPolish"
              active-text="自动去除 AI 味"
              inactive-text=""
            />
            <span class="polish-tip">开启后，每章生成完毕会自动用人类写作风格改写一遍，彻底清除 AI 痕迹（耗时与消耗约增加一倍）</span>
          </div>
        </el-form-item>

        <el-form-item>
          <div class="polish-switch">
            <el-switch
              v-model="store.llm_config.autoCompress"
              active-text="自动压缩上下文"
              inactive-text=""
            />
            <span class="polish-tip">开启后，写到上下文占用超过模型窗口约 <strong>{{ Math.round((store.llm_config.compressThreshold || 0.5) * 100) }}%</strong> 时，系统会自动把已写章节压缩成「故事状态简报」并替代后续生成中的前情摘要与最近章节全文，避免超长上下文导致的失忆与超时。阈值：<el-input-number v-model="store.llm_config.compressThreshold" :min="0.2" :max="0.9" :step="0.05" size="small" controls-position="right" style="width:110px;margin:0 4px" />（取上下文预算的比例，越小压缩越早）</span>
          </div>
        </el-form-item>

        <el-form-item>
          <div class="polish-switch">
            <el-switch
              v-model="store.strict_ai_mode"
              active-text="铁律模式（生成质量门）"
              inactive-text=""
            />
            <span class="polish-tip">开启后，生成与「去 AI 味」都经过强制质量门：润色 → 检测 → 未达标自动再润色（最多 3 轮），检测通过或不再命中 AI 高频词才算完成，从机制上保证不残留 AI 味</span>
          </div>
        </el-form-item>

        <el-form-item label="总管发送方式">
          <el-radio-group v-model="store.managerSendBy">
            <el-radio value="enter">回车直接发送（Shift+Enter 换行）</el-radio>
            <el-radio value="ctrlEnter">Ctrl/Cmd+Enter 发送（Enter 换行）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button type="primary" size="large" @click="save">
          <el-icon style="margin-right:6px"><Check /></el-icon>保存设置
        </el-button>
        <el-button size="large" :loading="testing" @click="test">
          <el-icon style="margin-right:6px"><Connection /></el-icon>测试连接
        </el-button>
      </div>

      <div v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
        <el-icon v-if="testResult.ok"><CircleCheckFilled /></el-icon>
        <el-icon v-else><CircleCloseFilled /></el-icon>
        <span>{{ testResult.text }}</span>
      </div>
    </div>

    <el-dialog v-model="showSavePresetDialog" title="保存为 LLM 预设" width="420px">
      <el-form label-position="top">
        <el-form-item label="预设名称">
          <el-input v-model="newPresetName" placeholder="例如：DeepSeek 主力 / GLM 备用 / 本地 Ollama" />
        </el-form-item>
        <div class="field-tip">将保存当前配置：服务商={{ store.llm_config.provider }}，模型={{ store.llm_config.model }}，含温度/上下文/思考等全部参数。</div>
      </el-form>
      <template #footer>
        <el-button @click="showSavePresetDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingPreset" @click="saveAsPreset">保存</el-button>
      </template>
    </el-dialog>

    <!-- 多 AI 大模型：同时启用多个，按任务自动路由 -->
    <div class="settings-card">
      <h3 class="card-title">多模型同时启用</h3>
      <div class="field-tip" style="margin-bottom: 14px">
        可以同时接入多个大模型，并给每个模型指派擅长的工作（如：DeepSeek 写正文、GLM 做大纲、Kimi 处理超长对话、本地 Ollama 兜底）。生成时系统按任务类型自动挑选对应模型，互不影响。
      </div>

      <div v-if="!store.llm_models || !store.llm_models.length" class="mm-empty">
        <p>尚未配置多模型。上方「模型接入」为默认主力模型，所有任务默认由它承担。</p>
        <el-button type="primary" plain @click="openAddModel">添加一个模型</el-button>
      </div>

      <div v-else class="mm-list">
        <div v-for="m in store.llm_models" :key="m.id" class="mm-item" :class="{ off: !m.enabled }">
          <div class="mm-item-head">
            <el-switch :model-value="!!m.enabled" @change="(v) => toggleModel(m, v)" />
            <span class="mm-name">{{ m.name }}</span>
            <span class="mm-model-tag">{{ m.config?.model || '未命名模型' }}</span>
            <div class="mm-actions">
              <el-button size="small" @click="openEditModel(m)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="removeModel(m)">删除</el-button>
            </div>
          </div>
          <div class="mm-tasks">
            <el-tag v-for="t in (m.tasks || [])" :key="t" size="small" :type="m.enabled ? 'success' : 'info'" style="margin-right:6px">
              {{ taskLabel(t) }}
            </el-tag>
            <span v-if="!m.tasks || !m.tasks.length" class="mm-no-task">未指派任务（当前不参与路由）</span>
          </div>
        </div>
      </div>

      <div class="mm-route-check">
        <div class="mm-route-check-bar">
          <span>路由自检：</span>
          <el-select v-model="checkTask" size="small" style="width: 200px" @change="checkRouting(checkTask)">
            <el-option v-for="t in taskOptions" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
          <el-button size="small" @click="checkRouting(checkTask)">检测</el-button>
        </div>
        <div v-if="routingInfo && routingInfo.task === checkTask" class="mm-route-check-result">
          <template v-if="routingInfo.routed">
            任务「{{ taskLabel(routingInfo.task) }}」将使用 <strong>{{ routingInfo.model }}</strong>（{{ routingInfo.provider }}，{{ routingInfo.baseUrl }}）
          </template>
          <template v-else>
            任务「{{ taskLabel(routingInfo.task) }}」无已启用的专属模型，将回退到上方默认主力模型
          </template>
        </div>
      </div>

      <el-button v-if="store.llm_models && store.llm_models.length" type="primary" plain style="margin-top:12px" @click="openAddModel">
        <el-icon style="margin-right:4px"><Plus /></el-icon>再添加一个模型
      </el-button>
    </div>

    <el-dialog v-model="showModelDialog" :title="editingModel ? '编辑模型' : '添加模型'" width="640px">
      <el-form label-position="top">
        <el-form-item label="模型名称（备注用，如：写作主力）">
          <el-input v-model="modelDraft.name" placeholder="例如：DeepSeek 写作主力 / GLM 大纲 / Kimi 对话" />
        </el-form-item>
        <div class="two-col">
          <el-form-item label="API Base URL">
            <el-input v-model="modelDraft.config.baseUrl" placeholder="https://api.deepseek.com" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="modelDraft.config.apiKey" type="password" show-password placeholder="sk-...（本地 Ollama 可留空）" />
          </el-form-item>
        </div>
        <div class="two-col">
          <el-form-item label="模型名称（服务商侧）">
            <el-input v-model="modelDraft.config.model" placeholder="deepseek-chat / glm-4-plus" />
          </el-form-item>
          <el-form-item label="上下文长度">
            <el-select v-model="modelDraft.config.contextLength" style="width: 100%">
              <el-option v-for="n in [8192, 16384, 32768, 65536, 131072, 196608]" :key="n" :label="formatToken(n)" :value="n" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="指派任务类型（可多选）">
          <div class="mm-task-pick">
            <el-checkbox-group v-model="modelDraft.tasks">
              <el-checkbox v-for="t in taskOptions" :key="t.value" :value="t.value" style="margin-bottom:8px">
                <div class="mm-task-pick-label">
                  <span>{{ t.label }}</span>
                  <small>{{ t.desc }}</small>
                </div>
              </el-checkbox>
            </el-checkbox-group>
          </div>
        </el-form-item>
        <div class="field-tip">同一任务可指派给多个模型，路由时优先选用配置完整（有 Key 或本地模型）的那一个。</div>
      </el-form>
      <template #footer>
        <el-button @click="showModelDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingModel" @click="saveModel">保存</el-button>
      </template>
    </el-dialog>

    <!-- 本地大模型 -->
    <div class="settings-card local-model-card" v-loading="localLoading">
      <h3 class="card-title">本地大模型（离线模式）</h3>
      <p class="storage-tip">
        没有云端 API 也能用！系统自动检测本地 Ollama 服务，检测到即可离线对话和学习。
        三层降级：<strong>Ollama</strong>（完整 AI 能力） &gt; <strong>内置引擎</strong>（轻量生成） &gt; <strong>规则引擎</strong>（关键词匹配兜底）。
        接入云端模型后，本地引擎会在后台自主学习，越用越聪明。
      </p>

      <div class="local-status-bar">
        <div class="layer-indicator">
          <span class="layer-label">当前活跃层</span>
          <el-tag :type="localStatus?.activeLayer === 'ollama' ? 'success' : localStatus?.activeLayer === 'transformers' ? 'warning' : 'info'" effect="dark" size="large">
            {{ { ollama: 'Ollama 本地模型', transformers: '内置推理引擎', rules: '规则引擎（兜底）', none: '未激活' }[localStatus?.activeLayer] || '检测中…' }}
          </el-tag>
        </div>
        <div class="mode-select">
          <span class="layer-label">模式</span>
          <el-radio-group :model-value="localMode" @change="setMode">
            <el-radio-button value="auto">自动</el-radio-button>
            <el-radio-button value="always">始终本地</el-radio-button>
            <el-radio-button value="never">始终云端</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <div class="local-layers">
        <!-- Ollama -->
        <div class="layer-card" :class="{ active: localStatus?.activeLayer === 'ollama', available: localStatus?.ollama?.available }">
          <div class="layer-head">
            <el-icon :size="22"><Cpu /></el-icon>
            <div class="layer-info">
              <div class="layer-title">Ollama 本地模型</div>
              <div class="layer-desc">{{ localStatus?.ollama?.available ? `已连接：${localStatus?.ollama?.url} (v${localStatus?.ollama?.version})` : '未检测到 Ollama 服务' }}</div>
            </div>
            <el-tag v-if="localStatus?.ollama?.available" type="success" effect="light" size="small">可用</el-tag>
            <el-button v-else size="small" :loading="detecting" @click="detectOllamaNow">检测 Ollama</el-button>
          </div>
          <div v-if="localStatus?.ollama?.available && localStatus?.ollama?.models?.length" class="layer-body">
            <el-select v-model="selectedOllamaModel" placeholder="选择本地模型" filterable style="width: 300px" size="small">
              <el-option v-for="m in localStatus.ollama.models" :key="m" :label="m" :value="m" />
            </el-select>
            <el-button size="small" type="primary" @click="selectOllama">应用</el-button>
            <span class="model-hint">{{ localStatus.ollama.models.length }} 个模型可用</span>
          </div>
          <div v-if="!localStatus?.ollama?.available" class="layer-body">
            <div class="install-guide">
              <el-button type="primary" size="small" @click="installOllamaNow" :loading="installing">
                {{ installing ? '安装中…' : '一键安装 Ollama' }}
              </el-button>
              <span class="guide-step" v-if="!installing">点击自动下载并安装，安装完成后自动启动服务</span>
              <span class="guide-step" v-if="installProgress.message">{{ installProgress.message }}</span>
              <el-progress v-if="installing && installProgress.percent !== undefined" :percentage="installProgress.percent" :stroke-width="6" style="width: 200px" />
            </div>
            <!-- 推荐模型安装 -->
            <div v-if="recommendedModels.length && showModelInstall" class="model-install-area">
              <span class="guide-step">选择要安装的模型：</span>
              <div class="model-options">
                <div v-for="m in recommendedModels" :key="m.name" class="model-option" @click="pullModelNow(m.name)" :class="{ active: pullingModel === m.name }">
                  <div class="model-option-name">{{ m.name }}</div>
                  <div class="model-option-meta">{{ m.size }} · {{ m.minRam }} 内存</div>
                  <div class="model-option-desc">{{ m.desc }}</div>
                  <el-progress v-if="pullingModel === m.name && pullProgress.percent !== undefined" :percentage="pullProgress.percent" :stroke-width="4" />
                </div>
              </div>
            </div>
            <el-link v-if="!installing" type="info" href="https://ollama.com" target="_blank" style="margin-top: 4px">也可手动安装（ollama.com）</el-link>
          </div>
        </div>

        <!-- 内置引擎 -->
        <div class="layer-card" :class="{ available: localStatus?.transformers?.available }">
          <div class="layer-head">
            <el-icon :size="22"><Lightning /></el-icon>
            <div class="layer-info">
              <div class="layer-title">内置推理引擎</div>
              <div class="layer-desc">
                {{ localStatus?.transformers?.available
                  ? (localStatus?.transformers?.installed ? '已安装，可离线生成正文和对话' : '引擎已就绪，需下载模型后可用')
                  : '引擎未就绪' }}
              </div>
            </div>
            <el-tag :type="localStatus?.transformers?.installed ? 'success' : localStatus?.transformers?.available ? 'warning' : 'info'" effect="plain" size="small">
              {{ localStatus?.transformers?.installed ? '已就绪' : localStatus?.transformers?.available ? '待下载模型' : '未就绪' }}
            </el-tag>
          </div>
          <!-- 内置引擎：模型选择 + 安装按钮 -->
          <div v-if="localStatus?.transformers?.available" class="layer-body">
            <div class="builtin-model-select">
              <span class="model-label">选择模型：</span>
              <el-select v-model="transformersModel" size="small" style="width: 260px" @change="selectTransformersModel">
                <el-option v-for="m in (localStatus?.transformers?.models || builtinModels)" :key="m.id" :label="`${m.name} (${m.size})`" :value="m.id">
                  <span>{{ m.name }} ({{ m.size }})</span>
                  <span class="model-desc-inline">{{ m.desc }}</span>
                </el-option>
              </el-select>
            </div>
            <div v-if="transformersInstallProgress" class="install-progress">
              <el-progress :percentage="transformersInstallProgress.percent || 0" :status="transformersInstallProgress.stage === 'done' ? 'success' : transformersInstallProgress.stage === 'error' ? 'exception' : ''" :stroke-width="8" />
              <span class="progress-msg">{{ transformersInstallProgress.message || (transformersInstallProgress.file ? `下载中: ${transformersInstallProgress.file}` : '') }}</span>
            </div>
            <div class="hf-endpoint-row">
              <span class="model-label">下载源：</span>
              <el-input v-model="hfEndpoint" size="small" style="width: 260px" placeholder="留空用官方源，国内可填 https://hf-mirror.com" />
              <el-button size="small" @click="saveHfEndpoint" :disabled="hfEndpoint.trim() === hfEndpointSaved">保存</el-button>
            </div>
            <div class="layer-actions">
              <el-button size="small" type="primary" @click="installTransformers" :loading="transformersInstalling" :disabled="transformersInstalling">
                {{ localStatus?.transformers?.installed ? '重新下载模型' : '一键下载安装' }}
              </el-button>
              <el-button v-if="localStatus?.transformers?.installed" size="small" text @click="testTransformers">测试推理</el-button>
            </div>
          </div>
        </div>

        <!-- 规则引擎 -->
        <div class="layer-card active">
          <div class="layer-head">
            <el-icon :size="22"><ChatDotRound /></el-icon>
            <div class="layer-info">
              <div class="layer-title">规则引擎（兜底）</div>
              <div class="layer-desc">纯关键词匹配+预设回复，零依赖，始终可用。能帮你查看角色/伏笔/进度，引导安装 Ollama。</div>
            </div>
            <el-tag type="success" effect="light" size="small">始终可用</el-tag>
          </div>
        </div>
      </div>

      <!-- 自主学习系统 -->
      <div class="auto-learn-section">
        <div class="auto-learn-head">
          <h4 class="subsection-title">自主学习系统</h4>
          <div class="auto-learn-actions">
            <el-button size="small" type="success" @click="startAutoLearn" :loading="autoLearnStatus?.running">启动</el-button>
            <el-button size="small" @click="stopAutoLearn">停止</el-button>
            <el-button size="small" type="primary" @click="triggerPending">触发待处理任务</el-button>
            <el-button size="small" text @click="loadAutoLearnStatus">刷新</el-button>
          </div>
        </div>
        <div class="auto-learn-info">
          <el-tag v-if="autoLearnStatus?.running" type="success" effect="light" size="small">运行中</el-tag>
          <el-tag v-else type="info" effect="light" size="small">已停止</el-tag>
          <span class="queue-info">队列：{{ autoLearnStatus?.queueLength || 0 }} 个任务</span>
          <span v-if="autoLearnStatus?.current" class="current-task">
            当前：{{ { summarize_chapter: '摘要章节', extract_facts: '抽取事实', analyze_style: '分析风格', learn_corpus: '学习语料', extract_characters: '提取角色' }[autoLearnStatus.current.type] || autoLearnStatus.current.type }}
          </span>
        </div>
        <div v-if="autoLearnStatus?.queue?.length" class="task-queue">
          <div v-for="t in autoLearnStatus.queue.slice(0, 5)" :key="t.id" class="task-item">
            <el-tag :type="t.status === 'completed' ? 'success' : t.status === 'failed' ? 'danger' : t.status === 'running' ? 'warning' : 'info'" size="small" effect="plain">
              {{ { summarize_chapter: '摘要', extract_facts: '事实', analyze_style: '风格', learn_corpus: '学习', extract_characters: '角色' }[t.type] || t.type }}
            </el-tag>
            <span class="task-status">{{ t.status }}</span>
          </div>
        </div>
      </div>

      <!-- 本地对话测试 -->
      <div class="local-chat-test">
        <h4 class="subsection-title">本地对话测试</h4>
        <p class="chat-tip">在离线模式下测试规则引擎对话（输入"帮助"查看全部意图）</p>
        <div class="chat-messages">
          <div v-for="(m, i) in chatMessages" :key="i" class="chat-msg" :class="m.role">
            <span class="chat-role">{{ m.role === 'user' ? '我' : 'AI' }}</span>
            <div class="chat-content">{{ m.content }}</div>
          </div>
        </div>
        <div class="chat-input-row">
          <el-input v-model="chatInput" placeholder="输入消息测试本地模型…" @keyup.enter="sendLocalChat" :disabled="chatLoading" size="small" />
          <el-button size="small" type="primary" @click="sendLocalChat" :loading="chatLoading">发送</el-button>
        </div>
      </div>
    </div>

    <div class="settings-card search-card">
      <h3 class="card-title">联网搜索</h3>
      <p class="storage-tip">总管 AI 可联网搜索资料，辅助创作参考。搜索结果会注入对话上下文。</p>
      <el-form label-position="top" style="max-width: 640px">
        <el-form-item label="搜索引擎">
          <el-radio-group v-model="searchSettings.search_engine">
            <el-radio value="duckduckgo">DuckDuckGo（免配置）</el-radio>
            <el-radio value="searxng">SearXNG（自建实例）</el-radio>
            <el-radio value="bing">Bing API</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="searchSettings.search_engine === 'searxng'" label="SearXNG 实例地址">
          <el-input v-model="searchSettings.searx_url" placeholder="如 https://your-searxng-instance.example.com" />
        </el-form-item>
        <el-form-item v-if="searchSettings.search_engine === 'bing'" label="Bing API Key">
          <el-input v-model="searchSettings.bing_api_key" type="password" show-password placeholder="Bing Search API Key" />
        </el-form-item>
        <el-form-item v-if="searchSettings.search_engine === 'bing'" label="Bing API 端点">
          <el-input v-model="searchSettings.bing_endpoint" placeholder="默认 https://api.bing.microsoft.com/v7.0/search" />
        </el-form-item>
        <div class="actions">
          <el-button type="primary" :loading="savingSearch" @click="saveSearchSettings">
            <el-icon style="margin-right:6px"><Search /></el-icon>保存
          </el-button>
        </div>
      </el-form>
    </div>

    <div class="settings-card storage-card">
      <h3 class="card-title">作品存放位置</h3>
      <p class="storage-tip">
        每一本小说会自动在此目录下创建以「小说名」命名的独立文件夹，每一章保存为一个独立的
        TXT 文本文件（形如「第3章-章节标题.txt」），方便直接用记事本或任意阅读软件打开查看。
      </p>
      <el-form label-position="top" style="max-width: 640px">
        <el-form-item label="作品文件夹根目录（可自定义安装到任意盘 / 分区）">
          <el-input v-model="storageRoot" placeholder="例如 Windows：D:\Novels ；macOS/Linux：/Users/你的名字/Novels" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="migrateNovels">同时把已有作品文件夹迁移到新位置</el-checkbox>
        </el-form-item>
        <div class="actions">
          <el-button type="primary" :loading="savingStorage" @click="saveStorage">
            <el-icon style="margin-right:6px"><FolderOpened /></el-icon>保存并应用
          </el-button>
        </div>
      </el-form>
    </div>

    <div class="tips-card">
      <h4>使用提示</h4>
      <ul>
        <li>本软件为本地应用：小说、章节、角色与对话全部保存在你的电脑本地（SQLite），关闭后重开可继续。</li>
        <li>长篇小说记忆机制：AI 会为每一章自动生成剧情摘要，创作时参考「前情摘要 + 最近章节」，可稳定支撑数十万至千万字的长篇连载。</li>
        <li>推荐使用支持长上下文的模型（如 DeepSeek、Kimi、Qwen），长篇创作体验更佳。</li>
        <li>API Key 只保存在本机，用于调用你配置的模型服务。</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 20px; }
.page-title { margin: 0; font-size: 24px; font-weight: 700; }
.page-sub { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.card-title { margin: 0 0 4px; font-size: 16px; color: #1e1b4b; }
.preset-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 4px; }
.settings-card {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
  max-width: 720px;
}
.storage-card { margin-top: 20px; }
.storage-tip {
  margin: 6px 0 16px;
  font-size: 13px;
  color: #6b7280;
  line-height: 1.8;
  background: #f0fdf4;
  border: 1px solid #d1fae5;
  border-radius: 8px;
  padding: 10px 14px;
}
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.field-tip { font-size: 12px; color: #9ca3af; margin: -8px 0 16px; line-height: 1.6; }
.memory-tip {
  font-size: 12px;
  color: #047857;
  background: #ecfdf5;
  border: 1px solid #d1fae5;
  border-radius: 8px;
  padding: 10px 14px;
  line-height: 1.7;
  margin-bottom: 16px;
}
.polish-switch { display: flex; align-items: center; gap: 14px; }
.polish-tip { font-size: 12px; color: #9ca3af; }
.model-row { display: flex; gap: 10px; align-items: center; }
.fetch-loading { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #4f46e5; margin-top: 4px; }
.fetch-error { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #dc2626; margin-top: 4px; word-break: break-all; }
.actions { display: flex; gap: 12px; margin-top: 8px; }
.mm-empty {
  border: 1px dashed #c7d2fe;
  border-radius: 10px;
  padding: 20px;
  text-align: center;
  color: #6b7280;
  font-size: 13px;
}
.mm-empty p { margin: 0 0 12px; }
.mm-list { display: flex; flex-direction: column; gap: 10px; }
.mm-item {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px 14px;
  background: #fafbff;
}
.mm-item.off { opacity: 0.55; }
.mm-item-head { display: flex; align-items: center; gap: 12px; }
.mm-name { font-size: 14px; font-weight: 600; color: #1e1b4b; }
.mm-model-tag {
  font-size: 12px;
  color: #4f46e5;
  background: #eef2ff;
  padding: 2px 8px;
  border-radius: 6px;
}
.mm-actions { margin-left: auto; display: flex; gap: 6px; }
.mm-tasks { margin-top: 10px; }
.mm-no-task { font-size: 12px; color: #9ca3af; }
.mm-route-check {
  margin-top: 14px;
  font-size: 13px;
  color: #374151;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 10px 12px;
}
.mm-route-check-bar { display: flex; align-items: center; gap: 10px; }
.mm-route-check-result { margin-top: 8px; }
.mm-task-pick { display: flex; flex-direction: column; }
.mm-task-pick-label { display: flex; flex-direction: column; line-height: 1.4; }
.mm-task-pick-label small { color: #9ca3af; font-size: 11px; }

.test-result {
  margin-top: 16px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  word-break: break-all;
}
.test-result.ok { background: #ecfdf5; color: #047857; }
.test-result.fail { background: #fef2f2; color: #b91c1c; }
.tips-card {
  margin-top: 20px;
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  max-width: 720px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
}
.tips-card h4 { margin: 0 0 10px; color: #1e1b4b; }
.tips-card ul { margin: 0; padding-left: 18px; color: #4b5563; font-size: 13px; line-height: 2; }

.local-model-card { margin-top: 20px; }
.local-status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.layer-indicator { display: flex; align-items: center; gap: 10px; }
.mode-select { display: flex; align-items: center; gap: 10px; }
.layer-label { font-size: 12px; color: #6b7280; font-weight: 600; }
.local-layers { display: flex; flex-direction: column; gap: 12px; }
.layer-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 16px;
  transition: border-color .15s;
}
.layer-card.active { border-color: #10b981; background: #f0fdf4; }
.layer-card.available { border-color: #6366f1; }
.layer-head { display: flex; align-items: center; gap: 12px; }
.layer-info { flex: 1; }
.layer-title { font-size: 14px; font-weight: 700; color: #1e1b4b; }
.layer-desc { font-size: 12px; color: #6b7280; margin-top: 2px; }
.layer-body { margin-top: 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.model-hint { font-size: 11px; color: #9ca3af; }
.builtin-model-select { display: flex; align-items: center; gap: 8px; }
.model-label { font-size: 12px; color: #6b7280; white-space: nowrap; }
.hf-endpoint-row { display: flex; align-items: center; gap: 8px; }
.model-desc-inline { font-size: 11px; color: #9ca3af; margin-left: 8px; }
.install-progress { width: 100%; display: flex; flex-direction: column; gap: 4px; }
.progress-msg { font-size: 11px; color: #9ca3af; }
.layer-actions { display: flex; gap: 8px; align-items: center; }
.install-guide { font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.guide-step { color: #9ca3af; font-size: 11px; }

.auto-learn-section { margin-top: 16px; border-top: 1px solid #f0f0f0; padding-top: 16px; }
.subsection-title { margin: 0 0 8px; font-size: 14px; color: #1e1b4b; font-weight: 700; }
.auto-learn-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.auto-learn-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.auto-learn-info { display: flex; align-items: center; gap: 12px; margin: 8px 0; font-size: 12px; color: #6b7280; }
.queue-info { font-weight: 600; }
.current-task { color: #6366f1; }
.task-queue { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.task-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 8px; background: #f9fafb; border-radius: 6px; }
.task-status { color: #9ca3af; font-size: 11px; }

.local-chat-test { margin-top: 16px; border-top: 1px solid #f0f0f0; padding-top: 16px; }
.chat-tip { font-size: 12px; color: #9ca3af; margin: 0 0 10px; }
.chat-messages { max-height: 240px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 10px; background: #fafafa; }
.chat-msg { margin-bottom: 10px; display: flex; gap: 8px; }
.chat-msg.user { flex-direction: row-reverse; }
.chat-role { font-size: 11px; font-weight: 700; color: #6366f1; min-width: 20px; }
.chat-msg.user .chat-role { color: #10b981; }
.chat-content { font-size: 13px; color: #374151; background: #fff; padding: 8px 12px; border-radius: 8px; max-width: 80%; white-space: pre-wrap; word-break: break-word; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.chat-msg.user .chat-content { background: #ecfdf5; }
.chat-input-row { display: flex; gap: 8px; }

.model-install-area { margin-top: 12px; padding-top: 8px; border-top: 1px dashed #e5e7eb; }
.model-options { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-top: 8px; }
.model-option { padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; cursor: pointer; transition: all .15s; }
.model-option:hover { border-color: #6366f1; background: #f5f3ff; }
.model-option.active { border-color: #6366f1; background: #eef2ff; }
.model-option-name { font-size: 13px; font-weight: 700; color: #1e1b4b; }
.model-option-meta { font-size: 11px; color: #9ca3af; margin: 2px 0; }
.model-option-desc { font-size: 11px; color: #6b7280; }
</style>
