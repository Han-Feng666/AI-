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
  '熠熠生辉', '袅袅', '流淌着', '诉说着', '仿佛能听到', '似乎一切'
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
  { re: /(?:命运|宿命)(?:的)?(?:的)?(?:轮回|齿轮|嘲弄)|(?:在(?:这|那)一刻)。{0,8}命运/g, label: '命运齿轮句式' }
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

export function scanTopicDrift(text, genre) {
  if (!text) return [];
  const g = String(genre || '');
  const isModern = !g || MODERN_GENRES.some((m) => g.includes(m));
  if (!isModern) return [];
  const hits = [];
  for (const w of TOPIC_DRIFT_WORDS) {
    let count = 0, from = 0;
    while ((from = text.indexOf(w, from)) !== -1) { count++; from += w.length; }
    if (count > 0) hits.push({ word: w, count });
  }
  if (hits.length) {
    hits.push({ word: `跑题：现代题材中混入古代市井元素(${hits.map(h=>h.word).join('、')})`, count: Math.max(...hits.map(h=>h.count)) });
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

// 剥离引号内对话内容，避免"对话短句/短段"干扰短句切割与碎片化检测（对话短句是正常写作）
function stripDialogue(text) {
  return String(text || '').replace(/["""''「『【（][^""""''」』】）]*["""''」』】）]/g, '');
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
    .replace(/——\s*(?=(?:这|那|他|她|它|我|你|只|就|便|却|而|但|可|因|所以|于是|不过|然后|接着|突然|忽然|终于|毕竟|其实|当然|这时|此刻|当下|原来|原来如此)[\u4e00-\u9fff]{2,})/g, '，')
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
  return s;
}

// 质量门判定：黑名单词命中达到阈值即判"AI 味超标"，需要再润色
export function blacklistPenalty(hits) {
  if (!hits || !hits.length) return 0;
  return hits.reduce((sum, h) => sum + Math.min(h.count, 5), 0);
}

// 命中黑名单词即视为需要处理（宁严勿松）。质量门要求最终章节不再命中任何黑名单词。
export function blacklistFlagWords(hits, threshold = 1) {
  return (hits || []).filter((h) => h.count >= threshold).map((h) => h.word);
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
