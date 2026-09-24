import { defineStore } from 'pinia';

// AI 思考过程：订阅 /api/thinking/stream SSE，
// 维护会话列表（新→旧），跟随最新会话；晚接入时靠服务端 snapshot 拿已有内容。
export const useThinkingStore = defineStore('thinking', {
  state: () => ({
    sessions: [],
    activeId: null,
    connected: false,
    _es: null
  }),
  getters: {
    active: (s) => s.sessions.find((x) => x.id === s.activeId) || s.sessions[0] || null
  },
  actions: {
    connect() {
      if (this._es) return;
      try {
        this._es = new EventSource('/api/thinking/stream');
      } catch {
        return;
      }
      this._es.onopen = () => { this.connected = true; };
      this._es.onerror = () => { this.connected = false; };
      this._es.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this._handle(msg);
      };
    },
    _handle(msg) {
      if (msg.type === 'snapshot') {
        this.sessions = [];
        if (msg.session) this.sessions.push(msg.session);
        for (const h of msg.history || []) {
          if (h.id !== msg.session?.id) this.sessions.push(h);
        }
        this.activeId = msg.session?.id || this.sessions[0]?.id || null;
        return;
      }
      if (msg.type === 'think_start') {
        this.sessions.unshift({
          id: msg.id,
          label: msg.label,
          model: msg.model,
          text: '',
          status: 'thinking',
          startedAt: msg.startedAt,
          updatedAt: msg.startedAt
        });
        if (this.sessions.length > 50) this.sessions.length = 50;
        this.activeId = msg.id;
        return;
      }
      if (msg.type === 'think_delta') {
        let s = this.sessions.find((x) => x.id === msg.id);
        if (!s) {
          s = {
            id: msg.id,
            label: '模型调用',
            model: '',
            text: '',
            status: 'thinking',
            startedAt: Date.now(),
            updatedAt: Date.now()
          };
          this.sessions.unshift(s);
          this.activeId = s.id;
        }
        s.text += msg.text;
        s.updatedAt = Date.now();
        return;
      }
      if (msg.type === 'think_end') {
        const s = this.sessions.find((x) => x.id === msg.id);
        if (s) {
          s.status = msg.status;
          s.updatedAt = msg.updatedAt || Date.now();
        }
      }
    },
    setActive(id) {
      this.activeId = id;
    },
    clear() {
      this.sessions = [];
      this.activeId = null;
    }
  }
});
