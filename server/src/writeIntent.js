// 作者消息写操作意图检测：命中"改大纲/改角色/修订/生成章节/修改章节/引入共享角色"等
// 需要前端授权执行的写操作时返回 true。/manager/chat 用它判断：模型只回文字未调工具时
// 应强制补发一次工具调用，否则前端永远弹不出授权条。
// 命中逻辑：写类动词（改/更新/调整/重写/修订/生成/写…）与写类目标（大纲/方案/角色/人设/设定/章节…）
// 在附近共现；或者匹配"修改第N章 / 生成下一章 / 引入共享角色"这类固定结构。
const WRITE_VERB_RE = /(改|修改|更新|调整|重写|修订|写|生成|引入)/;
const WRITE_TARGET_RE = /(大纲|方案|角色|人设|设定|新章节|下一章|最新章节|新的一章|第\s*\d+\s*章|共享角色)/;
const WRITE_INTENT_RE = /修改第\s*\d+\s*章|(改|修改|更新|调整|重写|修订)\s*(一下|下|一|了|一遍|一下下)?\s*(剧情\s*)?(大纲|方案|角色|人设|设定)|生成\s*(下一章|新章节|最新章节|新的一章)|写\s*(下一章|新章节|新的一章|后续|结局)|引入\s*共享角色|新书\s*用|跨书.*角色|把\s*[^\s，。]{1,20}(大纲|方案|角色|人设|设定|剧情)\s*(更新|修改|调整|重写|改)/;

export function detectWriteIntent(userText) {
  const text = String(userText || '');
  if (!text) return false;
  if (WRITE_INTENT_RE.test(text)) return true;
  // 宽松补充：写类动词与写类目标在 12 字内共现（覆盖"把剧情大纲更新成穿越流"等语序不固定场景）
  const m = text.match(WRITE_VERB_RE);
  if (!m) return false;
  const verbPos = m.index;
  const t = text.match(WRITE_TARGET_RE);
  if (!t) return false;
  return Math.abs(t.index - verbPos) <= 12;
}
