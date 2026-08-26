export function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

// 从流式 JSON 文本中提取可读的中文内容，供生成方案时预览。
// 模型返回的是带英文键名的 JSON 结构，直接透传给用户会看到一堆键名与乱码，
// 这里提取其中的字符串值（优先含中文的），拼成易读预览。
export function planStreamPreview(raw) {
  if (!raw) return '';
  let t = String(raw);
  // 处理 \uXXXX 转义：中转站/模型可能把中文序列化为转义形式，
  // 直接展示就是乱码；先还原成真实字符再提取（不影响 JSON 结构判断）。
  if (t.includes('\\u')) {
    try {
      t = t.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    } catch { /* 还原失败保留原文 */ }
  }
  const out = [];
  // 正则匹配 JSON 字符串值："key": "value"
  const re = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(t))) {
    const key = m[1];
    const val = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (!val) continue;
    // 跳过显然是结构占位的值（纯英文键名、markdown 围栏等）
    if (/^```/.test(val)) continue;
    if (/^\{.*\}$/.test(val) || /^\[.*\]$/.test(val)) continue;
    // 只保留含中文的值，避免把英文键名/英文说明刷给用户
    if (!/[\u4e00-\u9fff]/.test(val)) continue;
    const label = { title: '书名', genre: '类型', world_view: '世界观', outline: '大纲', name: '名称', summary: '概要', description: '简介', personality: '性格', background: '身世', goal: '目标', ability: '能力', role_type: '定位', faction: '所属势力', relation_type: '关系', arc: '弧线', chapter_range: '章节范围' }[key];
    out.push(label ? `【${label}】${val}` : val);
  }
  if (out.length) return out.slice(0, 40).join('\n');
  // 无法按键提取时，兜底只保留中文片段
  const zh = t.replace(/"((?:\\.|[^"\\])*)"/g, (s, inner) => inner).split(/\n|[,{}[\]]/).map((s) => s.trim()).filter((s) => s && /[\u4e00-\u9fff]/.test(s));
  return zh.slice(0, 40).join('\n');
}

export function formatDate(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
}

export function formatWords(n) {
  const v = Number(n || 0);
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿字';
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万字';
  return formatNumber(v) + ' 字';
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text)
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
  return ok;
}

export function saveGenDraft(novelId, text, idx = null) {
  try {
    localStorage.setItem(`novel_gen_draft_${novelId}`, JSON.stringify({ idx, text }));
  } catch { /* 空间不足时静默 */ }
}

export function getGenDraftMeta(novelId) {
  try {
    const raw = localStorage.getItem(`novel_gen_draft_${novelId}`) || '';
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.text === 'string') return obj;
    } catch { /* 旧版纯文本草稿 */ }
    return { idx: null, text: raw };
  } catch { return null; }
}

export function clearGenDraft(novelId) {
  try { localStorage.removeItem(`novel_gen_draft_${novelId}`); } catch { /* ignore */ }
}

export function getGenDraft(novelId) {
  return getGenDraftMeta(novelId)?.text || '';
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 还原模型/中转站把中文双重转义成的字面 \uXXXX 序列（含代理对）
export function unescapeUnicode(str) {
  const s = String(str || '');
  if (!s.includes('\\u')) return s;
  let out = s.replace(/\\u([0-9a-fA-F]{4})\\u([0-9a-fA-F]{4})/g, (m, h1, h2) => {
    const c1 = parseInt(h1, 16);
    const c2 = parseInt(h2, 16);
    if (c1 >= 0xd800 && c1 <= 0xdbff && c2 >= 0xdc00 && c2 <= 0xdfff) {
      return String.fromCharCode(c1, c2);
    }
    return m;
  });
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

// 读取 TXT 文件并自动识别编码（UTF-8 / UTF-8 BOM / UTF-16 / GBK 等 Windows 常见编码）
export async function readTxtFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // BOM 检测
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.slice(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.slice(2));
  }
  // 无 BOM：先尝试严格 UTF-8 解码，失败说明是其他编码（如 GBK/GB18030）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}


export const GENRES = [
  '玄幻', '仙侠', '奇幻', '科幻', '都市', '言情', '悬疑', '推理',
  '惊悚', '恐怖', '历史', '架空', '军事', '战争', '武侠', '游戏',
  '体育', '青春', '校园', '职场', '商战', '宫廷', '宅斗', '权谋',
  '重生', '穿越', '系统流', '无限流', '克苏鲁', '蒸汽朋克', '赛博朋克',
  '末世', '废土', '种田', '美食', '直播', '娱乐', '轻小说', '侦探',
  '同人', '影视化', '黑科技', '修真', '巫师流', '洪荒流',
  '神话', '童话', '魔幻', '基建', '电竞', '星际',
  '机甲', '二次元', '盗墓', '探险', 'ASMR',
  '诡秘', '志怪', '民俗', '谍战', '竞技', '治愈', '日常', '沙雕',
  '无敌流', '诸天流', '国风', '赛博修仙', '灵气复苏', '掌门流',
  '幕后流', '数据流', '第四天灾', 'DND', 'SCP', '规则怪谈', '密室逃生',
  '西幻', '剑与魔法', '精灵', '骑士', '勇者',
  '军事特工', '军旅', '佣兵', '谍战风云', '特工',
  '体育竞技', '篮球', '足球', '格斗', '赛车', '拳击',
  '娱乐圈', '明星', '偶像', '选秀', '综艺', '歌舞',
  '豪门', '赘婿', '战神', '兵王', '神医', '都市异能',
  '灵气复苏觉醒', '御兽', '召唤', '炼金',
  '高武', '宗门', '门派', '帮派', '王朝', '争霸',
  '武侠重生', '历史穿越', '官场', '商界',
  '悬疑推理', '本格推理', '社会派', '法医', '刑侦',
  '怪谈', '民俗恐怖', '邪典', '精神恐怖',
  '末世求生', '废土重建', '丧尸', '辐射',
  '太空歌剧', '硬科幻', '软科幻', '时间旅行', '平行宇宙',
  '玄幻争霸', '万族', '神魔', '黑暗', '萌系',
  '克系', '复古', '维多利亚', '末日', '科幻战争', '星际殖民',
  '盗墓笔记', '古墓', '考古', '寻宝',
  '青春恋爱', '纯爱', '虐恋', '甜宠', '破镜重圆', '暗恋',
  '仙侠后宫', '都市后宫', '单女主', '无女主',
  '游戏同人', '漫威', 'DC', '哈利波特', '玄幻同人',
  '复仇', '逆袭', '扮猪吃虎', '打脸', '装逼打脸', '废物逆袭',
  '无敌流爽文', '奶爸', '萌宝', '单亲爸爸', '萌宠', '团宠',
  '直播带货', '主播', '网红', '短视频',
  '聊天群', '万界聊天群', '诸天万界', '诸神',
  '禁区', '神秘', '超自然', '都市传说',
  '兽人', '龙族', '巨龙', '矮人', '精灵女王', '哥布林',
  '武侠古言', '仙侠虐恋', '都市神医', '乡村', '种田文', '年代文', '重生七零',
  '星际争霸', '宇宙战争', '舰队', '殖民', '异星',
  '民间传说', '山野怪谈', '都市怪谈', '校园怪谈', '午夜',
  '烧脑', '高智商', '心理战', '博弈', '谍战风云',
  '星际机甲', '机甲驾驶', '王牌机师', '战争机器',
  '天灾', '自然灾害', '求生', '荒野求生', '孤岛',
  '酒馆', '旅店', '餐厅经营', '餐饮', '后厨',
  '赛道', '赛车', '极速', '漂移',
  '打工人', '社畜', '职场新人', '办公室恋情', '爽剧',
  '无限副本', '副本攻略', '地下城', '迷宫', '塔防',
  '历史权谋', '谋士', '军师', '帝王', '皇后',
  '修仙虐恋', '师徒恋', '仙魔', '正邪',
  '游戏高手', '全服第一', '竞技场', '排位', '团战',
  '民俗文化', '非遗', '手艺人', '匠人',
  '玄幻都市', '都市修仙', '都市天师', '都市捉妖'
];

export const PRESET_STYLES = [
  '热血燃向', '轻松日常', '幽默风趣', '冷峻写实', '深沉黑暗',
  '治愈温暖', '古风典雅', '华丽辞藻', '简洁利落', '文青诗意',
  '悬疑紧张', '铁血硬汉', '温情细腻', '快节奏爽文', '慢热厚积',
  '群像史诗', '第一人称沉浸', '恐怖压抑', '浪漫甜蜜', '荒诞讽刺',
  '冷幽默', '段子流', '诗意抒情', '官场写法', '意识流', '极简白描',
  '二次元中二味', '魔幻现实', '电影分镜感', '纪录片旁白',
  '方言口语化', '老白文', '毒草', '种田团的温度', '日式治愈',
  '暗黑哥特', '新怪谈', '赛博Noir', '日式轻小说', '美式硬汉侦探',
  '英伦冷幽默', '文艺清新', '国风典雅', '武侠江湖气', '科幻冷峻',
  '悬疑迷雾', '史诗恢弘', '生活流', '学术考据', '纪实白描',
  '克苏鲁式不可名状', '废土苍凉', '蒸汽魔法', '宫斗权谋', '市井烟火',
  '公路片叙事', '双线并行', '倒叙解谜', '多视角POV', '书信体/日记体',
  '武侠快意', '军旅铁血', '谍战冷锋', '热血竞技', '解说腔',
  '微博体短段', '章回体', '评书腔', '爽点密集', '悬念钩子流',
  '日常甜宠', '拉扯暧昧', '高级感留白', '烟火人情', '清冷疏离',
  '腹黑算计', '正剧厚重', '轻快俏皮', '沉稳大气', '雷厉风行',
  '细腻唯美', '犀利毒舌', '温吞绵长', '剑走偏锋', '质朴留真',
  '对话驱动', '心理刻画为主', '动作场面爆发', '环境氛围渲染', '意象密集'
];

// Phase 9：篇幅分级（决定模型默认 chapterWordCount / targetChapters 推荐值）
export const LENGTH_CLASSES = [
  {
    key: 'short',
    label: '短篇',
    desc: '1-10 章，每章约 2-3 千字',
    chapterWordCount: 2500,
    targetChapters: 5
  },
  {
    key: 'medium',
    label: '中篇',
    desc: '10-50 章，每章约 3-5 千字',
    chapterWordCount: 3500,
    targetChapters: 20
  },
  {
    key: 'long',
    label: '长篇连载',
    desc: '50 章以上，每章约 3-5 千字',
    chapterWordCount: 4000,
    targetChapters: 80
  }
];

export function splitGenres(genre) {
  return String(genre || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const ROLE_TYPES = ['主角', '主角团', '大反派', '反派', '导师', '红颜', '重要配角', '配角'];

export const FACTION_TYPES = ['宗门', '王朝', '商会', '暗组织', '家族', '学院', '军方', '异族', '联盟', '帮派'];

export const FACTION_STANCES = ['正派', '中立', '邪派'];

export const RELATION_TYPES = [
  '朋友', '恋人', '夫妻', '师徒', '兄妹', '父子', '母女', '祖孙',
  '仇敌', '对手', '盟友', '上下级', '同事', '同学', '同门', '主仆', '其他'
];

export const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4',
  '#8b5cf6', '#ef4444', '#f97316', '#14b8a6', '#eab308'
];

export const ROLE_COLORS = {
  '主角': '#ef4444',
  '主角团': '#f97316',
  '大反派': '#8b5cf6',
  '反派': '#8b5cf6',
  '导师': '#06b6d4',
  '红颜': '#ec4899',
  '重要配角': '#f59e0b',
  '配角': '#6366f1'
};

export const STATUS_MAP = {
  draft: { text: '草稿', type: 'info' },
  planned: { text: '已规划', type: 'warning' },
  writing: { text: '创作中', type: 'primary' },
  finished: { text: '已完成', type: 'success' }
};
