import { defineStore } from 'pinia';
import api from '../api';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    llm_config: {
      provider: 'custom',
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.9,
      maxTokens: 8192,
      contextLength: 32768,
      reasoning: 'off',
      autoPolish: false,
      autoCompress: true,
      compressThreshold: 0.5
    },
    llm_presets: [],
    llm_models: [],
    llm_tasks: {},
    loaded: false,
    novels_root: '',
    strict_ai_mode: true,
    managerSendBy: 'enter'
  }),
  getters: {
    isConfigured() {
      return !!(this.llm_config.model && (this.llm_config.apiKey || this.llm_config.provider === 'ollama'));
    },
    enabledModels() {
      return (this.llm_models || []).filter((m) => m.enabled);
    }
  },
  actions: {
    async load() {
      try {
        const s = await api.getSettings();
        if (s.llm_config) this.llm_config = { ...this.llm_config, ...s.llm_config };
        if (s.llm_presets) this.llm_presets = s.llm_presets;
        if (s.llm_models) this.llm_models = s.llm_models;
        if (s.llm_tasks) this.llm_tasks = s.llm_tasks;
        if (s.novels_root) this.novels_root = s.novels_root;
        if (s.strict_ai_mode !== undefined) this.strict_ai_mode = String(s.strict_ai_mode) !== '0';
        if (s.managerSendBy) this.managerSendBy = s.managerSendBy === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
      } catch (e) {
        console.warn('加载设置失败', e);
      }
      this.loaded = true;
    },
    async loadModels() {
      const r = await api.getLLMModels();
      if (r.models) this.llm_models = r.models;
      if (r.tasks) this.llm_tasks = r.tasks;
      return r;
    },
    async addModel(model) {
      const r = await api.createLLMModel(model);
      this.llm_models = r.models || this.llm_models;
      return r.model;
    },
    async updateModel(mid, patch) {
      const r = await api.updateLLMModel(mid, patch);
      this.llm_models = r.models || this.llm_models;
      return r.model;
    },
    async deleteModel(mid) {
      const r = await api.deleteLLMModel(mid);
      this.llm_models = r.models || this.llm_models;
    },
    async save() {
      await api.saveSettings({ llm_config: this.llm_config, strict_ai_mode: this.strict_ai_mode, managerSendBy: this.managerSendBy });
    },
    async saveProp(kv) {
      Object.assign(this.$state, kv);
      await api.saveSettings(kv);
    },
    async saveNovelsRoot(root, migrate) {
      const r = await api.saveSettings({ novels_root: root, migrate_novels: migrate });
      this.novels_root = r.novels_root;
    },
    async savePresetAs(name) {
      const r = await api.saveLLMPreset(name, { ...this.llm_config });
      this.llm_presets.push(r.preset);
      return r.preset;
    },
    async applyPreset(pid) {
      const cfg = await api.applyLLMPreset(pid);
      this.llm_config = { ...this.llm_config, ...cfg };
      return cfg;
    },
    async deletePreset(pid) {
      await api.deleteLLMPreset(pid);
      this.llm_presets = this.llm_presets.filter((p) => p.id !== pid);
    },
    async updatePreset(pid, data) {
      const r = await api.updateLLMPreset(pid, data);
      const idx = this.llm_presets.findIndex((p) => p.id === pid);
      if (idx >= 0) this.llm_presets[idx] = r.preset;
      return r.preset;
    }
  }
});
