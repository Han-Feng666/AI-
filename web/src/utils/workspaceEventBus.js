// Phase 10 — workspaceEventBus: 跨 store / 跨组件事件总线
// 用途：工作区 AI（editor）→ 总管 AI（manager）联动；多本并行时其他模块也可订阅
//
// 主要事件类型（设计约定，不强约束）：
//   'novel:planAccepted'   { novelId }       — 创作方案被采纳（plan versions accept 触发）
//   'novel:planGenerated'  { novelId }       — 方案首次生成（plan 完成）
//   'novel:outlineUpdated' { novelId }       — outline 被修改（manager update_outline 触发）
//   'novel:characterUpdated' { novelId, name } — 角色被修改
//   'novel:chapterGenerated' { novelId, idx }   — 章节生成完成
//   'novel:reviseRequested' { novelId, feedback } — 修订请求发出
//   'novel:generateChapterRequested' { novelId } — 章节生成请求

class EventBus {
  constructor() {
    this._map = new Map();
  }
  on(type, handler) {
    if (!this._map.has(type)) this._map.set(type, new Set());
    this._map.get(type).add(handler);
    return () => this.off(type, handler);
  }
  off(type, handler) {
    this._map.get(type)?.delete(handler);
  }
  emit(type, payload) {
    this._map.get(type)?.forEach((h) => {
      try { h(payload); }
      catch (e) { console.warn('[workspaceEventBus] handler error:', e); }
    });
  }
  clear() { this._map.clear(); }
}

export const workspaceEventBus = new EventBus();
export default workspaceEventBus;
