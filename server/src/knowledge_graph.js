/**
 * 本地知识图谱 — 纯规则从小说文本中抽取人物关系/事件因果/时间线
 * 不依赖 LLM，基于正则和启发式规则
 */
import { db } from './db.js';

// ===== 人物关系抽取 =====

const RELATION_VERBS = {
  '师父': '师徒',
  '徒弟': '师徒',
  '师兄': '同门',
  '师弟': '同门',
  '师姐': '同门',
  '师妹': '同门',
  '父亲': '父子',
  '母亲': '母子',
  '儿子': '父子',
  '女儿': '父女',
  '妻子': '夫妻',
  '丈夫': '夫妻',
  '老婆': '夫妻',
  '老公': '夫妻',
  '兄弟': '兄弟',
  '姐妹': '姐妹',
  '好友': '朋友',
  '朋友': '朋友',
  '仇人': '仇敌',
  '敌人': '仇敌',
  '对手': '对手',
};

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟黄穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴';

function extractNames(text) {
  // 常见的中文姓名模式：2-4 字 + 出现多次
  const clean = String(text || '');
  const nameCandidates = {};
  
  // 模式1：X某道/说/看/走/笑
  const verbPattern = /([\u4e00-\u9fa5]{2,4})(?:道|说|笑道|冷道|怒道|喊道|低声道|沉声道|淡淡道|冷冷道|微笑道|苦笑道|叹道|问道|答道|叫道|吼道|哼道|看|望|走|跑|笑|怒|惊|想|转身|点头|摇头|皱眉|叹息)/g;
  let match;
  while ((match = verbPattern.exec(clean)) !== null) {
    let name = match[1];
    // 过滤非人名词
    const stopWords = ['轻声', '低声', '沉声', '淡淡', '冷冷', '微笑', '苦笑', '转身', '身形', '突然', '忽然', '瞬间', '刹那', '片刻', '那时', '此刻', '于是', '然后', '因为', '所以', '但是', '不过', '虽然', '尽管', '这是', '那是', '他的', '她的'];
    if (stopWords.includes(name)) continue;
    // 剥离末尾的动词修饰词
    const modifiers = ['轻声', '低声', '沉声', '淡淡', '冷冷', '微笑', '苦笑', '转身', '怒', '惊'];
    for (const mod of modifiers) {
      if (name.endsWith(mod) && name.length > mod.length + 1) {
        name = name.slice(0, name.length - mod.length);
        break;
      }
    }
    if (name.length < 2) continue;
    if (!nameCandidates[name]) nameCandidates[name] = 0;
    nameCandidates[name]++;
  }
  
  // 模式2：对话中的称呼
  const addressPattern = /[""''「」『』](.*?)([\u4e00-\u9fa5]{2,4})(?:兄|弟|姐|妹|叔|伯|爷|公|老|少|前辈|道友|贤侄|师侄|师弟|师妹|师兄|师姐)[，。！？""''「」』』]/g;
  while ((match = addressPattern.exec(clean)) !== null) {
    const name = match[2];
    if (!nameCandidates[name]) nameCandidates[name] = 0;
    nameCandidates[name] += 2; // 称呼权重大
  }
  
  // 模式2：X是Y的Z 关系句中的名字
  const relationPattern = /([\u4e00-\u9fa5]{2,4})是([\u4e00-\u9fa5]{2,4})的(?:师父|徒弟|师兄|师弟|师姐|师妹|父亲|母亲|儿子|女儿|妻子|丈夫|兄弟|姐妹|好友|朋友|仇人|敌人|对手)/g;
  while ((match = relationPattern.exec(clean)) !== null) {
    for (const name of [match[1], match[2]]) {
      const stopWords = ['轻声', '低声', '突然', '忽然', '于是', '因为', '所以', '但是', '这是', '那是'];
      if (stopWords.includes(name)) continue;
      if (!nameCandidates[name]) nameCandidates[name] = 0;
      nameCandidates[name]++;
    }
  }

  // 模式3：X杀了/救了/背叛了Y 事件句中的名字
  const eventNamePattern = /([\u4e00-\u9fa5]{2,3})(?:杀了|击杀|斩杀|杀死|打败|击败|战胜|救了|救下|保护|背叛|暗算|偷袭)([\u4e00-\u9fa5]{2,3})(?![\u4e00-\u9fa5])/g;
  while ((match = eventNamePattern.exec(clean)) !== null) {
    let a = match[1], b = match[2];
    const stopWords = ['轻声', '低声', '突然', '忽然', '于是', '因为', '所以', '但是'];
    // 过滤掉末尾是动词一部分的误捕获
    const verbStems = ['斩', '杀', '击', '打', '救', '叛', '暗', '偷'];
    if (verbStems.some((v) => a.endsWith(v) && a.length > 2)) {
      a = a.slice(0, -1);
    }
    for (const name of [a, b]) {
      if (stopWords.includes(name) || name.length < 2) continue;
      if (!nameCandidates[name]) nameCandidates[name] = 0;
      nameCandidates[name]++;
    }
  }

  // 模式4：直接从对话前的说话者提取（如 "苏婉清的声音从身后传来"）
  const voicePattern = /([\u4e00-\u9fa5]{2,4})(?:的声音|的声音从|的身影|的目光|的眼中|的面容|的表情)/g;
  while ((match = voicePattern.exec(clean)) !== null) {
    let name = match[1];
    const stopWords = ['轻声', '低声', '突然', '忽然'];
    if (stopWords.includes(name)) continue;
    if (!nameCandidates[name]) nameCandidates[name] = 0;
    nameCandidates[name]++;
  }

  // 只保留出现 1 次以上的（短文本也能提取）
  return Object.entries(nameCandidates)
    .filter(([name, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function extractRelationships(text, names) {
  const clean = String(text || '');
  const relationships = [];
  const nameSet = new Set(names.map((n) => n.name));
  
  // 模式：A是B的X / A的X是B
  for (const [verb, relType] of Object.entries(RELATION_VERBS)) {
    const pattern1 = new RegExp(`([\u4e00-\u9fa5]{2,4})是([\u4e00-\u9fa5]{2,4})的${verb}`, 'g');
    let m;
    while ((m = pattern1.exec(clean)) !== null) {
      const a = m[1], b = m[2];
      if (nameSet.has(a) && nameSet.has(b)) {
        relationships.push({ from: a, to: b, type: relType, source: `${a}是${b}的${verb}` });
      }
    }
    
    // 模式：A的X是B
    const pattern2 = new RegExp(`([\u4e00-\u9fa5]{2,4})的${verb}是([\u4e00-\u9fa5]{2,4})`, 'g');
    while ((m = pattern2.exec(clean)) !== null) {
      const a = m[1], b = m[2];
      if (nameSet.has(a) && nameSet.has(b)) {
        relationships.push({ from: a, to: b, type: relType, source: `${a}的${verb}是${b}` });
      }
    }
  }
  
  // 模式：A和B一起/对战/联手
  const actionPattern = /([\u4e00-\u9fa5]{2,4})(?:和|与|跟)([\u4e00-\u9fa5]{2,4})(?:一起|联手|对战|交手|战斗|对决|合作|配合)/g;
  let m2;
  while ((m2 = actionPattern.exec(clean)) !== null) {
    const a = m2[1], b = m2[2];
    if (nameSet.has(a) && nameSet.has(b)) {
      relationships.push({ from: a, to: b, type: '合作/对抗', source: `${a}与${b}互动` });
    }
  }
  
  // 模式：A杀了/救了/打了B
  const eventPattern = /([\u4e00-\u9fa5]{2,3})(?:杀了|击杀|斩杀|杀死|打败|击败|战胜|救了|救下|保护|背叛|暗算|偷袭)([\u4e00-\u9fa5]{2,3})(?![\u4e00-\u9fa5])/g;
  let m3;
  while ((m3 = eventPattern.exec(clean)) !== null) {
    const a = m3[1], b = m3[2];
    if (nameSet.has(a) && nameSet.has(b)) {
      const action = m3[0].includes('杀') || m3[0].includes('打') ? '敌对' : '互动';
      relationships.push({ from: a, to: b, type: action, source: m3[0] });
    }
  }
  
  // 去重
  const seen = new Set();
  return relationships.filter((r) => {
    const key = `${r.from}-${r.to}-${r.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===== 事件因果抽取 =====

const CAUSE_PATTERNS = [
  /因为(.{2,50}?)[，,]?\s*(?:所以|因此|于是)(.{2,50}?)[。！？]/g,
  /由于(.{2,50}?)[，,]?\s*(?:导致|使得|造成)(.{2,50}?)[。！？]/g,
  /(.{2,40}?)[，,]?\s*因此(.{2,50}?)[。！？]/g,
  /(.{2,40}?)[，,]?\s*结果(.{2,50}?)[。！？]/g,
  /(.{2,40}?)[，,]?\s*所以(.{2,50}?)[。！？]/g,
];

function extractCausalEvents(text) {
  const clean = String(text || '');
  const events = [];
  
  for (const pattern of CAUSE_PATTERNS) {
    let m;
    while ((m = pattern.exec(clean)) !== null) {
      events.push({
        cause: m[1].trim().slice(0, 50),
        effect: m[2].trim().slice(0, 50),
      });
    }
  }
  
  return events.slice(0, 30);
}

// ===== 时间线抽取 =====

const TIME_PATTERNS = [
  { pattern: /(?:第一天|第二天|第三天|几天后|数日后|半个月后|一个月后|三个月后|半年后|一年后|两年后|三年后|数年后|多年后|不久后|片刻后|片刻之后|随即|旋即|随即之后)/g, type: 'relative' },
  { pattern: /(?:清晨|早上|上午|中午|下午|傍晚|晚上|深夜|午夜|凌晨)/g, type: 'time_of_day' },
  { pattern: /(?:春天|夏天|秋天|冬天|春季|夏季|秋季|冬季|初春|盛夏|深秋|寒冬)/g, type: 'season' },
  { pattern: /(?:三年前|五年前|十年前|二十年前|百年前|千年前|万年前|上古时期|远古时期|上古时代)/g, type: 'past' },
];

function extractTimeline(text) {
  const clean = String(text || '');
  const events = [];
  
  for (const { pattern, type } of TIME_PATTERNS) {
    let m;
    while ((m = pattern.exec(clean)) !== null) {
      // 获取时间标记前后的上下文
      const start = Math.max(0, m.index - 20);
      const end = Math.min(clean.length, m.index + m[0].length + 30);
      const context = clean.slice(start, end).trim();
      events.push({
        timeMarker: m[0],
        type,
        context: context.slice(0, 60),
        position: m.index,
      });
    }
  }
  
  // 按文本位置排序（即时间顺序）
  return events.sort((a, b) => a.position - b.position).slice(0, 50);
}

// ===== 关键事件抽取 =====

const KEY_EVENT_PATTERNS = [
  { pattern: /(?:突破|晋升|进阶|升级)(?:到|为)?(?:[\u4e00-\u9fa5]{1,8}?)(?:境界|层|级)/g, type: 'powerup' },
  { pattern: /(?:获得|得到|找到|拾得)(?:了)?(?:[\u4e00-\u9fa5]{2,15}?)(?:法宝|武器|秘籍|功法|丹药|宝物|神器|灵物)/g, type: 'item_acquired' },
  { pattern: /(?:战斗|大战|激战|决斗|交手|对决)(?:中|时|开始|结束)/g, type: 'battle' },
  { pattern: /(?:死亡|陨落|身死|战死|被杀|牺牲)/g, type: 'death' },
  { pattern: /(?:背叛|叛变|反叛|倒戈)/g, type: 'betrayal' },
  { pattern: /(?:重逢|再遇|相遇|相识|结识)/g, type: 'encounter' },
  { pattern: /(?:离开|出发|启程|动身|远行)/g, type: 'departure' },
  { pattern: /(?:归来|回归|返回|回到)/g, type: 'return' },
];

function extractKeyEvents(text) {
  const clean = String(text || '');
  const events = [];
  
  for (const { pattern, type } of KEY_EVENT_PATTERNS) {
    let m;
    while ((m = pattern.exec(clean)) !== null) {
      const start = Math.max(0, m.index - 10);
      const end = Math.min(clean.length, m.index + m[0].length + 20);
      const context = clean.slice(start, end).trim();
      events.push({
        type,
        event: m[0],
        context: context.slice(0, 50),
        position: m.index,
      });
    }
  }
  
  return events.sort((a, b) => a.position - b.position);
}

// ===== 主函数：从文本构建知识图谱 =====

export function buildKnowledgeGraph(text) {
  const clean = String(text || '');
  if (clean.length < 20) return null;
  
  const names = extractNames(clean);
  const relationships = extractRelationships(clean, names);
  const causalEvents = extractCausalEvents(clean);
  const timeline = extractTimeline(clean);
  const keyEvents = extractKeyEvents(clean);
  
  return {
    characters: names,
    relationships,
    causalEvents,
    timeline,
    keyEvents,
    stats: {
      characterCount: names.length,
      relationshipCount: relationships.length,
      causalEventCount: causalEvents.length,
      timelineMarkerCount: timeline.length,
      keyEventCount: keyEvents.length,
      textLength: clean.length,
    },
  };
}

// ===== 从小说构建知识图谱并存入数据库 =====

export function buildNovelKnowledgeGraph(novelId) {
  const chapters = db.prepare('SELECT chapter_index, content FROM chapters WHERE novel_id = ? AND status = ? ORDER BY chapter_index').all(novelId, 'completed');
  if (!chapters.length) throw new Error('小说没有已完成的章节');
  
  const fullText = chapters.map((c) => c.content).join('\n').slice(0, 200000);
  const graph = buildKnowledgeGraph(fullText);
  if (!graph) throw new Error('文本内容不足，无法构建知识图谱');
  
  // 标注每条关系/事件来自的章节范围
  graph.chapterRange = {
    from: chapters[0].chapter_index,
    to: chapters[chapters.length - 1].chapter_index,
  };
  
  return graph;
}

// ===== 格式化为可注入的文本块 =====

export function formatKnowledgeGraphBlock(graph) {
  if (!graph) return '';
  let block = '【本地知识图谱】\n';
  
  if (graph.characters?.length) {
    block += `\n人物（${graph.characters.length}个）：${graph.characters.slice(0, 10).map((c) => c.name).join('、')}\n`;
  }
  
  if (graph.relationships?.length) {
    block += `\n人物关系：\n`;
    graph.relationships.slice(0, 15).forEach((r) => {
      block += `  ${r.from} —[${r.type}]→ ${r.to}\n`;
    });
  }
  
  if (graph.keyEvents?.length) {
    block += `\n关键事件：\n`;
    graph.keyEvents.slice(0, 10).forEach((e) => {
      block += `  [${e.type}] ${e.context}\n`;
    });
  }
  
  if (graph.timeline?.length) {
    block += `\n时间线标记：\n`;
    graph.timeline.slice(0, 10).forEach((t) => {
      block += `  ${t.timeMarker}: ${t.context.slice(0, 30)}\n`;
    });
  }
  
  if (graph.causalEvents?.length) {
    block += `\n因果关系：\n`;
    graph.causalEvents.slice(0, 8).forEach((e) => {
      block += `  ${e.cause} → ${e.effect}\n`;
    });
  }
  
  return block;
}
