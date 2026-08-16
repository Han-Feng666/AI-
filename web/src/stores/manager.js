import { defineStore } from 'pinia';
import api from '../api';
import workspaceEventBus from '../utils/workspaceEventBus';

// Phase 6：总管 AI 独立 store —— 与 editor 分离，跨模型记忆持久在后端
// ChatPanel 不再被 store.busy 阻塞
export const useManagerStore = defineStore('manager', {
  state: () => ({
    messages: [],
    pendingToolCalls: [],   // 当前待授权工具调用列表
    busy: false,
    replyStream: '',
    loadedNovelId: null
  }),

  getters: {
    hasPending: (s) => s.pendingToolCalls.length > 0
  },

  actions: {
    async load(novelId) {
      this.loadedNovelId = novelId;
      try {
        const r = await api.managerMessages(novelId);
        this.messages = (r.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          toolName: m.tool_name,
          toolCallId: m.tool_call_id,
          createdAt: m.created_at
        }));
      } catch { /* ignore */ }
    },

    clearLocal() {
      this.messages = [];
      this.pendingToolCalls = [];
      this.replyStream = '';
      this.busy = false;
    },

    // 发送对话：调 POST /manager/chat（非流式）
    // 同时再把 ChatPanel 老的 store.sendChat 路径继续兼容
    async send(content, novelId) {
      if (this.busy) return;
      const text = String(content || '').trim();
      if (!text) return;
      const originId = novelId;
      this.busy = true;
      this.replyStream = '';
      // optimistic user
      this.messages.push({ role: 'user', content: text });
      try {
        const r = await api.managerChat(novelId, { content: text, novel_id: novelId });
        const same = this.loadedNovelId === originId;
        if (r.reply && same) {
          this.messages.push({ role: 'assistant', content: r.reply });
        }
        if (Array.isArray(r.pendingToolCalls) && r.pendingToolCalls.length && same) {
          this.pendingToolCalls.push(...r.pendingToolCalls);
        }
        return r;
      } catch (e) {
        if (this.loadedNovelId === originId) {
          this.messages.push({ role: 'assistant', content: '出错了：' + e.message });
        }
        throw e;
      } finally {
        if (this.loadedNovelId === originId) this.busy = false;
      }
    },

    async authorize(callId) {
      try {
        const r = await api.managerAuthorize(callId);
        const meta = this.pendingToolCalls.find((c) => c.id === callId);
        const args = meta?.args || {};
        this.messages.push({ role: 'tool', content: JSON.stringify(r.result || {}), toolName: meta?.name });
        this.pendingToolCalls = this.pendingToolCalls.filter((c) => c.id !== callId);
        // Phase 10：联动总线——授权执行落库后通知工作区 store 刷新
        if (meta?.name === 'update_outline' && args.novel_id) {
          workspaceEventBus.emit('novel:outlineUpdated', { novelId: Number(args.novel_id) });
        } else if (meta?.name === 'update_character' && args.novel_id) {
          workspaceEventBus.emit('novel:characterUpdated', { novelId: Number(args.novel_id), name: args.name });
        } else if (meta?.name === 'request_revise') {
          // User 没在这 SDK 里实现 request_revise（直接复用后端 revise 路由触发 job）—— 保留事件
          workspaceEventBus.emit('novel:reviseRequested', { novelId: Number(args.novel_id), feedback: args.feedback });
        } else if (meta?.name === 'request_generate_chapter') {
          workspaceEventBus.emit('novel:generateChapterRequested', { novelId: Number(args.novel_id) });
        } else if (meta?.name === 'request_revise_chapter') {
          workspaceEventBus.emit('novel:reviseChapterRequested', { novelId: Number(args.novel_id), chapterIndex: Number(args.chapter_index), instructions: args.instructions });
        }
        return r;
      } catch (e) {
        this.messages.push({ role: 'assistant', content: '授权失败：' + e.message });
        throw e;
      }
    },

    async clear(novelId) {
      try {
        await api.managerClear(novelId);
      } catch (e) {
        throw new Error('清空失败：' + e.message);
      }
    },

    async reject(callId) {
      try {
        await api.managerReject(callId);
        this.messages.push({ role: 'tool', content: JSON.stringify({ rejected: true }), toolName: this.pendingToolCalls.find((c) => c.id === callId)?.name });
        this.pendingToolCalls = this.pendingToolCalls.filter((c) => c.id !== callId);
      } catch (e) {
        this.pendingToolCalls = this.pendingToolCalls.filter((c) => c.id !== callId);
      }
    }
  }
});
