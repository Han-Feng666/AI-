import { db, getSetting, setSetting } from './db.js';

export function countWords(text) {
  if (!text) return 0;
  const noWs = String(text).replace(/\s+/g, '');
  const cjk = (noWs.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = noWs.length - cjk;
  return cjk + Math.round(other / 2);
}

export function getLLMConfig() {
  try {
    const cfg = JSON.parse(getSetting('llm_config') || '{}');
    return normalizeLLMConfig(cfg);
  } catch {
    return {};
  }
}

// 规范化 LLM 配置的数值字段：防历史数据/手输把 temperature/maxTokens/contextLength 存成字符串，
// 导致部分服务商严格类型校验时报 400（如 'temperature' must be Float）
export function normalizeLLMConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  const out = { ...cfg };
  const toNum = (v, def) => {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  if (out.temperature !== undefined) out.temperature = Math.min(1.99, Math.max(0, toNum(out.temperature, 0.9)));
  if (out.maxTokens !== undefined) out.maxTokens = toNum(out.maxTokens, 8192);
  if (out.contextLength !== undefined) out.contextLength = toNum(out.contextLength, 32768);
  if (out.max_tokens !== undefined) out.max_tokens = toNum(out.max_tokens, 8192);
  if (out.compressThreshold !== undefined) out.compressThreshold = Math.min(0.95, Math.max(0.1, toNum(out.compressThreshold, 0.5)));
  return out;
}

export function saveLLMConfig(config) {
  setSetting('llm_config', JSON.stringify(normalizeLLMConfig(config)));
}

export function getNovel(id) {
  const n = db.prepare('SELECT * FROM novels WHERE id = ?').get(id);
  if (n) {
    try { n.style_ids = JSON.parse(n.style_ids || '[]'); } catch { n.style_ids = []; }
    try { n.style_presets = parseStylePresets(n); } catch { n.style_presets = []; }
    try { n.skill_ids = JSON.parse(n.skill_ids || '[]'); } catch { n.skill_ids = []; }
    try { n.story_arcs = n.story_arcs ? JSON.parse(n.story_arcs) : null; } catch { n.story_arcs = null; }
    try { n.expanded_world = n.expanded_world ? JSON.parse(n.expanded_world) : null; } catch { n.expanded_world = null; }
  }
  return n;
}

export function parseStylePresets(novel) {
  if (!novel) return [];
  return String(novel.style_presets || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getStyles(ids) {
  if (!ids || !ids.length) return [];
  const unique = [...new Set(ids.map(Number).filter(Boolean))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM styles WHERE id IN (${placeholders})`).all(...unique);
}

export function getStyle(id) {
  return db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
}

export function parseStyleIds(novel) {
  if (!novel) return [];
  const v = novel.style_ids;
  if (Array.isArray(v)) return v.map(Number).filter(Boolean);
  try { return JSON.parse(v || '[]').map(Number).filter(Boolean); } catch { return []; }
}

// 超长文本抽样：保留开头、均匀抽取中段、保留结尾，用于风格分析等大文本场景
export function sampleText(text, budget = 60000) {
  if (!text) return '';
  const total = text.length;
  if (total <= budget) return text;
  const KEEP_START = Math.floor(budget * 0.2);
  const KEEP_END = Math.floor(budget * 0.2);
  const middleBudget = budget - KEEP_START - KEEP_END;
  const pieces = [text.slice(0, KEEP_START)];
  const middle = text.slice(KEEP_START, total - KEEP_END);
  if (middleBudget > 0 && middle.length) {
    const pieceLen = 3000;
    const count = Math.max(1, Math.min(12, Math.floor(middleBudget / pieceLen)));
    for (let i = 0; i < count; i++) {
      const start = Math.floor(((i + 0.5) / count) * middle.length);
      pieces.push(middle.slice(start, Math.min(start + pieceLen, middle.length)));
    }
  }
  pieces.push(text.slice(total - KEEP_END));
  return pieces.join('\n\n……（此处省略，下接原文抽样）……\n\n');
}

// 伏笔清单
export function getForeshadowings(novelId) {
  return db.prepare(
    "SELECT * FROM foreshadowings WHERE novel_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC"
  ).all(novelId);
}

export function getOpenForeshadowings(novelId, limit = 30, beforeIndex = null) {
  if (beforeIndex !== null) {
    return db.prepare(
      'SELECT * FROM foreshadowings WHERE novel_id = ? AND status = ? AND chapter_index < ? ORDER BY id ASC LIMIT ?'
    ).all(novelId, 'open', beforeIndex, limit);
  }
  return db.prepare(
    'SELECT * FROM foreshadowings WHERE novel_id = ? AND status = ? ORDER BY id ASC LIMIT ?'
  ).all(novelId, 'open', limit);
}

export function formatForeshadowList(items) {
  if (!items || !items.length) return '';
  return items
    .map((f, i) => `${i + 1}. ${f.content}（第${f.chapter_index || '?'}章埋下${f.note ? '；备注：' + f.note : ''}）`)
    .join('\n');
}

// 关键剧情事实锚点：长期连载中防止设定冲突与关键信息遗忘
export function getKeyMoments(novelId, limit = 80, beforeIndex = null) {
  if (beforeIndex !== null) {
    return db.prepare(
      'SELECT * FROM novel_key_moments WHERE novel_id = ? AND chapter_index < ? ORDER BY id DESC LIMIT ?'
    ).all(novelId, beforeIndex, limit).reverse();
  }
  return db.prepare(
    'SELECT * FROM novel_key_moments WHERE novel_id = ? ORDER BY id DESC LIMIT ?'
  ).all(novelId, limit).reverse();
}

export function formatKeyMoments(items) {
  if (!items || !items.length) return '';
  return items
    .map((m) => `- ${m.content}${m.chapter_index ? `（第${m.chapter_index}章）` : ''}`)
    .join('\n');
}

export function addKeyMomentUnique(novelId, content, chapterIndex) {
  const text = String(content || '').trim();
  if (!text) return null;
  const exists = db.prepare(
    "SELECT id FROM novel_key_moments WHERE novel_id = ? AND (content = ? OR instr(?, content) > 0 OR instr(content, ?) > 0)"
  ).get(novelId, text, text, text.slice(0, 20));
  if (exists) return null;
  const info = db.prepare(
    'INSERT INTO novel_key_moments (novel_id, content, chapter_index) VALUES (?,?,?)'
  ).run(novelId, text, chapterIndex || 0);
  return db.prepare('SELECT * FROM novel_key_moments WHERE id = ?').get(info.lastInsertRowid);
}

// 阶段记忆（卷快照）：每 50 章浓缩一条，超长连载中早期剧情不丢
export function getStageMemories(novelId, beforeIndex = null) {
  if (beforeIndex !== null) {
    return db.prepare(
      'SELECT * FROM novel_stage_memories WHERE novel_id = ? AND stage_end < ? ORDER BY stage_no'
    ).all(novelId, beforeIndex);
  }
  return db.prepare(
    'SELECT * FROM novel_stage_memories WHERE novel_id = ? ORDER BY stage_no'
  ).all(novelId);
}

export function upsertStageMemory(novelId, stageNo, start, end, content) {
  const exists = db.prepare(
    'SELECT id FROM novel_stage_memories WHERE novel_id = ? AND stage_no = ?'
  ).get(novelId, stageNo);
  const text = String(content || '').trim();
  if (!text) return null;
  if (exists) {
    db.prepare(
      "UPDATE novel_stage_memories SET stage_start = ?, stage_end = ?, content = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(start, end, text, exists.id);
    return db.prepare('SELECT * FROM novel_stage_memories WHERE id = ?').get(exists.id);
  }
  const info = db.prepare(
    'INSERT INTO novel_stage_memories (novel_id, stage_no, stage_start, stage_end, content) VALUES (?,?,?,?,?)'
  ).run(novelId, stageNo, start, end, text);
  return db.prepare('SELECT * FROM novel_stage_memories WHERE id = ?').get(info.lastInsertRowid);
}

export function formatStageMemories(items, limit = 3) {
  if (!items || !items.length) return '';
  return items
    .slice(-limit)
    .map((s) => `【第${s.stage_no}阶段 · 第${s.stage_start}-${s.stage_end}章】${s.content}`)
    .join('\n\n');
}

// 角色档案：确保长篇连载中角色性格、言行、目标前后一致
export function getCharacterProfiles(novelId) {
  return db.prepare(
    'SELECT * FROM novel_character_profiles WHERE novel_id = ? ORDER BY id'
  ).all(novelId);
}

export function upsertCharacterProfile(novelId, name, profile, chapterIndex) {
  const text = String(profile || '').trim();
  const cname = String(name || '').trim();
  if (!text || !cname) return null;
  const exists = db.prepare(
    'SELECT id FROM novel_character_profiles WHERE novel_id = ? AND char_name = ?'
  ).get(novelId, cname);
  if (exists) {
    db.prepare(
      "UPDATE novel_character_profiles SET profile = ?, chapter_index = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(text, chapterIndex || 0, exists.id);
    return db.prepare('SELECT * FROM novel_character_profiles WHERE id = ?').get(exists.id);
  }
  const info = db.prepare(
    'INSERT INTO novel_character_profiles (novel_id, char_name, profile, chapter_index) VALUES (?,?,?,?)'
  ).run(novelId, cname, text, chapterIndex || 0);
  return db.prepare('SELECT * FROM novel_character_profiles WHERE id = ?').get(info.lastInsertRowid);
}

export function formatCharacterProfiles(items) {
  if (!items || !items.length) return '';
  return items.map((c) => `- ${c.char_name}：${c.profile}`).join('\n');
}

export function getRecentChapters(novelId, n = 2, beforeIndex = null) {
  if (beforeIndex !== null) {
    return db.prepare('SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != \'\' AND chapter_index < ? ORDER BY chapter_index DESC LIMIT ?').all(novelId, beforeIndex, n).reverse();
  }
  return db.prepare('SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != \'\' ORDER BY chapter_index DESC LIMIT ?').all(novelId, n).reverse();
}

export function getCharacters(novelId) {
  return db.prepare('SELECT * FROM characters WHERE novel_id = ? ORDER BY id').all(novelId);
}

export function getFactions(novelId) {
  return db.prepare('SELECT * FROM factions WHERE novel_id = ? ORDER BY id').all(novelId);
}

export function getRelationships(novelId) {
  return db.prepare('SELECT * FROM relationships WHERE novel_id = ?').all(novelId);
}

export function getChapters(novelId) {
  return db.prepare('SELECT id, novel_id, chapter_index, title, summary, emotion, arc_hint, hook, beats, word_count, status, ai_score, created_at, updated_at FROM chapters WHERE novel_id = ? ORDER BY chapter_index').all(novelId);
}

export function getChapter(novelId, chapterIndex) {
  return db.prepare('SELECT * FROM chapters WHERE novel_id = ? AND chapter_index = ?').get(novelId, chapterIndex);
}

export function getMaxChapterIndex(novelId) {
  const row = db.prepare('SELECT MAX(chapter_index) m FROM chapters WHERE novel_id = ?').get(novelId);
  return row ? (row.m || 0) : 0;
}

// 判定是否应自动首次压缩：未启用压缩时，最近已写章节注入下章的字符数超过模型上下文预算的阈值比例
export function shouldAutoCompress(novel, config, recentChars) {
  if (config && config.autoCompress === false) return false;
  if (novel && novel.context_compressed == 1) return false;
  const ctx = Number(config?.contextLength) || 32768;
  const out = Number(config?.maxTokens) || 8192;
  const budget = Math.max(4096, Math.floor(ctx - out - 4096));
  const threshold = Number(config?.compressThreshold) || 0.5;
  // token 近似换字符：×1.5（中文），下限 4000 字避免短篇过早压缩
  const charLimit = Math.max(4000, Math.round(budget * threshold * 1.5));
  return Number(recentChars) >= charLimit;
}

export function getChapterBackups(novelId, chapterIndex) {
  return db.prepare('SELECT id, novel_id, chapter_index, title, content, reason, created_at FROM chapter_backups WHERE novel_id = ? AND chapter_index = ? ORDER BY id DESC').all(novelId, chapterIndex);
}

export function getWorldSettings(novelId) {
  return db.prepare("SELECT * FROM world_settings WHERE novel_id = ? ORDER BY CASE category WHEN '人物' THEN 0 WHEN '地点' THEN 1 WHEN '势力' THEN 2 WHEN '物品' THEN 3 WHEN '时间线' THEN 4 WHEN '其他' THEN 5 END, id").all(novelId);
}

export function formatWorldSettings(items) {
  if (!items || !items.length) return '';
  const groups = {};
  for (const s of items) {
    (groups[s.category || '其他'] = groups[s.category || '其他'] || []).push(s);
  }
  const lines = [];
  for (const [cat, list] of Object.entries(groups)) {
    lines.push(`【${cat}】`);
    for (const s of list) {
      lines.push(`- ${s.name}：${s.content}`);
    }
  }
  return lines.join('\n');
}

// 逐章摘要链：按 token 预算保留摘要，最近优先（预算不足时丢最老摘要）
export function buildHistorySummaries(novelId, budgetTokens, beforeIndex = null) {
  const sql = beforeIndex !== null
    ? "SELECT chapter_index, title, summary FROM chapters WHERE novel_id = ? AND summary != '' AND chapter_index < ? ORDER BY chapter_index"
    : "SELECT chapter_index, title, summary FROM chapters WHERE novel_id = ? AND summary != '' ORDER BY chapter_index";
  const rows = beforeIndex !== null ? db.prepare(sql).all(novelId, beforeIndex) : db.prepare(sql).all(novelId);
  if (!budgetTokens || budgetTokens <= 0 || rows.length <= 1) return rows;
  const kept = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = estimateTokens(`第${rows[i].chapter_index}章 ${rows[i].title}：${rows[i].summary}`) + 1;
    if (kept.length && used + t > budgetTokens) break;
    kept.unshift(rows[i]);
    used += t;
  }
  return kept;
}

export function getNovelProgressText(novel, recentChapters) {
  const lines = [];
  lines.push(`书名：${novel.title || '未命名'}`);
  lines.push(`类型：${novel.genre || '未设定'}`);
  if (novel.world_view) lines.push(`世界观：${novel.world_view.slice(0, 500)}`);
  if (novel.outline) lines.push(`大纲：${novel.outline.slice(0, 800)}`);
  if (recentChapters.length) {
    lines.push('最近剧情：');
    for (const c of recentChapters) {
      lines.push(`第${c.chapter_index}章 ${c.title}：${String(c.content).slice(0, 600)}`);
    }
  }
  return lines.join('\n');
}

// ---------- AI 高频词黑名单硬过滤 ----------
// 这些词是 AI 写作的高频指纹。真人小说偶尔也会用个别词，
// 但同一章出现过多即为"AI 味信号"，作为质量门的硬性判定依据。
const AI_BLACKLIST = [
  '仿佛', '宛如', '犹如', '好似', '不禁', '微微一怔', '喃喃自语', '呢喃',
  '心底涌起', '眸底', '眸子', '眼底深处', '五味杂陈', '若有所思', '氤氲',
  '缱绻', '旖旎', '潋滟', '时光荏苒', '岁月如梭', '岁月静好', '感慨万千',
  '深吸一口气', '久久不能平静', '嘴角勾起一抹', '闪过一丝精光', '绽放出',
  '熠熠生辉', '袅袅', '流淌着', '诉说着', '仿佛能听到', '似乎一切',
  // 2026-08 扩充：真人写作几乎不用的 AI 腔词汇（泛 AI 时代高频）
  '眼眸中', '眼底闪过一丝', '刹那间', '瞬时间', '下一刻', '下一瞬', '下一秒',
  '与此同时', '在这一刻', '那一瞬间', '话锋一转', '轻声细语', '低声呢喃',
  '不由自主地', '下意识地', '不经意间', '猛然间', '倏然', '赫然', '骤然间',
  '心中一惊', '心头一紧', '面色微变', '脸色微变', '眼中闪过一丝', '眼神微眯',
  '淡淡开口', '缓缓开口', '嘴角微微扬起', '嘴角勾起', '露出一丝', '露出一抹',
  '浮现出一丝', '涌上一股', '涌过一丝', '掠过一丝', '拂过一丝', '一股无名火',
  '微微一叹', '轻叹一声', '长叹一口气', '呼出一口浊气', '平复了一下心情',
  '深吸了口气', '深呼一口气', '陷入了沉思', '沉默片刻', '沉吟片刻', '顿了顿',
  '似乎在思考', '像是在思考', '若有所思地', '意味深长地', '意有所指', '弦外之音',
  '氛围一下子', '气氛瞬间', '空气突然安静', '画面感极强', '镜头一转', '时间仿佛静止',
  '一切仿佛', '似乎一切', '仿佛回到了', '仿佛置身于', '似曾相识', '一股暖流',
  '心头一暖', '心里暖暖的', '感慨道', '喃喃道', '轻声道', '低声道', '沉声道',
  '冷冷道', '淡漠道', '平静道', '淡然道', '缓缓道', '一字一句道', '开口道',
  // 2026-09 扩充：情绪反应模板词（AI 让角色用同一套身体反应表达震惊/紧张）
  '如遭雷击', '大脑一片空白', '心脏漏了一拍', '呼吸一窒', '浑身一僵', '瞳孔骤缩',
  '喉结滚动', '指节捏得发白', '指节泛白', '周身一寒', '遍体生寒', '头皮发麻'
];

// ---------- AI 高频句式模板（正则级，比词级黑名单更能抓"AI 腔调"） ----------
// 这些是中文生成模型最常复用的句式骨架，真人偶尔用但密度绝不会高。
// 每命中一处计 1 次，纳入质量门判定。
const AI_SENTENCE_TEMPLATES = [
  { re: /不由(?:自主|自|得)?(?:地|的)?(?:\s*)/g, label: '不由自主句式' },
  { re: /仿佛[\s\S]{0,10}?(?:静止|凝固|是个梦|什么也没发生)/g, label: '仿佛凝固句式' },
  { re: /就在(?:这个)?(?:时候|时(?:候)?|这时)/g, label: '就在这个时候' },
  { re: /时间过.{0,6}(?:飞快|飞快地|如(?:同)?(?:白驹过隙|流水))|光阴如梭/g, label: '时间飞逝句式' },
  { re: /(?:紧|紧地|紧紧)地?(?:攥紧|握住|抓住|抱着|勒紧)/g, label: '紧紧-句式' },
  { re: /一声(?:轻(?:响|轻)?|低哼|闷响|冷哼)/g, label: '一声XX句式' },
  { re: /(?:似乎|好像)想起了什么/g, label: '似乎想起什么' },
  { re: /(?:这股|那)?股(?:寒意|暖流|怒火|杀意)(?:从|自).{0,6}(?:升起|涌起|蔓延|窜起|袭来)/g, label: '一股XX从X升起' },
  { re: /心底(?:深处|里)?(?:闪过|涌起|泛起|升腾起)/g, label: '心底涌起句式' },
  { re: /心中(?:一动|一紧|一沉|大震|涌起|掀起)/g, label: '心中XX句式' },
  { re: /(?:他|她|我)的(?:瞳孔|眼眸|眸子|眼睛)(?:微微|不由|骤然)/g, label: '瞳孔骤缩句式' },
  { re: /(?:像是|好像|仿佛)要把/g, label: '像是要把句式' },
  { re: /(?:不由|忍不住)(?:抬头|低头|抬头望向|摇了摇头)/g, label: '不由抬头句式' },
  { re: /空气(?:中)?(?:仿佛|似乎)?(?:都)?(?:凝固|安静|寂静)(?:了)?(?:数|几)?(?:秒|息)?/g, label: '空气凝固句式' },
  { re: /(?:脑海中|脑海里)(?:不禁|不由|突然)?(?:浮现|闪过|涌出)/g, label: '脑海浮现句式' },
  { re: /(?:这个词|这三个字)(?:还)?(?:在|盘旋)(?:在)?(?:他|她)?(?:脑海里|脑中)/g, label: '四字盘旋句式' },
  { re: /(?:他|她)(?:深吸一口气|呼出一口气)(?:，|,)(?:然后|随即|缓缓)/g, label: '深呼一口气句式' },
  { re: /(?:嘴角|唇边)(?:却|不由|微微)(?:勾起|扬起|浮现)/g, label: '嘴角勾起句式' },
  { re: /(?:一阵|一股)(?:微风|冷风|寒风吹来|暖风)/g, label: '一阵X风句式' },
  { re: /(?:迎着|迎着风|面向|朝着)(?:朝阳|夕阳|夕阳)|(?:(?:夕阳|阳光)(?:下|中|里))(?:他的身影|影子)/g, label: '迎着夕阳句式' },
  { re: /(?:渐渐|逐渐|慢慢)(?:地|的)?(?:合拢|闭合|消散|消失|模糊)/g, label: '渐渐消散句式' },
  { re: /(?:一切|所有|全部)(?:都)?(?:仿佛|像是|似乎)?(?:陷入|归于|化作)(?:了)?(?:虚无|沉寂|平静|寂静)/g, label: '一切归于寂语句式' },
  { re: /(?:命运|宿命)(?:的)?(?:的)?(?:轮回|齿轮|嘲弄)|(?:在(?:这|那)一刻)。{0,8}命运/g, label: '命运齿轮句式' },
  // 2026-08 扩充：泛 AI 时代高频句式骨架
  { re: /(?:(?:空气|气氛|氛围|场面)(?:中)?|(?:整个)?(?:空间|房间|教室|大殿|街道))(?:仿佛|似乎|突然|骤然)?(?:安静|寂静|凝固|凝重|压抑)(?:了)?(?:下来)?(?:。|，)/g, label: '空气凝固句式2' },
  { re: /时间(?:仿佛|似乎|好像)?(?:在此刻|一瞬间|在这一刻|戛然)?(?:静止|停滞|定格)(?:了)?/g, label: '时间静止句式' },
  { re: /(?:这句|这句话|这几个字|方才那句话)(?:仿佛|似乎|像)(?:有着)?(?:千钧之重|万钧之力|无尽的重量|难以名状的)/g, label: '话语沉重句式' },
  { re: /(?:可是|但是|然而)(?:，|,)?(?:下一秒|下一瞬|下一刻|紧接着)/g, label: '但是下一秒句式' },
  { re: /(?:心底|心里|心头)(?:深处|最深处)?(?:某个|一块|一处)的/g, label: '心底某处句式' },
  { re: /(?:莫名的|一种说不清道不明的|难以抑制的|抑制不住的)(?:情绪|感觉|冲动|恐慌|愤怒|悲伤|心慌)/g, label: '莫名情绪句式' },
  { re: /(?:眼中|眼底|眼眸|眸中)(?:忽然|突然|骤然|倏然)?(?:闪|闪过一丝|掠过|泛起|浮现|沉下)/g, label: '眼底闪光句式' },
  { re: /(?:这一瞬|这一刹那|电光火石之间|电光石火间)/g, label: '一瞬之间句式' },
  { re: /(?:仿佛|似乎|好像)(?:在|是)(?:说|诉说着|低语着|喃喃着)/g, label: '仿佛在说句式' },
  { re: /(?:他|她|我)?(?:缓缓|慢慢|一点点|一寸寸)(?:睁开了眼睛|闭上眼睛|睁开眼)/g, label: '缓缓睁眼句式' },
  { re: /(?:那|这)(?:一刻|一瞬).{0,12}(?:注定|改变|扭转|揭开)/g, label: '那一刻注定句式' },
  { re: /(?:一种|一丝|一抹)(?:难以言说|无法言喻|莫名的)的/g, label: '难以言说句式' },
  { re: /(?:嘴角|唇|脸上)(?:带着|挂着|浮现出)(?:一丝|一抹)(?:浅浅的|淡淡地)/g, label: '带着一丝浅笑句式' },
  { re: /(?:深深地|深深)?(?:看了|望了|瞧了)(?:一眼|两眼).{0,6}(?:仿佛|像是)要/g, label: '深深看了一眼句式' }
];

export function scanAiSentenceTemplates(text) {
  const s = String(text || '');
  const hits = [];
  for (const tpl of AI_SENTENCE_TEMPLATES) {
    const m = s.match(tpl.re);
    if (m && m.length) hits.push({ word: tpl.label, count: m.length, template: true });
  }
  return hits;
}

// 段落节奏检测：真人文字段落长短错落；AI 易连续多段同样长度（过短或过匀）
export function scanParagraphRhythm(text) {
  const s = String(text || '');
  // 按空行分段，并剥离纯对话段（对话短段是正常写法）
  const paras = s.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)
    .filter((p) => !/^["""''「『【（][^""""''」』】）]*["""''」』】）]?$/.test(p));
  const hits = [];
  if (paras.length < 5) return hits;
  // 1) 连续 ≥5 段都 < 30 字（鸡零狗碎的碎片化）
  let shortRun = 0;
  for (const p of paras) {
    if (p.length < 30) { shortRun++; if (shortRun >= 5) break; }
    else shortRun = 0;
  }
  if (shortRun >= 5) hits.push({ word: '段落过于碎片化(连续多段<30字)', count: shortRun, template: true });
  // 2) 连续 ≥6 段都 > 150 字（大段压得人喘不过气，AI 长文常见）
  let longRun = 0;
  for (const p of paras) {
    if (p.length > 150) { longRun++; if (longRun >= 6) break; }
    else longRun = 0;
  }
  if (longRun >= 6) hits.push({ word: '段落过长过匀(连续多段>150字)', count: longRun, template: true });
  return hits;
}

// 句首重复检测：AI 极易连续多句以同一词/同一代词开头（"他…他…他…""然后…然后…"）
export function scanSentenceOpeners(text) {
  const s = String(text || '');
  const sentences = stripDialogue(s).split(/[。！？!?；\n]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
  if (sentences.length < 10) return [];
  const hits = [];
  // 连续 ≥5 句以相同 1-2 字开头
  let prevKey = null;
  let run = 0;
  for (const sent of sentences) {
    const key = sent.slice(0, 2);
    if (key === prevKey) { run++; if (run >= 5) break; }
    else { prevKey = key; run = 1; }
  }
  if (run >= 5) hits.push({ word: `句首连续重复（"${prevKey}"开头的句子连了 ${run} 句）`, count: run, template: true });
  // 全章句首同字占比过高：超过 45% 的句子以同一单字开头
  const firstChars = sentences.map((x) => x.slice(0, 1));
  const freq = {};
  for (const c of firstChars) freq[c] = (freq[c] || 0) + 1;
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 8 && top[1] / firstChars.length > 0.45) {
    hits.push({ word: `句首用字单调（"${top[0]}"开头占 ${Math.round((top[1] / firstChars.length) * 100)}%）`, count: top[1], template: true });
  }
  return hits;
}

// 明喻密度检测（AI 最大特征）：AI 爱给每个画面配一个"像/好像/如同/宛如/仿佛…一样/似的"明喻，
// 真人只会在关键处偶尔用。按密度判定——整章明喻超过一定数量即判 AI 味。
// 需排除非明喻的"像"字用法（"像他这样的人""相像""像样""好像=也许"）。
export function scanSimileOveruse(text) {
  const s = String(text || '');
  const hits = [];
  if (s.length < 100) return hits;
  // 抓"像/好像/如同/宛如/仿佛/犹如/好似 + … + 一样/似的/般"的完整明喻结构，以及"像只/像个/像一+量词/名"的短明喻
  const simileRe = /(?:像|好像|如同|宛如|仿佛|犹如|好似)[\u4e00-\u9fff]{0,8}(?:一样|似的|一般|般|那样|那样地)/g;
  const shortSimileRe = /(?:像|宛如|犹如|如同|仿佛)(?:只|个|一|被|是|在|从|把|将|条|根|块|张|片|团|座|头|双|只眼|盏|扇|阵|股|层|面|个)[\u4e00-\u9fff]{0,4}/g;
  // 捕捉"像+定语+名词"式明喻（如"像某种动物的肋骨""像一只睁着的眼睛""像一张揉皱了的纸"），
  // 这些没有"一样/似的"但仍是明喻。前缀词控制避免误伤"相像/好像=也许/象征"。
  const nounSimileRe = /(?:轻?得)?像(?:一只|一个|一?种|一张|一根|一?块|一片|一条|一头|一座|一?双|一?枚|一?捧|一?截|一?团|一?层|一?道|一?缕|一?把|一?阵|一?股|一?个|他|她|它|被|在|有人|某种|什么)[\u4e00-\u9fff]{0,6}(?:的|一样|似的)/g;
  const nounSimile2 = /(?:声音|脸|指|眼|眉|唇|手|背|影|光|色|味|气|泪|汗|血|骨|皮)(?:却)?(?:像|如)[\u4e00-\u9fff]{0,10}/g;
  const long = s.match(simileRe) || [];
  const short = s.match(shortSimileRe) || [];
  const noun = s.match(nounSimileRe) || [];
  const noun2 = s.match(nounSimile2) || [];
  // 合并去重（按起始位置去重，避免同一比喻被两个正则都抓到）
  const seen = new Set();
  const total = [];
  for (const m of [].concat(long, short, noun, noun2)) {
    const idx = s.indexOf(m);
    // 排除否定式"不像/不像是/不似/并非像/不像装的"——"不像=否定"不是明喻
    const before = s.slice(Math.max(0, idx - 2), idx);
    if (/不|非|没|别|未/.test(before)) continue;
    if (idx >= 0 && !seen.has(idx)) { seen.add(idx); total.push(m); }
  }
  if (total.length === 0) return hits;
  const chars = s.replace(/\s/g, '').length;
  const per1k = chars > 0 ? (total.length * 1000) / chars : 0;
  // 阈值：真人偶用几个好比喻也正常（4 处以内），但 AI 腔是"每段一个、总量明显偏多"。
  // 按总量判（≥6 处必是 AI 腔），密度仅作辅助参考，避免误伤少量但精妙的好比喻。
  if (total.length >= 6) {
    const sample = total.slice(0, 5).map((x) => `「${x}」`).join('、');
    hits.push({ word: `明喻过密(全文 ${total.length} 处"像/仿佛…一样/似的"，密度 ${per1k.toFixed(1)}/千字：${sample}…，AI 最大特征，每段一个比喻。真人不这么写，绝大多数画面应白描)`, count: total.length, template: true });
  }
  return hits;
}

// 静态凝视/定格感检测：AI 爱让角色"盯着X看了很久/凝视着X发呆"来假装有戏。
export function scanFrozenGaze(text) {
  const s = String(text || '');
  const hits = [];
  if (s.length < 100) return hits;
  const count = (re) => { const m = s.match(re); return m ? m.length : 0; };
  const gaze = count(/(?:他|她|我|它|对方|那人)(?:直勾勾|怔怔|呆呆)?(?:盯着|凝视着|望着|瞧着|看着|注视着|盯着看)[\u4e00-\u9fff]{0,10}(?:很久|许久|良久|发了呆|出神|了半天|一动不动|没动)/g);
  const wanLe = count(/看了(?:很|许|良)久|盯了(?:很|许|良)久|看了半天|发了半天呆|望着(?:他|她|它)很久|凝视了很久/g);
  const total = gaze + wanLe;
  if (total >= 3) hits.push({ word: `定格凝视滥用(全文 ${total} 处"盯着/凝视…看了很久"，AI 用静态凝视假装有戏，全章至多一次)`, count: total, template: true });
  return hits;
}

// 转折/连接词过密：AI 叙事爱堆"然而/但是/不过/却/忽然/突然/于是/然后"制造转折感
export function scanTransitionOveruse(text) {
  const s = String(text || '');
  const hits = [];
  const count = (re) => {
    const m = s.match(re);
    return m ? m.length : 0;
  };
  const transCount = count(/然而|但是|不过|可是|却|忽然|突然|顿时|于是|随即|紧接着/g);
  if (transCount >= 12) hits.push({ word: `转折连词过密(全文 ${transCount} 处"然而/但是/却/突然"等)`, count: transCount, template: true });
  const soCount = count(/(?:于是|然后|接着|随即|紧接着|便|就)\s*(?:他|她|我|他们|她们|它)/g);
  if (soCount >= 8) hits.push({ word: `"于是/然后+人称"句式过密(${soCount} 处)`, count: soCount, template: true });
  return hits;
}

// 镜头逐一扫描检测：AI 把每个动作的每一帧都拍一遍（"伸出手…够到…端起…送到嘴边"）
export function scanVerboseFrames(text) {
  const s = String(text || '');
  const hits = [];
  // 连续 3+ 个短动作句（每句 <12 字，动词开头），如"他伸出手。够到杯子。端起来。送到嘴边。"
  const sentences = s.split(/[。！？!?；\n]+/).map((x) => x.trim()).filter((x) => x.length >= 2 && x.length < 14);
  if (sentences.length >= 4) {
    let run = 0;
    let bestRun = 0;
    for (const sent of sentences) {
      const isShortAction = /^(?:他|她|我|它|你|对方|那人)?(?:从|把|将|一|就|便|又|顺手|随手)?(?:伸|抬|低|转|站|坐|拿|端|够|放|推|开|关|抓|握|捡|接|递|凑|退|停|回|望|看|瞥|扫|掀|翻|摸|拍|压|拎|背|扛|踢|踩|蹲|跳|扑|冲|点|摆|摇|收|拢|送|喝|吃|咬|咽|指|戳|拔|抽|塞|放|甩|扔|丢|套|穿|解|系|拉|拽|扯|按|捏|掐|挠|擦|拭|盖|掀|敲|叩|踹|蹬|迈|跨|走|跑|退|靠|贴|整|理|侧|偏|垂|仰|低|皱|眯|瞪|眨|拢|含|抿|舔|咽|呼|吸|叹|吐|咳)/.test(sent);
      if (isShortAction) { run++; bestRun = Math.max(bestRun, run); }
      else run = 0;
    }
    if (bestRun >= 4) hits.push({ word: `动作逐帧扫描(连续 ${bestRun} 个短动作句，"伸手-够到-端起"式流水账)`, count: bestRun, template: true });
  }
  // "了"字句尾过载：一页内超过 35% 的句子以"了。"结尾
  const allSents = s.split(/[。！？!?；\n]+/).filter((x) => x.trim().length >= 2);
  if (allSents.length >= 10) {
    const leCount = allSents.filter((x) => /了$/.test(x.trim())).length;
    if (leCount / allSents.length > 0.35) {
      hits.push({ word: `句尾"了"过载(${leCount}/${allSents.length} 句以"了"收尾，流水账感)`, count: leCount, template: true });
    }
  }
  return hits;
}

// 软副词堆砌检测：AI 爱给每个动作都套"缓缓/轻轻/微微/淡淡/悄悄"，真人只在关键处用。
// 密度超过阈值才判定，避免误伤正常使用。
export function scanSoftAdverbOveruse(text) {
  const s = String(text || '');
  const hits = [];
  const countRe = (re) => { const m = s.match(re); return m ? m.length : 0; };
  const wei = countRe(/微微/g);
  const huan = countRe(/缓缓/g);
  const qing = countRe(/轻轻/g);
  const dan = countRe(/淡淡(?:地|的)?/g);
  const qiao = countRe(/悄悄/g);
  const total = wei + huan + qing + dan + qiao;
  if (wei >= 5) hits.push({ word: `"微微"滥用(${wei} 处，AI 最爱用"微微一愣/微微点头/微微勾唇")`, count: wei, template: true });
  if (huan >= 4) hits.push({ word: `"缓缓"滥用(${huan} 处，"缓缓开口/缓缓抬起/缓缓吐出一口气"AI 流水线）`, count: huan, template: true });
  if (qing >= 5) hits.push({ word: `"轻轻"滥用(${qing} 处)`, count: qing, template: true });
  if (dan >= 4) hits.push({ word: `"淡淡"滥用(${dan} 处，"淡淡地说/淡淡地扫了一眼")`, count: dan, template: true });
  if (total >= 12) hits.push({ word: `软副词总量超限(全文 ${total} 处"微微/缓缓/轻轻/淡淡/悄悄"，动作过于"轻拿轻放")`, count: total, template: true });
  return hits;
}

// 抽象情绪量词堆砌：AI 爱把情绪抽象成"一丝/一抹/一股+情绪词"（一丝慌乱、一抹冷笑、一股寒意）。
// 真人更常写具体的身体反应。密度超限即判定。
export function scanAbstractEmotionQuant(text) {
  const s = String(text || '');
  const hits = [];
  const pats = [
    { re: /一(?:丝|抹|缕|股|点|分|层)(?:紧张|慌乱|不安|恐惧|凉意|寒意|杀意|怒意|苦涩|酸楚|惊讶|错愕|尴尬|担忧|心虚|悔意|倦意|疲惫|笑意|讥诮|嘲讽|戏谑|温柔|暖意|窃喜)/g, label: '一丝XX式情绪抽象' },
    { re: /(?:一丝|一抹|一股|一缕)(?:不易察觉|难以掩饰|若有若无|稍纵即逝|转瞬即逝)/g, label: '不易察觉式修饰' }
  ];
  for (const p of pats) {
    const m = s.match(p.re);
    if (m && m.length >= 3) hits.push({ word: `${p.label}堆砌(${m.length} 处，情绪应写成具体身体反应而非抽象量词)`, count: m.length, template: true });
  }
  // "眼里闪过一丝XX"整句式
  const yanse = s.match(/(?:眼(?:中|里|底)|眸(?:中|里|底))闪过.{0,4}(?:一丝|一抹|一道)/g) || [];
  if (yanse.length >= 2) hits.push({ word: `"眼里闪过一丝XX"句式(${yanse.length} 处，AI 高频套路)`, count: yanse.length, template: true });
  return hits;
}

// 排比/对仗堆砌：AI 爱连续三连/四连排比（"不是…而是…""既…又…""没有…也没有…"），
// 一页内出现 3 组以上即判定。
export function scanParallelOveruse(text) {
  const s = String(text || '');
  const hits = [];
  const countRe = (re) => { const m = s.match(re); return m ? m.length : 0; };
  const buShi = countRe(/不是[^。！？]{2,16}[，,]\s*(?:而是|不是)[^。！？]{2,16}(?:[，,]|。)/g);
  const jiYou = countRe(/(?:既|又|也|还|更)[^。！？]{2,10}[，,]\s*(?:又|也|还|更)[^。！？]{2,10}/g);
  const meiYou = countRe(/没有[^。！？]{2,14}[，,]\s*没有[^。！？]{2,14}/g);
  const run = countRe(/似乎[^。！？]{2,12}[，,]\s*(?:似乎|好像)[^。！？]{2,12}/g);
  const total = buShi + jiYou + meiYou + run;
  if (total >= 4) hits.push({ word: `排比对仗堆砌(全文 ${total} 组"不是…而是/既…又…/没有…没有…"，真人不会连用)`, count: total, template: true });
  return hits;
}

// 段落尾"总结句/升华句"：AI 爱在段落或章节末突然拔高（"从这一刻起…""这注定…""仿佛一切都…"）。
export function scanElevationClosers(text) {
  const s = String(text || '');
  const hits = [];
  const pats = [
    { re: /(?:从)?(?:这|那)一刻起[^。！？]{0,20}/g, label: '"从这一刻起"升华' },
    { re: /(?:这|那|此)时[^。！？]{0,6}(?:注定|终将|终于|再也)?[^。！？]{0,4}(?:一切|命运|人生)/g, label: '"此时…一切/命运"拔高' },
    { re: /仿佛(?:整个|一切|整个世界|所有的)[^。！？]{0,16}/g, label: '"仿佛整个世界"式' },
    { re: /(?:他|她|我)?(?:知道|明白)[^。！？]{0,8}(?:再也|终将|终究|迟早)[^。！？]{0,12}/g, label: '"知道…再也/终将"预判' }
  ];
  for (const p of pats) {
    const m = s.match(p.re);
    if (m && m.length >= 2) hits.push({ word: `${p.label}句式(${m.length} 处，段落末/章末不宜拔高总结)`, count: m.length, template: true });
  }
  return hits;
}

// 语气感叹句堆砌：AI 爱用"啊/呀/吧/呢"配合感叹号制造情绪，真人只在真激动处用。
export function scanExclamationFlavor(text) {
  const s = String(text || '');
  const hits = [];
  const countRe = (re) => { const m = s.match(re); return m ? m.length : 0; };
  const excl = countRe(/[^。！？]！/g);
  const softExcl = countRe(/(?:啊|呀|吧|呢|哦|噢)[！!]/g);
  if (excl >= 15) hits.push({ word: `感叹号过密(全文 ${excl} 个"！"，情绪在尖叫不克制)`, count: excl, template: true });
  if (softExcl >= 5) hits.push({ word: `语气词+叹号堆砌(${softExcl} 处"啊!/呀!/吧!"，口语情绪被 AI 加满)`, count: softExcl, template: true });
  return hits;
}

// 叙述句"我看见/他看到/她发现"引导过多：AI 爱用"他看到…""他发现…"把每件事都过一遍眼睛。
export function scanPerceptionLed(text) {
  const s = String(text || '');
  const hits = [];
  const countRe = (re) => { const m = s.match(re); return m ? m.length : 0; };
  const kan = countRe(/(?:他|她|我|它)(?:一?眼)?(?:看到|看见|瞥见|瞧见|望见|发觉|发现)/g);
  if (kan >= 6) hits.push({ word: `"他看到/她发现"引导句过密(${kan} 处，视角透出太多"眼睛")`, count: kan, template: true });
  return hits;
}

// 年代/题材串戏意象检测：AI 生成长篇时易在非古代题材中顽固混入市井古代元素
const TOPIC_DRIFT_WORDS = ['老六', '烟锅', '烟杆', '门槛', '铜钱', '镖局', '镖师', '客栈', '青石板', '扁担', '水缸', '红绳', '布衫', '当铺', '账房', '前清', '抽屉凳', '油灯芯', '纺车', '租子', '佃户'];
// 现代/都市/悬疑/恐怖等题材不应出现这些元素；玄幻/仙侠/都市修仙等题材的"老江湖"意象判断交给 prompt 与人工
const MODERN_GENRES = ['都市', '悬疑', '恐怖', '惊悚', '刑侦', '灵异', '现代', '职场', '科幻', '校园', '网游', '都市异能'];

// 古代/仙侠/玄幻/历史等题材不应混入现代元素（模型无关的题材串戏反向检测）
const ANCIENT_GENRES = ['古代', '古言', '历史', '架空', '宫廷', '宅斗', '权谋', '武侠', '仙侠', '玄幻', '修真', '古风', '王朝', '争霸', '宫斗', '文臣', '将军', '世子', '穿越古代'];
const MODERN_INTRUSION_WORDS = ['手机', '微信', '微博', '电脑', '互联网', '网络', '空调', '电梯', '冰箱', '出租车', '外卖', '快递', '快递员', '便利店', '超市', '地铁', '公交', '扫码', '支付', '支付宝', '微信支付', 'WiFi', 'Wi-Fi', '无线网', '蓝牙', '充电器', '充电宝', '耳机', '蓝牙耳机', '智能', '芯片', '二维码', '朋友圈', '刷视频', '刷剧', '打车', '叫车', '点外卖', '直播间', '弹幕', '网友', '餐厅', '咖啡馆', '办公室', '上班', '老板', '同事', '加班', 'KPI', 'PPT', '会议', '邮件', '邮箱'];

export function scanTopicDrift(text, genre) {
  if (!text) return [];
  const g = String(genre || '');
  const isModern = !g || MODERN_GENRES.some((m) => g.includes(m));
  const isAncient = !!g && ANCIENT_GENRES.some((m) => g.includes(m));
  const hits = [];
  if (isModern) {
    for (const w of TOPIC_DRIFT_WORDS) {
      let count = 0, from = 0;
      while ((from = text.indexOf(w, from)) !== -1) { count++; from += w.length; }
      if (count > 0) hits.push({ word: w, count });
    }
    if (hits.length) {
      hits.push({ word: `跑题：现代题材中混入古代市井元素(${hits.map(h=>h.word).join('、')})`, count: Math.max(...hits.map(h=>h.count)) });
    }
  }
  if (isAncient) {
    for (const w of MODERN_INTRUSION_WORDS) {
      let count = 0, from = 0;
      while ((from = text.indexOf(w, from)) !== -1) { count++; from += w.length; }
      if (count > 0) hits.push({ word: w, count });
    }
    if (hits.length) {
      hits.push({ word: `跑题：古代/仙侠题材中混入现代元素(${hits.map(h=>h.word).join('、')})`, count: Math.max(...hits.map(h=>h.count)) });
    }
  }
  return hits;
}

export function scanAiPatterns(text) {
  if (!text) return [];
  const hits = [];
  const seen = new Set();
  for (const w of AI_BLACKLIST) {
    if (seen.has(w)) continue;
    seen.add(w);
    let count = 0;
    let from = 0;
    while ((from = text.indexOf(w, from)) !== -1) {
      count++;
      from += w.length;
    }
    if (count > 0) hits.push({ word: w, count });
  }
  hits.push(...scanAiPunctuation(text));
  hits.push(...scanAiSentenceTemplates(text));
  hits.push(...scanParagraphRhythm(text));
  hits.push(...scanSentenceOpeners(text));
  hits.push(...scanTransitionOveruse(text));
  hits.push(...scanVerboseFrames(text));
  hits.push(...scanSoftAdverbOveruse(text));
  hits.push(...scanAbstractEmotionQuant(text));
  hits.push(...scanParallelOveruse(text));
  hits.push(...scanElevationClosers(text));
  hits.push(...scanExclamationFlavor(text));
  hits.push(...scanPerceptionLed(text));
  hits.push(...scanSimileOveruse(text));
  hits.push(...scanFrozenGaze(text));
  hits.push(...scanDialogueEllipsis(text));
  hits.push(...scanQuantifierStack(text));
  hits.push(...scanNearbyRepeat(text));
  hits.push(...scanClauseMonotony(text));
  hits.push(...scanAdverbStack(text));
  hits.push(...scanEmptyAdjective(text));
  // 段落碎片化检测：一段文字超过 5 个段落且平均每段 < 50 字，判定为碎片化
  // 剥离对话段（对话短段是正常写法），只统计叙述段
  const allParas = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const narrParas = allParas.filter((p) => !/^["""''「『【（][^""""''」』】）]*["""''」』】）]?$/.test(p));
  if (narrParas.length >= 6) {
    const avgLen = narrParas.reduce((s, p) => s + p.length, 0) / narrParas.length;
    if (avgLen < 40) {
      hits.push({ word: `段落碎片化(叙述段平均每段${Math.round(avgLen)}字，共${narrParas.length}段，应合并短段)`, count: Math.round(50 / avgLen) });
    }
  }
  return hits.sort((a, b) => b.count - a.count);
}

// 对话省略号占比检测：AI 让角色每两句对话就塞一个"……"表示欲言又止/沉默，真人只在关键处用。
// 按对话中含省略号的比例判定（≥35% 对话带省略号即 AI 腔）。
export function scanDialogueEllipsis(text) {
  const s = String(text || '');
  const hits = [];
  const dialogues = s.match(/["""''「『【（][^""""''」』】）]{1,80}["""''」』】）]/g) || [];
  if (dialogues.length < 6) return hits;
  let withEll = 0;
  for (const d of dialogues) if (d.includes('…') || d.includes('...')) withEll++;
  const ratio = withEll / dialogues.length;
  if (ratio >= 0.35) {
    hits.push({ word: `对话省略号过密(${withEll}/${dialogues.length} 句对话带"……"(${Math.round(ratio * 100)}%)，AI 让角色频繁用省略号表示欲言又止/沉默，真人只在关键处用。删去大部分省略号，让停顿由内容和场景带出)`, count: withEll, template: true });
  }
  return hits;
}

// 句式单调检测：连续多句使用相同句式结构（如"他X了，他Y了，他Z了"），AI 标志性写法
export function scanClauseMonotony(text) {
  const s = String(text || '');
  if (s.length < 1000) return [];
  const hits = [];
  const sentences = s.split(/[。！？\n]+/).map(x => x.trim()).filter(x => x.length > 3);
  if (sentences.length < 6) return hits;
  // 检测"X了Y了Z了"句式
  let lianxuLe = 0;
  for (const sent of sentences) {
    const leCount = (sent.match(/了/g) || []).length;
    if (leCount >= 3 && sent.length / leCount < 8) lianxuLe++;
  }
  if (lianxuLe >= 4) {
    hits.push({ word: `句式单调("…了…了…了"连续${lianxuLe}句，AI 标志性句式重复，真人句式长短错落)`, count: lianxuLe, template: true });
  }
  // 检测"他/她+动词"连续开头
  let sameStart = 1, bestStart = 1;
  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1].slice(0, 2);
    const curr = sentences[i].slice(0, 2);
    if (prev === curr && /^[他她它那这]/.test(prev)) {
      sameStart++;
      bestStart = Math.max(bestStart, sameStart);
    } else {
      sameStart = 1;
    }
  }
  if (bestStart >= 5) {
    hits.push({ word: `句式单调(连续${bestStart}句以相同字开头，AI 标志性句式重复，真人句式多样)`, count: bestStart, template: true });
  }
  return hits;
}

// 副词堆叠检测：AI 爱用"非常/十分/特别/极其/异常/相当"等程度副词堆砌，真人用得更少
export function scanAdverbStack(text) {
  const s = String(text || '');
  if (s.length < 1500) return [];
  const hits = [];
  const adverbs = ['非常', '十分', '特别', '极其', '异常', '相当', '格外', '越发', '更加', '最为', '极度', '超', '太', '很'];
  let total = 0;
  const parts = [];
  for (const adv of adverbs) {
    let count = 0;
    let from = 0;
    while ((from = s.indexOf(adv, from)) !== -1) { count++; from += adv.length; }
    if (count >= 3) { total += count; parts.push(`${adv}×${count}`); }
  }
  const perK = (total / s.length) * 1000;
  if (total >= 10 && perK > 4) {
    hits.push({ word: `程度副词堆砌(${parts.join('、')}，每千字${perK.toFixed(1)}处；AI 爱用程度副词堆砌，真人用词更克制。删去大半，只留关键处)`, count: total, template: true });
  }
  return hits;
}

// 空泛形容词检测：AI 爱写"深邃的目光""沉重的步伐""温暖的笑容"等空套搭配
export function scanEmptyAdjective(text) {
  const s = String(text || '');
  if (s.length < 1000) return [];
  const hits = [];
  const emptyPairs = [
    /深邃的?(目光|眼神|眼眸|眼睛)/, /沉重的?(步伐|脚步|心情|叹気)/,
    /温暖的?(笑容|阳光|怀抱|目光|话语)/, /冰冷的?(目光|语气|空气|手指)/,
    /锐利的?(目光|眼神|视线)/, /迷茫的?(目光|眼神|表情)/,
    /沧桑的?(面容|脸庞|眼神|背影)/, /瘦削的?(身影|脸庞|肩膀)/,
    /高大?的?(身影|背影|男人|身躯)/, /柔软的?(长发|发丝|身体)/,
    /明亮?的?(眼睛|目光|眼眸)/, /颤抖的?(声音|手指|身体|肩膀)/,
    /沙哑的?(声音|嗓音|语气)/, /低沉的?(声音|嗓音|语气)/,
    /急促的?(呼吸|脚步|心跳)/, /缓慢的?(步伐|动作|转身)/,
    /轻轻?地?(叹|笑|说|摇头|点头|抚摸|推开|关上|放下)/,
    /默默?地?(注视|看着|走|站|坐|流泪|承受|付出)/
  ];
  let total = 0;
  const samples = [];
  for (const re of emptyPairs) {
    const m = s.match(re);
    if (m) {
      total++;
      if (samples.length < 3) samples.push(m[0]);
    }
  }
  if (total >= 4) {
    hits.push({ word: `空泛形容词堆砌(套用"${samples.join('"、"')}…"等AI高频搭配共${total}种；真人描写更具体更个人化，不依赖这些空套搭配。替换为具体细节描写)`, count: total, template: true });
  }
  return hits;
}

// 模糊量词「一X」堆叠检测：一丝/一抹/一股/一阵/一缕 是 AI 垫描写的标志性拐杖，
// 真人也用但密度远低。整章密度超过每千字 3.5 处且总量足够大时判 AI 腔。
const QUANTIFIER_WORDS = ['一丝', '一抹', '一股', '一阵', '一缕', '一丝丝', '一缕缕'];

export function scanQuantifierStack(text) {
  const s = String(text || '');
  if (s.length < 1000) return [];
  let total = 0;
  const parts = [];
  for (const w of QUANTIFIER_WORDS) {
    let count = 0;
    let from = 0;
    while ((from = s.indexOf(w, from)) !== -1) { count++; from += w.length; }
    if (count > 0) { total += count; parts.push(`${w}×${count}`); }
  }
  const hits = [];
  const perK = (total / s.length) * 1000;
  if (total >= 8 && perK > 3.5) {
    hits.push({
      word: `模糊量词堆叠(${parts.join('、')}，共 ${total} 处，每千字 ${perK.toFixed(1)} 处；AI 爱用「一丝/一抹/一股」垫描写，真人密度远低。删掉大半，只留最有效的一两处，其余直接白描)`,
      count: total,
      template: true
    });
  }
  return hits;
}

// 近距离重复用词检测：同一双字词在 300 字窗口内出现 ≥4 次属机械复现（真人会换词或删减）。
// 全章出现超 15 次的词大概率是主角名等专名，自动排除；常见功能词走停用表。
const NEARBY_STOPWORDS = new Set([
  '他们', '她们', '自己', '什么', '没有', '一个', '这个', '那个', '已经', '就是',
  '还是', '知道', '时候', '东西', '起来', '出来', '过来', '一下', '有些', '一点',
  '这样', '那样', '这么', '那么', '现在', '地方', '身体', '声音', '眼睛', '看着',
  '说道', '的话', '一声', '也不', '也是', '都是', '只是', '但是', '如果', '因为',
  '所以', '不过', '似乎', '像是', '好像', '然后', '突然', '顿时', '终于', '竟然',
  '居然', '真的', '开始', '继续', '直接', '慢慢', '轻轻', '缓缓', '进来', '出去',
  '回去', '下来', '上来', '所有', '每次', '有时', '两个', '三个', '第一', '他的',
  '她的', '我的', '自己', '一是', '不能', '不会', '不是', '不知', '就是', '一人'
]);

export function scanNearbyRepeat(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (s.length < 1500) return [];
  const hits = [];
  const reported = new Set();
  const globalFreq = new Map();
  const WINDOW = 300;
  const STEP = 150;
  for (let start = 0; start + WINDOW <= s.length; start += STEP) {
    const win = s.slice(start, start + WINDOW);
    const local = new Map();
    for (let i = 0; i + 2 <= win.length; i++) {
      const g = win.slice(i, i + 2);
      local.set(g, (local.get(g) || 0) + 1);
    }
    for (const [g, c] of local) {
      if (c < 4 || reported.has(g) || NEARBY_STOPWORDS.has(g)) continue;
      if (!globalFreq.has(g)) {
        let gf = 0;
        let from = 0;
        while ((from = s.indexOf(g, from)) !== -1) { gf++; from += g.length; }
        globalFreq.set(g, gf);
      }
      if (globalFreq.get(g) > 15) continue; // 全章高频词大概率是主角名等专名
      reported.add(g);
      hits.push({
        word: `近距离重复用词("${g}"在相邻 300 字内出现 ${c} 次；同词近距离高频复现是 AI 机械感来源，真人会换近义表达或删减。替换其中两处或直接删一处)`,
        count: c,
        template: true
      });
    }
  }
  return hits;
}

// 剥离引号内对话内容，避免"对话短句/短段"干扰短句切割与碎片化检测（对话短句是正常写作）
function stripDialogue(text) {
  return String(text || '').replace(/["""''「『【（][^""""''」』】）]*["""''」』】）]/g, '');
}

// 对白/叙述结构失衡检测：全章零对话=流水账旁白体，全章近乎全对话=剧本化。
// 正常章节对白与叙述交织，两类失衡都显著降低可读性。返回人类可读的问题描述数组，供润色定向修复。
export function scanStructureBalance(text) {
  const s = String(text || '');
  const issues = [];
  if (s.length < 1200) return issues;
  // 引号集覆盖中文弯引号与英文直引号，兼容不同模型的输出习惯
  const dialogues = s.match(/["""“”''‘’「『][^""""“”''‘’」』]{1,200}["""“”''‘’」』]/g) || [];
  const dialogueChars = dialogues.reduce((sum, d) => sum + d.length, 0);
  const plainLen = s.replace(/\s/g, '').length;
  if (dialogues.length === 0 || dialogueChars < 60) {
    issues.push('全章几乎无人物对话（通篇旁白叙述），像剧情梗概而非小说——至少安排两三处角色开口的对话场面，用台词交锋推进信息与冲突');
  } else if (plainLen > 0 && dialogueChars / plainLen > 0.85) {
    issues.push('全章几乎全是对话（剧本化），缺少动作、环境、心理等叙述层描写——压缩对话量或穿插行为细节，让文字有画面');
  }
  return issues;
}

// 跨章口癖固化检测：长篇连载最隐蔽的 AI 破绽是"每章同款小动作/小表情"——
// 单章内看每处都正常，跨章看就是"主角每一章都要挑眉一次、勾一次嘴角"。
// 提取本章高频四字汉字片段，检查其在最近数章是否同样高频复现；命中说明该写法已固化成模板，需替换为多样的表达。
export function scanCrossChapterRepeats(current, priorTexts, { minCurrent = 3, minPriorTotal = 4, minChapters = 2 } = {}) {
  const cur = String(current || '').replace(/[^\u4e00-\u9fff]/g, '');
  if (cur.length < 800) return [];
  const priors = (Array.isArray(priorTexts) ? priorTexts : [priorTexts])
    .map((t) => String(t || '').replace(/[^\u4e00-\u9fff]/g, ''))
    .filter((t) => t.length >= 500);
  if (!priors.length) return [];

  const counts = new Map();
  for (let i = 0; i + 4 <= cur.length; i++) {
    const g = cur.slice(i, i + 4);
    counts.set(g, (counts.get(g) || 0) + 1);
  }

  // 功能搭配过滤：高频虚词组合是自然语言现象，不构成口癖
  const functionalHead = /^(一个|是的|没有|什么|自己|这个|那个|就是|还是|但是|所以|因为|时候|知道|觉得|已经|可能|一样|似的|于是|然后|这样|那样|起来|下去|过来|出来|地上|人的|的时候)/;
  const tailStop = /[的了着是在和与就把被很也又都再还便才向从对着说地得个这那他她它你我不没]/;

  const results = [];
  for (const [gram, cnt] of counts) {
    if (cnt < minCurrent) continue;
    // 短语必须是连续实义片段：尾部含停用字时去掉尾字仍成立才更稳；此处简单要求四个字里最多一个虚词
    let stopCount = 0;
    for (const ch of gram) if (tailStop.test(ch)) stopCount++;
    if (stopCount >= 2 || functionalHead.test(gram)) continue;

    let total = 0, chapters = 0;
    for (const p of priors) {
      let c = 0, from = 0;
      while ((from = p.indexOf(gram, from)) !== -1) { c++; from += gram.length; }
      if (c > 0) chapters++;
      total += c;
    }
    const needTotal = priors.length >= minChapters ? minPriorTotal : minPriorTotal - 1;
    const needChapters = Math.min(minChapters, priors.length);
    if (total >= needTotal && chapters >= needChapters) {
      results.push({ phrase: gram, current: cnt, priorTotal: total, chapters });
    }
  }
  results.sort((a, b) => (b.chapters * b.priorTotal) - (a.chapters * a.priorTotal));
  // 去重：4 字滑窗会把同一个固化长短语切成多个重叠片段（"说话时指""话时指节""指节泛白"），
  // 共享任一 3 连字即视为同一来源，只保留频次最高的代表
  const tri = (g) => new Set([0, 1].map((i) => g.slice(i, i + 3)));
  const kept = [];
  for (const r of results) {
    const ks = tri(r.phrase);
    if (kept.some((k) => [...tri(k.phrase)].some((t) => ks.has(t)))) continue;
    kept.push(r);
    if (kept.length >= 5) break;
  }
  return kept.map((r) =>
    `"${r.phrase}"在本章出现 ${r.current} 次、近几章共出现 ${r.priorTotal} 次（${r.chapters} 章）——写法已固化成模板，请把重复处换成不同角度的动作/神态/表达`
  );
}

// 跨章自我复述检测：求两段文本的最长公共子串长度（滚动数组 DP，内存 O(m)，时间 O(n*m)）
// 用于发现"本章大段重写上一章已发生的内容"。正常承接最多复述结尾一两句，≥100 连续字基本必是复述。
export function longestDuplicateLength(a, b) {
  const aa = String(a || '').replace(/\s+/g, '');
  const bb = String(b || '').replace(/\s+/g, '');
  const n = aa.length, m = bb.length;
  if (!n || !m) return 0;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(0);
    const ai = aa[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === bb[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return best;
}

// 时间线自洽检测：文中出现的具体时刻按叙述顺序必须递进。
// 若后文出现的时刻早于前文（如先写"凌晨三点"守夜、后写"凌晨两点四十七分"死亡），
// 且两处之间没有"前一天/回忆/当时/想起/与此同时"等回溯或并行标记，即判定时间倒置。
// 这是 LLM 生成最容易犯、读者一眼看穿的硬伤，纯正则即可拦截。支持汉字与阿拉伯数字。
export function scanTimelineContradiction(text) {
  const s = String(text || '');
  if (s.length < 200) return [];
  const D = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '半': 30 };
  // 汉字/阿拉伯数字互转：小时 1-12（一~十二），分钟 0-59（含"四十七""五十""十五"等）
  const parseNum = (str) => {
    if (!str) return NaN;
    if (/^\d+$/.test(str)) return Number(str);
    const m = str.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? D[m[1]] * 10 : 10) + (m[2] ? D[m[2]] : 0);
    return D[str] !== undefined ? D[str] : NaN;
  };
  // 捕获 (前缀)(N)点(M分)，前缀决定半日区间；不同前缀之间不做比较（保守防误报）
  const timeRe = /(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*[点时:：]\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})?\s*分?/g;
  const PREFIX = { '凌晨': 0, '清晨': 0, '早上': 0, '上午': 0, '中午': 1, '下午': 1, '傍晚': 1, '晚上': 1, '夜里': 1, '深夜': 1 };
  const marks = [];
  for (const m of s.matchAll(timeRe)) {
    const hour = parseNum(m[2]);
    const minute = parseNum(m[3] || '') || 0;
    if (!Number.isFinite(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
    // 排除非时刻上下文（"三个月""四点起床的班"这类误匹配）
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    if (/个月|年头|岁|年代|号|日|周|星期|点钟的/.test(before)) continue;
    marks.push({ half: PREFIX[m[1]] ?? null, minutes: hour * 60 + minute, index: m.index, label: m[0].trim() });
  }
  // 两时刻之间的文本若有回溯/并行/预约标记，则这对比较无效
  const flashbackRe = /(前一天|前一晚|头一天|昨晚|昨日|昨天|那天|当日|当时|想起|记得|回忆|曾经|以前|此前|与此同时|另一边|镜头一转|这时|此刻|约的?是|说好|订的?是|提前|一晃|过了.{0,6}(天|年|月)|第二天|翌日|次[日晨])/;
  const issues = [];
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < Math.min(marks.length, i + 6); j++) {
      const a = marks[i], b = marks[j];
      // 只比较同为无前缀或同半日区间（凌晨对凌晨、晚上对晚上）；跨区间保守跳过
      if (a.half !== b.half) continue;
      const diff = a.minutes - b.minutes; // >0 表示后文时刻更早 = 倒流
      if (diff < 10) continue; // <10 分钟的微小抖动放过
      const between = s.slice(a.index + a.label.length, b.index);
      if (flashbackRe.test(between)) continue;
      // 场景跳切（空行 + 新场景）也可能合法回拨时间；两处相隔超过 800 字保守放过
      if (b.index - a.index > 800) continue;
      issues.push(`时间倒置：先写"${a.label}"，后文又出现更早的"${b.label}"（早了约${diff}分钟），中间没有任何回忆/前一天/并行场景等回溯标记——后文时刻应晚于前文，或补上明确的时间回溯交代`);
      break;
    }
    if (issues.length >= 3) break;
  }
  return issues;
}

// 称呼与身份一致性检测：叫"爹/娘/爷/奶"等亲属称谓的角色，介绍语必须与称谓相称。
// 如"老爹已经把灵台撤了。……他是爷爷的老伙计，在铺子里帮了几十年忙"——称呼是父亲、
// 介绍是雇员，读者立刻会问"这到底是他爹还是伙计"。收养/义亲（继/养/干/义/过继/入赘）除外。
// 称呼与身份介绍常分属前后两句，故按段落内 160 字窗口检测，而非单句内共现。
export function scanKinshipTitleConflict(text) {
  const s = String(text || '');
  if (s.length < 300) return [];
  const issues = [];
  const kinRe = /(老爹|老爸|老娘|老妈|我爹|我娘|他爹|她爹|他娘|她娘|我父亲|我母亲|他父亲|她母亲|亲爹|亲娘|生父|生母|父亲大人|娘亲|我爸|我妈|他爸|他妈|她爸|她妈)/;
  const outsiderRe = /(老伙计|的伙计|帮工|雇[员工]|学徒|打工|做工|做事的|手下|部下|店里人手|老搭档|老相识)/;
  const guardRe = /(继父|继母|养父|养母|干爹|干娘|义父|义母|过继|入赘|拜把|认的|名义上|前夫|前妻|岳父|岳母|公公|婆婆|师傅|师徒|收养|认作|当年|那时候|年轻时|以前在|早年间)/;
  for (const para of s.split(/\n+/)) {
    let searchFrom = 0;
    while (searchFrom < para.length) {
      const kinMatch = para.slice(searchFrom).match(kinRe);
      if (!kinMatch) break;
      const kinIdx = searchFrom + kinMatch.index;
      // 称呼之后 160 字窗口（跨句）内查外人身份词；窗口内出现收养/义亲/时间缓冲词则跳过
      const window = para.slice(kinIdx, kinIdx + 160);
      const outsiderMatch = window.match(outsiderRe);
      if (outsiderMatch && !guardRe.test(window)) {
        issues.push(`称呼与身份矛盾："${kinMatch[0]}"是亲属称谓，但其后介绍出现"${outsiderMatch[0]}"（外人/雇员身份），两者冲突——请统一该人物的称呼与身份（若是亲缘就改为继承/跟随一辈子的表述；若是伙计就改用姓名或"陈叔/福伯"式称呼）`);
        if (issues.length >= 3) return issues;
      }
      searchFrom = kinIdx + kinMatch[0].length;
    }
  }
  return issues;
}

// 场景元素错位检测：A 场景出现 B 场景专属元素（如殡仪馆走廊里出现监护仪、病房里出现纸扎）。
// 常见错位对：医院元素 vs 殡仪/法事元素；现代元素 vs 古代元素（后者已由世界观锚定覆盖，此处防场景级混搭）。
export function scanSceneElementMismatch(text) {
  const s = String(text || '');
  if (s.length < 300) return [];
  const issues = [];
  const pairs = [
    {
      scene: /(殡仪馆|灵堂|告别室|守灵|灵棚|挽联|寿衣店|纸扎铺|太平间|停尸房|火化炉|焚化炉)/,
      alien: /(监护仪|心电图|点滴|输液管|住院部|查房|值班医生|门诊|挂号|手术台|无影灯|病床|查体|听诊器|护士站|急诊)/,
      bridge: /(从医院|从病房|医院运来|转到|送来|抬来|回忆|想起|生前|住院那会儿|当时|昨天|前一天|救护车|运到|遗体|太平间|曾经|之前|以前|那时|转运|运送|拉来|接来)/,
      sceneName: '殡仪/丧仪场景', alienName: '医院元素'
    },
    {
      scene: /(病房|住院|门诊|点滴|急诊|手术|ICU|重症监护|病危|病重)/,
      alien: /(纸扎|寿衣|挽联|花圈|骨灰|灵位|道场|超度|经幡|灵堂|守灵|出殡|下葬|火化)/,
      bridge: /(回忆|想起|生前|母亲|父亲|爷爷|奶奶|去世|老人提起|柜里|库房|旁边|隔壁|楼下|陪护|带来的|去世前|临终|遗嘱|告别|最后|最后时光|以前|从前|过去)/,
      sceneName: '医院场景', alienName: '丧仪元素'
    }
  ];
  for (const p of pairs) {
    if (p.scene.test(s) && p.alien.test(s) && !p.bridge.test(s)) {
      const alienHit = s.match(p.alien);
      issues.push(`场景元素错位：本章存在${p.sceneName}，却出现${p.alienName}（"${alienHit[0]}"），且没有转运/回忆/并存合理性交代——请确认场景设定，把不属于该场景的元素替换或补上合理来由`);
      if (issues.length >= 3) break;
    }
  }
  return issues;
}

// AI 特征标点硬扫描：省略号堆叠、叹号连用、波浪号、半角句号混入全角
export function scanAiPunctuation(text) {
  const s = String(text || '');
  const hits = [];
  // 连续省略号堆叠：同一处出现 ≥2 个 …… 或 4 个以上连续点
  const ellipsis = s.match(/(?:……){2,}/g) || s.match(/(?:\.\.\.){2,}/g) || [];
  if (ellipsis.length) hits.push({ word: '省略号堆叠(……) ', count: ellipsis.length });
  // 感叹号连用（含半角）
  const exclaim = s.match(/[!！]{2,}/g) || [];
  if (exclaim.length) hits.push({ word: '感叹号连用(!!)', count: exclaim.length });
  // 波浪号冒充标点
  const wave = s.match(/[~～]{1,}/g) || [];
  if (wave.length) hits.push({ word: '波浪号(～)', count: wave.length });
  // 全角文本中夹杂半角句末标点（如句号用. 逗号用, 未被 .net 误判）
  const half = s.match(/[\u4e00-\u9fff][,.!?][\u4e00-\u9fff]/g) || [];
  if (half.length) hits.push({ word: '半角标点混入', count: half.length });
  // 句号过度切割短句（网文标点规范硬检测）：连续 ≥3 句超短句（<8字）都落在<10字的片段内
  // 先剥离引号对话，对话短句（"好。""嗯。""走吧。"）是正常写法，不算碎片
  const sentLike = stripDialogue(s).split(/[。！？!?\n]+/).map((x) => x.trim()).filter((x) => x.length > 2);
  let shortRun = 0;
  let startIdx = -1;
  let bestStart = -1;
  let bestRun = 0;
  for (let i = 0; i < sentLike.length; i++) {
    const short = sentLike[i].length <= 8;
    if (short) {
      if (shortRun === 0) startIdx = i;
      shortRun++;
      if (shortRun > bestRun) { bestRun = shortRun; bestStart = startIdx; }
    } else {
      shortRun = 0;
    }
  }
  if (bestRun >= 3) {
    const sample = sentLike.slice(bestStart, bestStart + Math.min(bestRun, 5)).join('。');
    hits.push({ word: `句号过度切割短句(连续${bestRun}个超短句"${sample}…"，应改用逗号衔接)`, count: bestRun });
  }
  // 分号滥用：中文小说中分号密度过高（AI 爱用分号强行排列表象）
  const sc = s.match(/；/g) || [];
  if (sc.length >= 6) hits.push({ word: `分号滥用(全文${sc.length}处分号，应优先改用逗号)`, count: sc.length });
  // 破折号过密：AI 爱用"——"作吊味/连接手段，真人只在解释或强调处偶尔用。
  // 按密度判定：约每 400 字超 2 处即偏多；2000 字超过 6 处、或任何长度下破折号 ≥8 处即判滥用。
  const dash = s.match(/——/g) || [];
  if (dash.length >= 8 || (dash.length >= 6 && s.length > 0 && dash.length / (s.length / 400) > 1.5)) {
    hits.push({ word: `破折号过密(全文${dash.length}处"——"，应改为逗号/句号或直接删除，只在对话停顿或解释处偶尔使用)`, count: dash.length });
  }
  // 省略号总密度过高：AI 爱用"……"吊味/故作停顿，真人只在欲言又止、沉默、思绪中断时偶尔用。
  // 省略号密度超 10 处/千字（约每 100 字一个省略号）即明显过量。
  const ellipsisAll = s.match(/…/g) || [];
  if (ellipsisAll.length >= 8 && s.length > 0 && ellipsisAll.length / (s.length / 1000) > 10) {
    hits.push({ word: `省略号过密(全文${ellipsisAll.length}个"…"(${Math.round((ellipsisAll.length / (s.length / 1000)))}/千字)，AI 用省略号吊味/故作停顿，真人在欲言又止、沉默时偶尔用。删去大部分，让停顿由对话内容和场景自然带出)`, count: ellipsisAll.length });
  }
  return hits;
}

// 生成后代码级去 AI 味：只做"绝对安全的规则化修正"，不改写语义。
// 供章节生成/润色/改编在落库前调用，作为 prompt 质量门之外的第三层防线。
export function cleanAiText(text) {
  let s = String(text || '');
  if (!s) return s;
  // 1) 英文标点一律转全角（仅处理中文相邻的半角标点，保留句子中真正的英文内容）
  s = s
    .replace(/([\u4e00-\u9fff\u3000-\u303f])[ \t]*,[ \t]*(?=[\u4e00-\u9fff\u201c\u2018])/g, '$1，')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])[ \t]*;[ \t]*(?=[\u4e00-\u9fff])/g, '$1；')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])[ \t]*:[ \t]*(?=[\u4e00-\u9fff\u201c\u2018])/g, '$1：')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])[ \t]*![ \t]*/g, '$1！')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])[ \t]*\?[ \t]*/g, '$1？')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])[ \t]*\.[ \t]*(?=[\u4e00-\u9fff\u201c\u2018])/g, '$1。')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])\.(?![.\w])/g, '$1。');
  // 2) 省略号归一：连续点号 → "……"，连续双省略号合并
  s = s.replace(/[.．.]{6,}/g, '……').replace(/……{2,}/g, '……').replace(/…{2}/g, '……');
  // 3) 感叹号连用压缩为单个
  s = s.replace(/[!！]{2,}/g, '！');
  // 4) 折叠连续空行（>=2 个换行 → 单个），删除行尾空白
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  // 5) 相邻重复字清理（AI 偶发的"他他""了了""的的"类误输入，只在紧跟中文后续或标点时收拢，避免误伤拟声字如"嘿嘿""哈哈"）
  s = s.replace(/(他|她|它|你|我|这|那|了|的|在|是|与|和|个)(\1)(?=[\u4e00-\u9fff，。！？；：""''、])/g, '$1');
  // 5b) 相邻重复短语清理（AI 偶发"画面上他自己画面上他自己"类整段重复）：
  //    相邻两段 ≥3 字完全相同的内容合并为一段。只做字符串重复折叠，避免误伤故意重复（口头禅）。
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/([\u4e00-\u9fff]{3,12})(\1)/g, '$1');
    if (s === before) break;
  }
  // 6) 中文与中文之间多余空格（全角文本中夹杂半角空格）
  s = s.replace(/([\u4e00-\u9fff])[ ]+([\u4e00-\u9fff])/g, '$1$2');
  // 7) 网文标点强制规范（保守规则化）：把"动作短句。"后紧跟的"身体部位/状态动词碎片"断开处改为逗号衔接
  //    高置信模式：句号前是 ≤7 字的动作分句，句号后紧跟"目光/眼神/嘴角/语气/声音/心里/脑中/脚步/手上/眼里/头顶/肩头/指节"等身体部位短语
  //    或"他/她+叹/笑/咳/笑了一声"等状态补充。只处理这种明确属于同一连续叙事的，避免误伤真正的句号收束。
  s = s.replace(/([\u4e00-\u9fff]{2,7})。((?:目光|眼神|嘴角|语气|声音|心里|脑中|脑子|脚步|手上|眼里|头顶|肩头|指节|心头|胸中|脸上|眉间|喉咙|指尖|后背|腰上|脚下|身侧|心口|眼前|脑海)[\u4e00-\u9fff]{0,4})/g, '$1，$2');
  // 8) 破折号过度清洗：AI 爱用"——"连接不相关分句。保留对话内说明性破折号，
  //    但正文中连续多处"X——Y"且 Y 是独立成句的，改回逗号/句号。保守处理：把"——"后紧跟陈述句的改为"，"
  s = s
    .replace(/——\s*(?=(?:这|那|他|她|它|我|你|只|就|便|却|而|但|可|因|所以|于是|不过|然后|接着|突然|忽然|终于|毕竟|其实|当然|这时|此刻|当下|原来|原来如此|整间|整个|铺里|屋里|房里|店里|门外|窗外|身后|身前|脚下|头顶|眼前|屋里|店里|街|巷|房间|屋子)[\u4e00-\u9fff]{2,})/g, '，')
    .replace(/——{2,}/g, '——');
  // 9) 段落碎片合并：连续 2 段以上每段 ≤ 50 字且无对话的短描写段，合并为一段
  const paras = s.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
  if (paras.length >= 4) {
    const merged = [];
    let buf = [];
    const flushBuf = () => { if (buf.length >= 2) merged.push(buf.join('')); else merged.push(...buf); buf = []; };
    for (const p of paras) {
      const isShort = p.length <= 40 && !p.includes('"') && !p.includes('"') && !p.match(/^[「『【（]/);
      const isDialogue = p.match(/^[""「『""].*[""」』""]$/);
      if (isShort && !isDialogue) { buf.push(p); }
      else { flushBuf(); merged.push(p); }
    }
    flushBuf();
    s = merged.join('\n');
  }
  // 10) 同一主语的连续动作句句号改逗号：如"他揉了下眼角。左手按住耳机。"→"他揉了下眼角，左手按住耳机。"
  s = s.replace(/(他|她|我|它|你)([\u4e00-\u9fff]{1,6}[了着])。(\1(?:[\u4e00-\u9fff]{1,4}[了着])?[\u4e00-\u9fff]{0,6})/g, '$1$2，$3');
  // 11) AI 排比句式清理："光秃秃的墙，光秃秃的地砖"→"墙和地砖都光秃秃的"
  s = s.replace(/([\u4e00-\u9fff]{1,4})的([\u4e00-\u9fff]{1,4})，\1的([\u4e00-\u9fff]{1,4})/g, '$2和$3都$1的');
  // 12) "嘴角勾起一抹X"式脸谱化表情精简：AI 高频"嘴角勾起一抹(冷笑/弧度/笑意/浅笑)"，
  //     真人几乎不用。去掉冗余的"勾起一抹"→"嘴角（有）一丝X"。保守：仅当"勾起一抹X"后紧跟"说/道/笑/看"等动作或句尾时。
  s = s.replace(/(嘴角|唇边|嘴边)(?:微微)?(?:勾起|扬起)(?:了)?(?:一抹|一丝)(冷笑|浅笑|笑意|弧度|冷笑|嘲讽|讥诮|玩味|自嘲)/g, '$1带着一丝$2');
  // 13) "缓缓/微微/轻轻"三连叠（同一句内堆叠两个软副词，如"缓缓地微微点了点头"），去重为一个
  s = s.replace(/(缓缓|微微|轻轻|悄悄|淡淡)(?:地|的)?(?:，|,)?(?:\s*)(?:缓缓|微微|轻轻|悄悄|淡淡)(?:地|的)?/g, '$1地');
  // 14) 冗余"时间仿佛静止/空气仿佛凝固"整句式：中文叙事里这种"定格感"描写过度，真人只在关键处。
  //     保守处理：仅压缩连续两处同类定格（"……。空气仿佛凝固了。……空气仿佛凝固了。"→保留一处），不做删改。
  s = s.replace(/((?:空气|时间|气氛|场面)[^。！？]{0,8}?(?:仿佛|似乎|好像)?(?:凝固|静止|定格|停滞)(?:了|下来)?[。！？])([\s\S]{0,120}?\1)/g, '$1');
  // 15) 连续"深吸一口气"/"呼出一口气"（一页内多次深呼吸是 AI 紧张戏模板），把重复的第二处及以后改为轻量动作提示不删语义
  //     保守：仅当同一句内连续出现两次（"深吸一口气，又深吸一口气"）时合并。
  s = s.replace(/(深吸一口气|呼出一口气|轻叹一声|长叹一口气)[，,]?(?:又|再次)?(?:\s*)(\1)/g, '$1');
  return s;
}

// 质量门判定：黑名单"高频复用"才判 AI 味、需要再润色；偶尔用一次属于正常写作。
// 规则（配合章节字数做密度归一，避免长章节误伤短章节）：
//  - 2 字短词（如"仿佛""眸子"）：出现 ≥2 次且密度 ≥2 次/千字 才判高频
//  - 3 字及以上短语（如"深吸一口气""嘴角勾起"）：复用感极强，出现 ≥2 次即判高频
export function blacklistFlagWords(hits, textLen = 0) {
  return (hits || []).filter((h) => {
    if (h.count < 2) return false;
    if (String(h.word).length <= 2) {
      const density = textLen > 0 ? (h.count * 1000) / textLen : h.count;
      return density >= 2;
    }
    return true;
  }).map((h) => h.word);
}

// 惩罚分只对"高频复用"的词计分；偶尔出现的修饰词不加罚
export function blacklistPenalty(hits, textLen = 0) {
  if (!hits || !hits.length) return 0;
  return hits
    .filter((h) => blacklistFlagWords([h], textLen).length > 0)
    .reduce((sum, h) => sum + Math.min(h.count, 5), 0);
}

// 粗略估算文本 token 数（中文按约 0.7 token/字，其他按 4 字符/token）
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = text.length - cjk;
  return Math.round(cjk * 0.7 + other / 4);
}

// ===== TXT 导入解析 =====
const CHAPTER_HEAD_RE = /^\s*(第\s*[0-9零一二三四五六七八九十百千万两〇壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章回节卷部篇]|【?\s*[0-9零一二三四五六七八九十百千万两〇壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章回节卷部篇]|前言|序言|序章|楔子|引子|终章|尾声|后记|番外(?:\s*[0-9零一二三四五六七八九十百千万两〇壹贰叁肆伍陆柒捌玖拾佰仟]*)?)\s*[：:、\-—\s—]*/;

// 清洗常见爬虫下载 TXT 的噪音行：页眉页脚、广告、纯数字页码、URL、站点标记
const NOISE_LINE_RES = [
  /^[\s]*(第?\d+页|page\s*\d+)[\s]*[页\s]*$/i,
  /^[\s]*[\d－-]{2,}[\s]*$/,
  /^(www\.|https?:\/\/)/i,
  /^[【\[（(]?最新章节[】\])]?/,
  /^(阅读|载)?全文(免费|无弹窗)?阅读/,
  /^正文(开始)?/,
  /^手机端阅读/,
  /^(本章完|全书完|本章完结)$/,
  /^记住?(本书|本站|首发)?(站点|网址|地址|书库)/,
  /^天才一秒记住本站地址/,
  /^最新章节请记住本站/,
  /^(如果您觉得|如遇|若觉得).*(请收藏|收藏本站|投推荐票)/,
  /^(请大家记住|求收藏|求推荐|求订阅|求月票)/,
  /^作者[:：]/,
  /^笔名[:：]/,
  /^\s*$/
];

function cleanTxtLine(line) {
  const s = String(line || '').trim();
  if (!s) return '';
  for (const re of NOISE_LINE_RES) {
    if (re.test(s)) return '';
  }
  // 行首/行尾的广告符号簇（如 ★★★ 分隔、→→→、※※※）
  let stripped = s
    .replace(/^[★☆※＊≈＊†×=·.~～_\-]+/, '')
    .replace(/[★☆※＊≈＊†×~～=_\-]{2,}$/, '')
    .trim();
  // 行内含"网址:xx"“www.xx.com"等下载站点痕迹，整行删除
  if (/:\s*(www\.|https?:\/\/)/i.test(stripped) || /^\s*(www\.|https?:\/\/)/i.test(stripped)) return '';
  return stripped;
}

// 解析 TXT 小说为章节数组。返回 { chapters: [{title, content}], splitted: boolean }
// 优先按「第X章」行首标题切分；无标题识别时按每 DEFAULT_CHUNK 字切分。
export function parseTxtChapters(text) {
  const raw = String(text || '');
  const DEFAULT_CHUNK = 2000;
  const lines = raw.split(/\r?\n/);
  const chapters = [];
  let cur = null;
  let splitted = false;
  let headCount = 0;
  let leadLines = [];

  const flush = () => {
    if (!cur) return;
    const content = cur.lines.join('\n').replace(/^\s+|\s+$/g, '');
    if (content) chapters.push({ title: cur.title, content });
    cur = null;
  };

  for (const line of lines) {
    const cleaned = cleanTxtLine(line);
    if (!cleaned && !line.trim()) continue;
    const trimmed = cleaned || line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(CHAPTER_HEAD_RE);
    if (m && trimmed.length <= 60) {
      flush();
      // 首个标题前若只有极短的行（书名/作者/简介），视为前言噪音丢弃
      if (!cur && leadLines.length && leadLines.join('').length <= 40 && headCount === 0) {
        leadLines = [];
      }
      const head = m[0].replace(/[：:、\-—\s]+$/g, '');
      cur = { title: head, lines: [] };
      headCount++;
    } else if (cur) {
      if (cleaned) cur.lines.push(cleaned);
    } else {
      // 标题识别之前出现的行，先缓冲；若全文书都没标题则用作正文
      leadLines.push(cleaned || trimmed);
    }
  }
  flush();

  // 全程没有识别到任何标题：按字数切分（leadLines 缓冲的前言行即全部正文）
  if (!headCount && leadLines.length) {
    const big = leadLines.join('\n');
    splitted = true;
    const total = big.length;
    for (let start = 0; start < total; start += DEFAULT_CHUNK) {
      const slice = big.slice(start, start + DEFAULT_CHUNK).replace(/^\s+|\s+$/g, '');
      if (slice) chapters.push({ title: `第${Math.floor(start / DEFAULT_CHUNK) + 1}章`, content: slice });
    }
  }

  // 只有零散几个标题且正文占比异常大（如只有"第一章"不到），仍视为有标题结构
  const hasHeads = headCount >= 1;

  if (!chapters.length) {
    // 完全没有标题：按字数切分
    splitted = true;
    const total = raw.length;
    for (let start = 0; start < total; start += DEFAULT_CHUNK) {
      const slice = raw.slice(start, start + DEFAULT_CHUNK).replace(/^\s+|\s+$/g, '');
      if (slice) chapters.push({ title: `第${Math.floor(start / DEFAULT_CHUNK) + 1}章`, content: slice });
    }
  }

  // 识别出的章节极少且单章超大（无换行大文本或标题几乎不出现）：按字数重新切分
  if (!splitted && hasHeads && chapters.length === 1 && chapters[0].content.length > DEFAULT_CHUNK * 3) {
    splitted = true;
    const big = chapters[0].content;
    const re = [];
    for (let start = 0; start < big.length; start += DEFAULT_CHUNK) {
      const slice = big.slice(start, start + DEFAULT_CHUNK).replace(/^\s+|\s+$/g, '');
      if (slice) re.push({ title: `第${Math.floor(start / DEFAULT_CHUNK) + 1}章`, content: slice });
    }
    return { chapters: re, splitted };
  }

  // 标题数量异常少（比如 100 章的大书只识别出 2-3 个标题但每章都很大）：
  // 若平均章节长度远超 DEFAULT_CHUNK 的 4 倍，判定标题覆盖不足，按字数重切
  if (!splitted && chapters.length >= 2 && chapters.length <= 5 && chapters.some((c) => c.content.length > DEFAULT_CHUNK * 5)) {
    let totalLen = chapters.reduce((s, c) => s + c.content.length, 0);
    const avg = totalLen / chapters.length;
    if (avg > DEFAULT_CHUNK * 4) {
      splitted = true;
      const big = chapters.map((c) => c.content).join('\n');
      const re = [];
      for (let start = 0; start < big.length; start += DEFAULT_CHUNK) {
        const slice = big.slice(start, start + DEFAULT_CHUNK).replace(/^\s+|\s+$/g, '');
        if (slice) re.push({ title: `第${Math.floor(start / DEFAULT_CHUNK) + 1}章`, content: slice });
      }
      return { chapters: re, splitted };
    }
  }

  return { chapters, splitted };
}
