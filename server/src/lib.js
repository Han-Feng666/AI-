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
    return JSON.parse(getSetting('llm_config') || '{}');
  } catch {
    return {};
  }
}

export function saveLLMConfig(config) {
  setSetting('llm_config', JSON.stringify(config));
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
  try { return JSON.parse(novel.style_ids || '[]'); } catch { return []; }
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

export function getOpenForeshadowings(novelId, limit = 30) {
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
export function getKeyMoments(novelId, limit = 80) {
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
export function getStageMemories(novelId) {
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

export function getRecentChapters(novelId, n = 2) {
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
  return db.prepare('SELECT id, novel_id, chapter_index, title, summary, word_count, status, ai_score, created_at, updated_at FROM chapters WHERE novel_id = ? ORDER BY chapter_index').all(novelId);
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
export function buildHistorySummaries(novelId, budgetTokens) {
  const rows = db.prepare("SELECT chapter_index, title, summary FROM chapters WHERE novel_id = ? AND summary != '' ORDER BY chapter_index").all(novelId);
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
  // 按空行分段
  const paras = s.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
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
  return hits.sort((a, b) => b.count - a.count);
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
  // 5) 全等号无空格包裹的中文语气助词错字（"了了""着着"等偶发）——暂不做，避免误伤。
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
