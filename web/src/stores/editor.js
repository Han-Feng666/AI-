import { defineStore } from 'pinia';
import api from '../api';
import { saveGenDraft, clearGenDraft, getGenDraftMeta, unescapeUnicode } from '../utils/format';
import workspaceEventBus from '../utils/workspaceEventBus';

// 切换 novel 时顶层字段初始态（仅当 slice 表里没记录该字段时用）
const _defaultSliceState = {
  novel: null, chapters: [], characters: [], relationships: [], factions: [],
  foreshadowings: [], worldSettings: [],
  busy: false, busyLabel: '', genStream: '', genProgress: 0,
  chatMessages: [], chatStream: '', chatBusy: false,
  activeChapter: null, chapterLoading: false, chapterEdit: false, editContent: '',
  workspace: 'setup', generationAsk: null,
  adaptJob: null, adaptCandidates: [], adaptDialog: false, adaptPlanStream: '',
  adaptBusy: false, adaptTargetChapter: null, adaptCompare: null
};

export const useEditorStore = defineStore('editor', {
  state: () => ({
    novelId: null,
    novel: null,
    loadingNovel: false,

    chapters: [],
    activeChapter: null,
    chapterLoading: false,
    chapterEdit: false,
    editContent: '',

    busy: false,
    busyLabel: '',
    genStream: '',
    genProgress: 0,

    chatMessages: [],
    chatStream: '',
    chatBusy: false,

    characters: [],
    relationships: [],
    factions: [],
    _genAbort: null,
    _chatAbort: null,
    _chapterReq: 0,

    allStyles: [],
    stylesLoading: false,

    generationAsk: null,

    workspace: 'setup',

    foreshadowings: [],
    foreshadowLoading: false,

    pendingVersion: null,

    worldSettings: [],
    worldSettingsLoading: false,

    adaptJob: null,
    adaptCandidates: [],
    adaptDialog: false,
    adaptPlanStream: '',
    adaptBusy: false,
    adaptTargetChapter: null,
    adaptCompare: null,

    _slices: new Map()
  }),

  getters: {
    maxChapterIndex: (s) => {
      if (!s.chapters.length) return 0;
      return Math.max(...s.chapters.map((c) => c.chapter_index));
    },
    totalWords: (s) => s.chapters.reduce((sum, c) => sum + (c.word_count || 0), 0),
    hasPlanned: (s) => !!(s.novel && s.novel.status && s.novel.status !== 'draft')
  },

  actions: {
    // === 多书并行：slice 切换骨架（REQ-03） ===
    _persistentFields: ['novel','chapters','characters','relationships','factions','foreshadowings','worldSettings','busy','busyLabel','genStream','chatMessages','chatStream','chatBusy','activeChapter','chapterLoading','chapterEdit','editContent','workspace','generationAsk','adaptJob','adaptCandidates','adaptDialog','adaptPlanStream','adaptBusy','adaptTargetChapter','adaptCompare'],

    _saveSlice(novelId) {
      if (!novelId) return;
      const slice = {};
      for (const f of this._persistentFields) slice[f] = this.$state[f];
      slice._chapterReq = this._chapterReq;
      slice._genAbort = this._genAbort;
      slice._chatAbort = this._chatAbort;
      this._slices.set(String(novelId), slice);
    },

    _commit(originId, patch) {
      const same = String(this.novelId) === String(originId);
      if (same) {
        for (const [k, v] of Object.entries(patch || {})) {
          if (k in this.$state) this.$state[k] = v;
        }
      } else {
        const key = String(originId);
        const s = this._slices.get(key) || {};
        for (const [k, v] of Object.entries(patch || {})) s[k] = v;
        this._slices.set(key, s);
      }
    },

    _loadSlice(novelId) {
      const slice = this._slices.get(String(novelId)) || {};
      for (const f of this._persistentFields) {
        this.$state[f] = slice[f] !== undefined ? slice[f] : _defaultSliceState[f];
      }
      this._chapterReq = slice._chapterReq || 0;
      this._genAbort = slice._genAbort || null;
      this._chatAbort = slice._chatAbort || null;
    },

    // 切到指定 novel：保存旧顶层 slice → 清顶层 → 顶层目标Activated → loadNovel 拉最新数据 + 读 Job 状态恢复 busy
    async switchTo(id) {
      if (this.novelId && String(this.novelId) !== String(id)) this._saveSlice(this.novelId);
      this.novelId = id;
      this._loadSlice(id);
      // 切回时若该 novel 有正在跑的 Job，恢复进度显示
      await this.syncJobState();
      await this.loadNovel(id);
    },

    // 从后端 GET 当前 novel 的 Job 状态，恢复 busy/busyLabel/genStream（切书/刷新后还原）
    async syncJobState() {
      if (!this.novelId) return;
      try {
        const job = await api.getActiveJob(this.novelId);
        if (job && job.status === 'running') {
          const createdAt = new Date(job.created_at + 'Z').getTime();
          const elapsed = (Date.now() - createdAt) / 60000;
          if (elapsed > 20) {
            api.abortJob(this.novelId).catch(() => {});
            this.busy = false;
            this.busyLabel = '';
            this._genAbort = null;
            return;
          }
          // 恢复忙碌态，并让「停止生成」对恢复的僵尸 job 也生效（调用后端 abort 接口清理）
          this.busy = true;
          this._genAbort = () => {
            api.abortJob(this.novelId).catch(() => {});
            this._genAbort = null;
            this.busy = false;
            this.busyLabel = '';
            this.genStream = '';
            this.genProgress = 0;
          };
          const stageLabels = { plan: '正在生成创作方案…', revise: '正在按你的意见修订方案…', generate_chapter: '正在写章节…', polish: '正在去除 AI 味…', compress: '正在压缩上下文…' };
          this.busyLabel = (job.stream_cursor && job.stage !== 'plan') ? job.stream_cursor : (stageLabels[job.stage] || '正在生成…');
          this.genStream = job.stream_cursor || '';
          this.genProgress = Math.max(0, Math.min(99, Number(job.progress) || 0));
          // 生成进行中也刷新章节列表：正文可能已写入，避免切回空白
          try {
            const novel = await api.getNovel(this.novelId);
            this.chapters = novel.chapters || [];
            const curHas = this.activeChapter && Number(this.activeChapter.word_count) > 0;
            if (!this.activeChapter || !curHas) {
              const withContent = [...this.chapters].filter((c) => Number(c.word_count) > 0);
              if (withContent.length) this.selectChapter(withContent[withContent.length - 1].chapter_index);
            }
          } catch { /* 刷新失败不阻塞 */ }
        } else {
          this.busy = false;
          this.busyLabel = '';
          this._genAbort = null;
          // 保留 genStream 仅当 busy 时可见，便于切回查看最后一段
          // job 已结束：刷新章节，确保切换界面后看到最新生成的内容
          if (job && this.novelId) {
            try {
              const novel = await api.getNovel(this.novelId);
              this.novel = novel;
              this.chapters = novel.chapters || [];
              this.characters = novel.characters || [];
              this.relationships = novel.relationships || [];
              this.factions = novel.factions || [];
              this.foreshadowings = novel.foreshadowings || [];
              // 若当前 activeChapter 无内容（或为 null），选最近有内容的一章
              const cur = this.activeChapter;
              const curHasContent = cur && Number(cur.word_count) > 0;
              if (!cur || !curHasContent) {
                const withContent = [...this.chapters].filter((c) => Number(c.word_count) > 0);
                if (withContent.length) {
                  const idx = withContent[withContent.length - 1].chapter_index;
                  this.selectChapter(idx);
                }
              }
            } catch { /* 刷新失败不阻塞 */ }
          }
        }
      } catch { /* ignore */ }
    },

    async loadNovel(id) {
      this.novelId = id;
      this.loadingNovel = true;
      try {
        const novel = await api.getNovel(id);
        this.novel = novel;
        this.chapters = novel.chapters || [];
        this.characters = novel.characters || [];
        this.relationships = novel.relationships || [];
        this.factions = novel.factions || [];
        this.foreshadowings = novel.foreshadowings || [];
        this.workspace = this.hasPlanned ? 'chapters' : 'setup';
        // 默认选中第一章（若有内容）或最近一章
        const withContent = [...this.chapters].filter((c) => c.word_count > 0);
        if (withContent.length) {
          this.selectChapter(withContent[withContent.length - 1].chapter_index);
        }
        // 读 Job 状态恢复忙碌指示
        await this.syncJobState();
        // Phase 7：进入小说时拉一次候选版本，若有则在 SetupPanel 弹待采纳横幅
        this.fetchPendingVersion();
      } finally {
        this.loadingNovel = false;
      }
    },

    // 切换中间工作区面板（点击左侧导航触发）
    setWorkspace(name) {
      this.workspace = name;
      if (name === 'foreshadowings') this.loadForeshadowings();
      else if (name === 'settings') this.loadWorldSettings();
    },

    async refresh() {
      const novel = await api.getNovel(this.novelId);
      this.novel = novel;
      this.chapters = novel.chapters || [];
      this.characters = novel.characters || [];
      this.relationships = novel.relationships || [];
      this.factions = novel.factions || [];
      this.foreshadowings = novel.foreshadowings || [];
    },

    async saveNovelSettings(patch) {
      await api.updateNovel(this.novelId, patch);
      await this.refresh();
    },

    // ---------- 风格 ----------
    async loadStyles() {
      this.stylesLoading = true;
      try {
        this.allStyles = await api.listStyles();
      } finally {
        this.stylesLoading = false;
      }
    },

    async saveStyles(ids) {
      await api.updateNovel(this.novelId, { style_ids: ids });
      await this.refresh();
    },

    // ---------- 章节 ----------
    async selectChapter(idx) {
      if (idx == null) { this.activeChapter = null; return; }
      const req = ++this._chapterReq;
      this.chapterLoading = true;
      // 拉取失败时用本地列表章节兜底（避免切界面后空白）
      const localCh = this.chapters.find((c) => c.chapter_index === idx) || null;
      try {
        const ch = await api.getChapter(this.novelId, idx);
        if (req === this._chapterReq) {
          this.activeChapter = ch;
          this.chapterEdit = false;
        }
      } catch (e) {
        // API 拉取失败，用本地章节对象兜底（可能无 content，但标题/状态仍在）
        if (req === this._chapterReq && localCh) {
          this.activeChapter = { ...localCh, content: localCh.content || '' };
          this.chapterEdit = false;
        }
      } finally {
        if (req === this._chapterReq) this.chapterLoading = false;
      }
    },

    async saveChapterEdit() {
      const idx = this.activeChapter.chapter_index;
      await api.updateChapter(this.novelId, idx, {
        title: this.activeChapter.title,
        content: this.editContent
      });
      this.chapterEdit = false;
      this.activeChapter = await api.getChapter(this.novelId, idx);
      await this.refresh();
    },

    async deleteChapter(idx) {
      await api.deleteChapter(this.novelId, idx);
      if (this.activeChapter && this.activeChapter.chapter_index === idx) {
        this.activeChapter = null;
      }
      await this.refresh();
    },

    // ---------- 生成 ----------
    stop() {
      if (this.busy) {
        if (this._genAbort) {
          this._genAbort();
          this._genAbort = null;
        } else {
          // 兜底：无本地 abort 句柄（如恢复的僵尸 job），直接调后端清理
          api.abortJob(this.novelId).catch(() => {});
          this.busy = false;
          this.busyLabel = '';
          this.genStream = '';
          this.genProgress = 0;
        }
      }
      if (this.chatBusy && this._chatAbort) {
        this._chatAbort();
        this._chatAbort = null;
      }
    },

    async generatePlan(params) {
      if (this.busy) return null;
      const originId = this.novelId;
      this.busy = true;
      this.busyLabel = '正在生成创作方案…';
      this.genStream = '';
      this.genProgress = 0;
      try {
        const p = api.generatePlan(this.novelId, params, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onProgress: (pct, msg) => {
            const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: p, busyLabel: msg || `正在生成创作方案…（${p}%）` });
          },
          onDelta: (d) => {
            const current = String(this.novelId) === String(originId)
              ? (this.$state.genStream || '')
              : ((this._slices.get(String(originId)) || {}).genStream || '');
            this._commit(originId, { genStream: current + d });
          },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        const resultPatch = {
          novel: data.novel,
          chapters: data.novel.chapters,
          characters: data.novel.characters,
          relationships: data.novel.relationships,
          factions: data.novel.factions,
          foreshadowings: [],
          busy: false,
          busyLabel: '',
          genStream: '',
          genProgress: 100,
          _genAbort: null
        };
        this._commit(originId, resultPatch);
        // 如果仍在同书，执行顶层附加操作（选章节、触发事件）
        if (String(this.novelId) === String(originId)) {
          if (data.novel.chapters?.length) {
            this.selectChapter(data.novel.chapters[0].chapter_index);
          }
          workspaceEventBus.emit('novel:planGenerated', { novelId: this.novelId });
        } else {
          // 已切书：把选中第一章信息也写入原书 slice（切回时可直接恢复）
          const s = this._slices.get(String(originId)) || {};
          s.activeChapter = data.novel.chapters?.length ? data.novel.chapters[0] : null;
          this._slices.set(String(originId), s);
        }
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { busy: false, busyLabel: '', genStream: '', _genAbort: null });
      }
    },

    // 策划模式：按反馈修订方案（可多轮）
    // Phase 7：revise 写候选 plan_versions accepted=0，前端不直接落库，保存 pendingVersion 供 SetupPanel 弹窗 diff + 接纳
    async revisePlan(feedback) {
      if (this.busy) return;
      const originId = this.novelId;
      this.busy = true;
      this.busyLabel = '正在按你的意见修订方案…';
      this.genStream = '';
      this.genProgress = 0;
      try {
        const p = api.revisePlan(this.novelId, { feedback }, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onProgress: (pct, msg) => {
            const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: p, busyLabel: msg || `正在修订方案…（${p}%）` });
          },
          onDelta: (d) => { const cur = String(this.novelId) === String(originId) ? (this.$state.genStream || '') : ((this._slices.get(String(originId)) || {}).genStream || ''); this._commit(originId, { genStream: cur + unescapeUnicode(d) }); },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        const verPatch = data?.version ? {
          pendingVersion: {
            id: data.version.id,
            versionNo: data.version.version_no,
            feedback: feedback,
            snapshot: data.version.snapshot || {},
            createdAt: data.version.created_at
          }
        } : {};
        this._commit(originId, { ...verPatch, busy: false, busyLabel: '', genStream: '', genProgress: 100, _genAbort: null });
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { busy: false, busyLabel: '', genStream: '', genProgress: 0, _genAbort: null });
      }
    },

    // Phase 7：从后端拉取候选版本（进入 SetupPanel 时若没有朋挂 banner 直接拉一次）
    async fetchPendingVersion() {
      if (!this.novelId) return;
      try {
        const r = await api.getPendingPlan(this.novelId);
        if (r?.version) {
          this.pendingVersion = {
            id: r.version.id,
            versionNo: r.version.version_no,
            feedback: r.version.feedback || '',
            snapshot: r.version.snapshot || {},
            createdAt: r.version.created_at
          };
        } else {
          this.pendingVersion = null;
        }
      } catch { /* 404 当成没有候选 */ this.pendingVersion = null; }
    },

    // Phase 7：采纳候选
    async acceptPendingVersion() {
      if (!this.pendingVersion?.id) return;
      const r = await api.acceptPlanVersion(this.novelId, this.pendingVersion.id);
      this.novel = r.novel;
      this.chapters = r.novel.chapters;
      this.characters = r.novel.characters;
      this.relationships = r.novel.relationships;
      this.factions = r.novel.factions;
      this.foreshadowings = [];
      if (r.novel.chapters?.length) this.selectChapter(r.novel.chapters[0].chapter_index);
      this.pendingVersion = null;
      workspaceEventBus.emit('novel:planAccepted', { novelId: this.novelId });
      return r;
    },

    // Phase 7：弃用候选
    async rollbackPendingVersion() {
      if (!this.pendingVersion?.id) return;
      // 不采纳 = 删除候选 entry（前端软丢弃：调 reject / 设置为 null 即可；后端暂无 delete version 接口，软丢弃在前端）
      this.pendingVersion = null;
    },

    // Phase 7：回滚到历史采纳版本
    async rollbackToVersion(versionId) {
      const r = await api.rollbackPlanVersion(this.novelId, versionId);
      this.novel = r.novel;
      this.chapters = r.novel.chapters;
      this.characters = r.novel.characters;
      this.relationships = r.novel.relationships;
      this.factions = r.novel.factions;
      this.foreshadowings = [];
      if (r.novel.chapters?.length) this.selectChapter(r.novel.chapters[0].chapter_index);
      workspaceEventBus.emit('novel:planAccepted', { novelId: this.novelId, rollback: true });
      return r;
    },

    async generateNextChapter(params = {}) {
      const activeIdx = this.activeChapter?.chapter_index;
      if (!activeIdx) {
        throw new Error('请先选择章节');
      }
      return this.generateChapter({ mode: 'regenerate', chapterIndex: activeIdx + 1, ...params });
    },

    async generateChapter(params = {}) {
      if (this.busy) throw new Error('系统正忙，请等待当前任务完成后再试');
      const originId = this.novelId;
      this.busy = true;
      this.busyLabel = '正在准备生成…';
      this.genStream = '';
      this.genProgress = 0;
      let done = false;
      try {
        const p = api.generateChapter(this.novelId, params, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onProgress: (pct, msg) => {
            const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: p, busyLabel: msg || `正在生成章节…（${p}%）` });
          },
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.genStream || '') : ((this._slices.get(String(originId)) || {}).genStream || '');
            const updated = cur + unescapeUnicode(d);
            this._commit(originId, { genStream: updated });
            saveGenDraft(this.novelId, updated, params.chapterIndex ?? null);
          },
          onReset: () => {
            this._commit(originId, { genStream: '' });
            clearGenDraft(this.novelId);
          },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        clearGenDraft(this.novelId);
        done = true;
        const resultPatch = {
          novel: data.novel,
          chapters: data.novel.chapters,
          activeChapter: data.chapter,
          chapterEdit: false,
          generationAsk: { chapter: data.chapter, autoPolished: !!data.autoPolished },
          busy: false, busyLabel: '', genStream: '', genProgress: 100, _genAbort: null
        };
        if (data.foreshadowings) resultPatch.foreshadowings = data.foreshadowings;
        this._commit(originId, resultPatch);
        if (String(this.novelId) === String(originId) && data.chapter) {
          this.activeChapter = data.chapter;
        } else if (String(this.novelId) !== String(originId)) {
          const s = this._slices.get(String(originId)) || {};
          s.activeChapter = data.chapter || s.activeChapter;
          this._slices.set(String(originId), s);
        }
        return data;
      } catch (e) {
        if (e.message === '已停止') {
          this._commit(originId, { busy: false, busyLabel: '', genStream: '', genProgress: 0, _genAbort: null });
          return null;
        }
        const partial = this.genStream || '';
        this._commit(originId, { busy: false, busyLabel: '生成失败', genStream: partial || '', genProgress: 0, _genAbort: null });
        if (partial) {
          saveGenDraft(this.novelId, partial, params.chapterIndex ?? null);
        }
        throw e;
      } finally {
        if (!done) {
          this._commit(originId, { busy: false, busyLabel: '', genStream: '', genProgress: 0, _genAbort: null });
        }
      }
    },

    clearGenerationAsk() {
      this.generationAsk = null;
    },

    // ---------- 生成中断恢复 ----------
    hasGenDraft() {
      return getGenDraftMeta(this.novelId)?.text?.length > 0;
    },

    resumeGenDraft() {
      const meta = getGenDraftMeta(this.novelId);
      clearGenDraft(this.novelId);
      if (!meta || !meta.text) return null;
      const idx = meta.idx;
      let target = null;
      // 优先找草稿记录的章节；仅当其仍为「规划中空章节」时直接承接
      if (idx != null) {
        const found = this.chapters.find((c) => c.chapter_index === idx);
        if (found && !found.word_count) target = found;
      }
      if (!target) target = this.chapters.find((c) => !c.word_count) || null;
      // 空章节可承接则进入编辑；否则必须覆盖已有内容，交由界面二次确认
      let overwrite = false;
      if (!target) {
        if (idx != null) target = this.chapters.find((c) => c.chapter_index === idx) || null;
        if (!target) target = this.activeChapter || this.chapters[0] || null;
        overwrite = !!target && !!target.word_count;
      }
      if (target) {
        this.activeChapter = target;
        this.editContent = meta.text;
        this.chapterEdit = true;
      }
      return { draft: meta.text, overwrite };
    },

    // ---------- 上下文压缩 ----------
    async compressContext() {
      if (this.busy) return;
      const originId = this.novelId;
      this.busy = true;
      this.busyLabel = '正在压缩上下文…';
      this.genStream = '';
      try {
        const p = api.compressContext(this.novelId, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.genStream || '') : ((this._slices.get(String(originId)) || {}).genStream || '');
            this._commit(originId, { genStream: cur + d });
          },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        this._commit(originId, { novel: data.novel, busy: false, busyLabel: '', genStream: '', _genAbort: null });
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { busy: false, busyLabel: '', genStream: '', _genAbort: null });
      }
    },

    async restoreContext() {
      const data = await api.restoreContext(this.novelId);
      this.novel = data.novel;
      return data;
    },

    // 去AI味润色当前章节
    async polishChapter() {
      if (this.busy || !this.activeChapter) return null;
      const originId = this.novelId;
      const idx = this.activeChapter.chapter_index;
      this.busy = true;
      this.busyLabel = '正在去除 AI 味…';
      this.genStream = '';
      this.genProgress = 0;
      try {
        const p = api.polishChapter(this.novelId, idx, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onProgress: (pct, msg) => {
            const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: p, busyLabel: msg || `正在去除 AI 味…（${p}%）` });
          },
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.genStream || '') : ((this._slices.get(String(originId)) || {}).genStream || '');
            this._commit(originId, { genStream: cur + d });
          },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        this._commit(originId, { activeChapter: data.chapter, chapterEdit: false, busy: false, busyLabel: '', genStream: '', genProgress: 100, _genAbort: null });
        if (String(this.novelId) === String(originId)) await this.refresh();
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { busy: false, busyLabel: '', genStream: '', genProgress: 0, _genAbort: null });
      }
    },

    // 按作者要求修改当前章节
    async reviseChapter(instructions) {
      if (this.busy || !this.activeChapter) return null;
      const originId = this.novelId;
      const idx = this.activeChapter.chapter_index;
      this.busy = true;
      this.busyLabel = '正在按要求修改…';
      this.genStream = '';
      this.genProgress = 0;
      try {
        const p = api.reviseChapter(this.novelId, idx, instructions, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onProgress: (pct, msg) => {
            const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: p, busyLabel: msg || `正在按要求修改…（${p}%）` });
          },
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.genStream || '') : ((this._slices.get(String(originId)) || {}).genStream || '');
            this._commit(originId, { genStream: cur + unescapeUnicode(d) });
          },
          onReset: () => { this._commit(originId, { genStream: '' }); },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        this._commit(originId, { activeChapter: data.chapter, chapterEdit: false, busy: false, busyLabel: '', genStream: '', genProgress: 100, _genAbort: null });
        if (String(this.novelId) === String(originId)) await this.refresh();
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { busy: false, busyLabel: '', genStream: '', genProgress: 0, _genAbort: null });
      }
    },

    // ---------- 对话 ----------
    async loadChat() {
      try {
        this.chatMessages = await api.getChat(this.novelId);
      } catch { /* ignore */ }
    },

    async clearChat() {
      await api.clearChat(this.novelId);
      this.chatMessages = [];
      this.chatStream = '';
    },

    async sendChat(content) {
      if (this.chatBusy || this.busy) return;
      const originId = this.novelId;
      if (!Array.isArray(this.chatMessages)) this.chatMessages = [];
      this.chatBusy = true;
      this.chatStream = '';
      try {
        this.chatMessages.push({ role: 'user', content });
        const p = api.sendChat(this.novelId, { content }, {
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.chatStream || '') : ((this._slices.get(String(originId)) || {}).chatStream || '');
            this._commit(originId, { chatStream: cur + unescapeUnicode(d) });
          }
        });
        this._chatAbort = p.abort;
        const data = await p;
        if (data && data.reply) {
          this._pushChatMessage(originId, { role: 'assistant', content: data.reply });
        } else {
          this._pushChatMessage(originId, { role: 'assistant', content: '(AI 未返回内容，请重试)' });
        }
      } catch (e) {
        if (e.message !== '已停止') {
          this._pushChatMessage(originId, { role: 'assistant', content: `⚠ 出错了：${e.message}` });
        }
      } finally {
        this._commit(originId, { chatBusy: false, chatStream: '', _chatAbort: null });
      }
    },

    _pushChatMessage(originId, msg) {
      if (String(this.novelId) === String(originId)) {
        this.chatMessages.push(msg);
      } else {
        const s = this._slices.get(String(originId)) || {};
        if (!Array.isArray(s.chatMessages)) s.chatMessages = [];
        s.chatMessages.push(msg);
        this._slices.set(String(originId), s);
      }
    },

    // ---------- 角色 ----------
    async createCharacter(data) {
      const c = await api.createCharacter(this.novelId, data);
      this.characters.push(c);
      await this.refresh();
      return c;
    },
    async updateCharacter(cid, data) {
      await api.updateCharacter(this.novelId, cid, data);
      await this.refresh();
    },
    async deleteCharacter(cid) {
      await api.deleteCharacter(this.novelId, cid);
      await this.refresh();
    },
    async applyAnalyzedCharacters(list) {
      for (const c of list) {
        await api.createCharacter(this.novelId, c);
      }
      await this.refresh();
    },

    // ---------- 势力 ----------
    async createFaction(data) {
      const f = await api.createFaction(this.novelId, data);
      this.factions.push(f);
      await this.refresh();
      return f;
    },
    async updateFaction(fid, data) {
      await api.updateFaction(this.novelId, fid, data);
      await this.refresh();
    },
    async deleteFaction(fid) {
      await api.deleteFaction(this.novelId, fid);
      await this.refresh();
    },

    // ---------- 关系 ----------
    async createRelationship(data) {
      await api.createRelationship(this.novelId, data);
      await this.refresh();
    },
    async updateRelationship(rid, data) {
      await api.updateRelationship(this.novelId, rid, data);
      await this.refresh();
    },
    async deleteRelationship(rid) {
      await api.deleteRelationship(this.novelId, rid);
      await this.refresh();
    },

    // ---------- 伏笔 ----------
    async loadForeshadowings() {
      this.foreshadowLoading = true;
      try {
        this.foreshadowings = await api.getForeshadowings(this.novelId);
      } finally {
        this.foreshadowLoading = false;
      }
    },
    async addForeshadowing(data) {
      const f = await api.createForeshadowing(this.novelId, data);
      this.foreshadowings.unshift(f);
      return f;
    },
    async updateForeshadowing(fid, data) {
      const f = await api.updateForeshadowing(this.novelId, fid, data);
      const i = this.foreshadowings.findIndex((x) => x.id === fid);
      if (i > -1) this.foreshadowings[i] = f;
      return f;
    },
    async removeForeshadowing(fid) {
      await api.deleteForeshadowing(this.novelId, fid);
      this.foreshadowings = this.foreshadowings.filter((x) => x.id !== fid);
    },
    async analyzeForeshadowings() {
      const data = await api.analyzeForeshadowings(this.novelId);
      this.foreshadowings = data.foreshadowings || this.foreshadowings;
      return data;
    },

    // ---------- 世界观设定 ----------
    async loadWorldSettings() {
      this.worldSettingsLoading = true;
      try {
        this.worldSettings = await api.getWorldSettings(this.novelId);
      } finally {
        this.worldSettingsLoading = false;
      }
    },
    async addWorldSetting(data) {
      const s = await api.createWorldSetting(this.novelId, data);
      this.worldSettings.push(s);
      return s;
    },
    async updateWorldSetting(sid, data) {
      const s = await api.updateWorldSetting(this.novelId, sid, data);
      const i = this.worldSettings.findIndex((x) => x.id === sid);
      if (i > -1) this.worldSettings[i] = s;
      return s;
    },
    async removeWorldSetting(sid) {
      await api.deleteWorldSetting(this.novelId, sid);
      this.worldSettings = this.worldSettings.filter((x) => x.id !== sid);
    },

    // ================= 整本改编（TXT 导入 + 逐章候选） =================
    async importTxt(title, content) {
      const data = await api.importTxt({ title, content });
      if (data?.novel) {
        await this.switchTo(data.novel.id);
      }
      return data;
    },

    // 打开改编对话框并生成改编方案（SSE 流式）
    async startAdaptation(intent) {
      const originId = this.novelId;
      this.adaptBusy = true;
      this.adaptPlanStream = '';
      this.adaptDialog = true;
      try {
        const p = api.adaptationPlan(this.novelId, intent, {
          onStatus: (m) => { this._commit(originId, { adaptBusy: true }); },
          onProgress: (pct, msg) => {
            const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: v, busyLabel: msg || '正在生成改编方案…' });
          },
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.adaptPlanStream || '') : ((this._slices.get(String(originId)) || {}).adaptPlanStream || '');
            this._commit(originId, { adaptPlanStream: cur + unescapeUnicode(d) });
          },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        const plans = Array.isArray(data.plans) ? data.plans : [];
        this._commit(originId, {
          adaptJob: {
            ...(this.adaptJob || {}),
            id: data.jobId, status: 'plan_ready', plan: data.plan,
            plans
          },
          adaptBusy: false, adaptPlanStream: '', _genAbort: null
        });
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { adaptBusy: false, _genAbort: null });
      }
    },

    // 选择改编方案（多方案中选一个）后开始
    async selectAdaptationPlan(planId) {
      try {
        const data = await api.selectAdaptationPlan(this.novelId, planId);
        await this.loadAdaptation();
        return data;
      } catch (e) {
        throw e;
      }
    },

    // 开始逐章改编（方案确认后）
    async beginAdaptation() {
      await api.adaptationStart(this.novelId);
      await this.loadAdaptation();
      return true;
    },

    // 生成当前章的候选（SSE），返回候选数据
    async adaptationNext() {
      if (this.adaptBusy) return null;
      const originId = this.novelId;
      this.adaptBusy = true;
      this.adaptTargetChapter = null;
      try {
        const p = api.adaptationNext(this.novelId, {
          onStatus: (m) => { this._commit(originId, { busyLabel: m }); },
          onProgress: (pct, msg) => {
            const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            this._commit(originId, { genProgress: v, busyLabel: msg || '正在改编…' });
          },
          onDelta: (d) => {
            const cur = String(this.novelId) === String(originId) ? (this.$state.genStream || '') : ((this._slices.get(String(originId)) || {}).genStream || '');
            this._commit(originId, { genStream: cur + unescapeUnicode(d) });
          },
          onError: (m) => { throw new Error(m); }
        });
        this._genAbort = p.abort;
        const data = await p;
        await this.loadAdaptation();
        this._commit(originId, {
          adaptTargetChapter: data?.candidate?.chapter_index ?? null,
          adaptCompare: data?.candidate ?? null,
          adaptBusy: false, genStream: '', genProgress: 100, _genAbort: null
        });
        return data;
      } catch (e) {
        if (e.message === '已停止') return null;
        throw e;
      } finally {
        this._commit(originId, { adaptBusy: false, genStream: '', genProgress: 0, _genAbort: null });
      }
    },

    // 采纳候选：写入正式章节
    async acceptCandidate(cid) {
      const originId = this.novelId;
      const data = await api.acceptCandidate(cid);
      await this.loadAdaptation();
      if (String(this.novelId) === String(originId)) await this.refresh();
      this._commit(originId, { adaptCompare: null, adaptTargetChapter: null });
      return data;
    },

    // 跳过候选：保留原文
    async skipCandidate(cid) {
      await api.skipCandidate(cid);
      await this.loadAdaptation();
      this._commit(this.novelId, { adaptCompare: null, adaptTargetChapter: null });
    },

    // 重试候选：重新生成该章
    async retryCandidate(cid) {
      await api.retryCandidate(cid);
      await this.loadAdaptation();
      return this.adaptationNext();
    },

    // 批量采纳/跳过全部 pending 候选
    async batchAdaptation(status) {
      if (!this.adaptJob || !this.adaptJob.id) return;
      await api.batchAdaptationCandidates({ status, jobId: this.adaptJob.id });
      await this.loadAdaptation();
      await this.refresh();
      this._commit(this.novelId, { adaptCompare: null, adaptTargetChapter: null });
    },

    // 加载/恢复改编任务进度
    async loadAdaptation() {
      const data = await api.getAdaptation(this.novelId);
      this._commit(this.novelId, {
        adaptJob: data.job,
        adaptCandidates: data.candidates || []
      });
      return data;
    },

    closeAdaptDialog() {
      this._commit(this.novelId, { adaptDialog: false, adaptPlanStream: '' });
    }
  }
});
