/**
 * 离线风格学习引擎 — 纯统计分析，不依赖 LLM（史诗级增强版）
 * 基于 N-gram 语言模型、句子长度分布、标点频率、词频、段落节奏、情绪曲线、角色对话风格等统计特征
 */
import { db } from './db.js';

function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?…\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 10);
}

function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

// ===== N-gram 语言模型 =====

function ngramFreq(text, n = 2) {
  const clean = String(text || '').replace(/[\s\n\r，。！？、；：""''《》【】（）().,!?;:\-—…]/g, '');
  const freq = {};
  for (let i = 0; i <= clean.length - n; i++) {
    const gram = clean.slice(i, i + n);
    freq[gram] = (freq[gram] || 0) + 1;
  }
  return freq;
}

function bigramFreq(text) {
  return ngramFreq(text, 2);
}

function trigramFreq(text) {
  return ngramFreq(text, 3);
}

function topN(freq, n = 20) {
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

// ===== N-gram 语言模型：生成概率表 =====

function buildNgramModel(text, n = 2) {
  const clean = String(text || '').replace(/[\s\n\r，。！？、；：""''《》【】（）().,!?;:\-—…]/g, '');
  if (clean.length < n + 1) return null;

  const model = {};
  for (let i = 0; i <= clean.length - n; i++) {
    const context = clean.slice(i, i + n - 1);
    const next = clean[i + n - 1];
    if (!model[context]) model[context] = {};
    model[context][next] = (model[context][next] || 0) + 1;
  }

  // 转为概率
  for (const ctx of Object.keys(model)) {
    const total = Object.values(model[ctx]).reduce((a, b) => a + b, 0);
    for (const ch of Object.keys(model[ctx])) {
      model[ctx][ch] = model[ctx][ch] / total;
    }
  }

  const totalBigrams = Object.keys(model).length;
  return { n, model, contextCount: totalBigrams, sampleText: clean.slice(0, 200) };
}

// 从 N-gram 模型生成伪文本（用于展示文风特征）
function generateFromModel(ngramModel, length = 50) {
  if (!ngramModel?.model) return '';
  const contexts = Object.keys(ngramModel.model);
  if (!contexts.length) return '';
  let current = contexts[Math.floor(Math.random() * contexts.length)];
  let result = current;
  for (let i = 0; i < length; i++) {
    const next = ngramModel.model[current];
    if (!next) break;
    const chars = Object.keys(next);
    const probs = Object.values(next);
    const r = Math.random();
    let cumulative = 0;
    let picked = chars[0];
    for (let j = 0; j < chars.length; j++) {
      cumulative += probs[j];
      if (r < cumulative) { picked = chars[j]; break; }
    }
    result += picked;
    current = result.slice(result.length - (ngramModel.n - 1));
  }
  return result;
}

// ===== 句长分析 =====

function analyzeSentenceLength(sentences) {
  if (!sentences.length) return { avg: 0, short: 0, long: 0, distribution: [], variance: 0 };
  const lengths = sentences.map((s) => countChars(s));
  const avg = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const short = lengths.filter((l) => l < 10).length;
  const long = lengths.filter((l) => l > 50).length;
  const variance = Math.round(lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length);
  const buckets = [0, 5, 10, 20, 30, 50, 80, 120];
  const distribution = buckets.map((b, i) => {
    const next = buckets[i + 1] || Infinity;
    return { range: `${b}-${next === Infinity ? '+' : next}`, count: lengths.filter((l) => l >= b && l < next).length };
  });
  return { avg, short, long, distribution, variance };
}

// ===== 标点分析 =====

function analyzePunctuation(text) {
  const total = countChars(text) || 1;
  const stats = {
    comma: (String(text).match(/，/g) || []).length,
    period: (String(text).match(/。/g) || []).length,
    exclaim: (String(text).match(/[！!]/g) || []).length,
    question: (String(text).match(/[？?]/g) || []).length,
    ellipsis: (String(text).match(/…/g) || []).length,
    dash: (String(text).match(/[—–-]/g) || []).length,
    colon: (String(text).match(/[：:]/g) || []).length,
    quote: (String(text).match(/[""]/g) || []).length
  };
  const per1k = {};
  for (const [k, v] of Object.entries(stats)) {
    per1k[k] = Math.round((v / total) * 1000);
  }
  return { raw: stats, perThousand: per1k };
}

// ===== 对话分析 =====

function analyzeDialogue(text) {
  const dialogues = String(text || '').match(/[""''「」『』].*?[""''「」』』]/g) || [];
  if (!dialogues.length) return { count: 0, avgLength: 0, ratio: 0, speakers: [] };
  const total = countChars(text) || 1;
  const dialogueText = dialogues.join('');
  return {
    count: dialogues.length,
    avgLength: Math.round(countChars(dialogueText) / dialogues.length),
    ratio: Math.round((countChars(dialogueText) / total) * 100),
    samples: dialogues.slice(0, 5)
  };
}

// ===== 题材检测 =====

function detectGenreHints(text) {
  const hints = [];
  const checks = {
    '玄幻': [/灵气|修为|功法|丹药|境界|元婴|筑基|金丹|经脉|灵石/i, /宗门|长老|弟子|护法|阵法|符箓|法宝/i],
    '都市': [/公司|总裁|合同|股票|投资|创业|面试|项目/i, /地铁|外卖|快递|手机|微信|直播/i],
    '悬疑': [/线索|嫌疑|证据|推理|不在场|密室|不在场证明/i, /尸体|凶器|作案|调查|案件/i],
    '科幻': [/星际|飞船|光年|人工智能|机器人|基因|纳米|量子/i, /银河|行星|空间站|殖民|外星/i],
    '恐怖': [/鬼|尸|血|恐怖|诡异|阴森|诅咒|灵异/i, /黑暗|阴影|尖叫|颤抖|不寒而栗/i],
    '言情': [/心动|喜欢|爱|吻|拥抱|脸红|心跳|暧昧/i, /男朋友|女朋友|约会|表白|暗恋|甜蜜/i],
    '武侠': [/武功|内力|江湖|侠|剑法|掌法|门派|轻功/i, /大侠|掌门|师兄|师妹|比武|切磋/i],
    '历史': [/皇帝|大臣|朝廷|奏折|圣旨|太子|皇后|太监/i, /战争|征战|沙场|将军|兵马|攻城/i],
    '重生': [/重生|前世|上一世|重来|回到|穿越|异世界/i],
    '系统': [/系统|面板|属性|升级|经验值|任务|技能点/i]
  };
  for (const [genre, patterns] of Object.entries(checks)) {
    const matched = patterns.some((p) => p.test(String(text)));
    if (matched) hints.push(genre);
  }
  return hints;
}

// ===== 风格特征检测 =====

function detectStyleFeatures(text) {
  const features = [];
  const avgSentLen = splitSentences(text).length > 0
    ? Math.round(countChars(text) / splitSentences(text).length)
    : 0;
  if (avgSentLen < 15) features.push('短句为主，节奏紧凑');
  else if (avgSentLen > 40) features.push('长句为主，描写细腻');
  else features.push('长短句结合，节奏适中');

  const dialogue = analyzeDialogue(text);
  if (dialogue.ratio > 30) features.push('对话密集，以角色互动驱动');
  else if (dialogue.ratio < 10) features.push('叙述为主，对话点缀');

  const punct = analyzePunctuation(text);
  if (punct.perThousand.exclaim > 15) features.push('感叹号多，情绪饱满');
  if (punct.perThousand.question > 10) features.push('问句多，悬念感强');
  if (punct.perThousand.ellipsis > 8) features.push('省略号多，留白含蓄');
  if (punct.perThousand.dash > 10) features.push('破折号多，解释说明多');

  return features;
}

// ===== 段落节奏分析（新增） =====

function analyzeParagraphRhythm(text) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 2) return { avgParaLen: 0, rhythmPattern: [], pace: 'unknown', variance: 0 };

  const paraLengths = paragraphs.map((p) => countChars(p));
  const avgParaLen = Math.round(paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length);
  const variance = Math.round(paraLengths.reduce((s, l) => s + Math.pow(l - avgParaLen, 2), 0) / paraLengths.length);

  // 节奏模式：将段落长度归一化为 S/M/L
  const pattern = paraLengths.slice(0, 30).map((l) => {
    if (l < avgParaLen * 0.5) return 'S';
    if (l > avgParaLen * 1.5) return 'L';
    return 'M';
  });

  let pace;
  if (avgParaLen < 80) pace = 'fast';
  else if (avgParaLen > 200) pace = 'slow';
  else pace = 'medium';

  return { avgParaLen, rhythmPattern: pattern, pace, variance, paragraphCount: paragraphs.length };
}

// ===== 情绪曲线分析（新增） =====

const POSITIVE_WORDS = '欢喜高兴开心快乐兴奋激动愉悦满足幸福温暖微笑大笑欣喜欣慰骄傲自豪轻松舒畅甜蜜美好希望期待惊喜';
const NEGATIVE_WORDS = '悲伤痛苦绝望愤怒仇恨恐惧害怕忧虑焦虑烦躁不安压抑沉重绝望凄凉悲凉哀伤悲痛凄惨惨烈残酷';
const TENSION_WORDS = '危险紧张激烈冲突战斗对抗威胁杀戮死亡鲜血危机紧迫突然急速猛烈';
const CALM_WORDS = '平静安宁祥和宁静安详淡然从容悠闲舒适平和温和';

function analyzeEmotionCurve(text) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 3) return { curve: [], dominantEmotion: 'unknown', emotionalRange: 0 };

  const curve = paragraphs.slice(0, 50).map((para) => {
    let positive = 0, negative = 0, tension = 0, calm = 0;
    for (const ch of POSITIVE_WORDS) if (para.includes(ch)) positive++;
    for (const ch of NEGATIVE_WORDS) if (para.includes(ch)) negative++;
    for (const ch of TENSION_WORDS) if (para.includes(ch)) tension++;
    for (const ch of CALM_WORDS) if (para.includes(ch)) calm++;
    const total = positive + negative + tension + calm || 1;
    return {
      positive: Math.round((positive / total) * 100),
      negative: Math.round((negative / total) * 100),
      tension: Math.round((tension / total) * 100),
      calm: Math.round((calm / total) * 100),
      dominant: ['positive', 'negative', 'tension', 'calm'][[positive, negative, tension, calm].indexOf(Math.max(positive, negative, tension, calm))]
    };
  });

  const avgPositive = Math.round(curve.reduce((s, c) => s + c.positive, 0) / curve.length);
  const avgNegative = Math.round(curve.reduce((s, c) => s + c.negative, 0) / curve.length);
  const avgTension = Math.round(curve.reduce((s, c) => s + c.tension, 0) / curve.length);
  const avgCalm = Math.round(curve.reduce((s, c) => s + c.calm, 0) / curve.length);

  const max = Math.max(avgPositive, avgNegative, avgTension, avgCalm);
  const min = Math.min(avgPositive, avgNegative, avgTension, avgCalm);
  const emotionalRange = max - min;

  const emotions = { positive: avgPositive, negative: avgNegative, tension: avgTension, calm: avgCalm };
  const dominantEmotion = Object.keys(emotions).find((k) => emotions[k] === max);

  return { curve, dominantEmotion, emotionalRange, averages: emotions };
}

// ===== 角色对话风格提取（新增） =====

function extractCharacterVoices(text) {
  const dialogues = String(text || '').match(/[""''「」『』].*?[""''「」』』]/g) || [];
  if (dialogues.length < 5) return [];

  // 尝试从对话前文提取说话者
  const verbPattern = /(?:道|说|笑道|冷道|怒道|喊道|低声道|沉声道|淡淡道|冷冷道|微笑道|苦笑道|叹道|问道|答道|叫道|吼道|哼道|嘀咕道|呢喃道|喃喃道|轻声道|惊呼|大喝)[，,。]/;
  const voices = {};

  for (const dialogue of dialogues) {
    const idx = text.indexOf(dialogue);
    if (idx < 0) continue;
    // 对话之后 30 字符内找说话者动词
    const after = text.slice(idx + dialogue.length, idx + dialogue.length + 30);
    const vMatch = after.match(verbPattern);
    if (!vMatch) continue;
    // 对话之前找名字
    const before = text.slice(Math.max(0, idx + dialogue.length), idx + dialogue.length + vMatch.index);
    // 提取紧邻动词前的 2-4 个中文字
    const nameMatch = before.match(/([\u4e00-\u9fa5]{2,4})$/);
    if (nameMatch) {
      let name = nameMatch[1];
      // 过滤掉误捕获的非人名词
      const stopWords = ['轻声', '低声', '沉声', '淡淡', '冷冷', '微笑', '苦笑', '惊呼', '大喝', '转身', '身形', '站起身来', '的声音', '的声音从', '声音从', '身来', '起身', '跪在', '飞身', '飞身挡', '挡在', '紧随', '紧随其'];
      let isStop = false;
      for (const sw of stopWords) {
        if (name === sw || name.includes('的声音') || name.includes('身来') || name.includes('起身') || name.includes('转身') || name.endsWith('身来')) {
          isStop = true;
          break;
        }
      }
      if (isStop || name.length < 2) continue;
      // 尝试修复：如果前一个字符是姓氏用字，加上它
      const fullBefore = text.slice(Math.max(0, idx + dialogue.length + vMatch.index - 6), idx + dialogue.length + vMatch.index);
      const surnameMatch = fullBefore.match(/([赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟黄穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴])([\u4e00-\u9fa5]{1,2})$/);
      if (surnameMatch && surnameMatch[2] === name) {
        name = surnameMatch[1] + name;
      }
      if (!voices[name]) voices[name] = { dialogues: [], avgLength: 0, totalChars: 0 };
      voices[name].dialogues.push(dialogue);
      voices[name].totalChars += countChars(dialogue);
    }
  }

  // 分析每个角色的对话风格
  const result = Object.entries(voices).map(([name, data]) => {
    const avgLen = Math.round(data.totalChars / data.dialogues.length);
    const allText = data.dialogues.join('');
    const hasQuestion = /[？?]/.test(allText);
    const hasExclaim = /[！!]/.test(allText);
    const hasEllipsis = /…/.test(allText);

    let style = '';
    if (avgLen < 10) style = '言简意赅';
    else if (avgLen > 30) style = '话多啰嗦';
    else style = '正常长度';
    if (hasQuestion) style += '，善用反问';
    if (hasExclaim) style += '，情绪外露';
    if (hasEllipsis) style += '，欲言又止';

    return {
      name,
      dialogueCount: data.dialogues.length,
      avgLength: avgLen,
      style,
      samples: data.dialogues.slice(0, 3)
    };
  });

  // 按对话数量排序
  result.sort((a, b) => b.dialogueCount - a.dialogueCount);
  return result.slice(0, 10);
}

// ===== 词汇丰富度分析（新增） =====

function analyzeVocabularyRichness(text) {
  const clean = String(text || '').replace(/[\s\n\r，。！？、；：""''《》【】（）().,!?;:\-—…]/g, '');
  if (clean.length < 100) return { uniqueRatio: 0, totalChars: clean.length, uniqueChars: 0 };

  const charSet = new Set(clean);
  const uniqueRatio = Math.round((charSet.size / clean.length) * 1000) / 10;

  const bigrams = bigramFreq(text);
  const bigramCount = Object.keys(bigrams).length;
  const totalBigrams = Object.values(bigrams).reduce((a, b) => a + b, 0);
  const bigramDiversity = Math.round((bigramCount / Math.max(totalBigrams, 1)) * 1000) / 10;

  return {
    uniqueRatio,
    totalChars: clean.length,
    uniqueChars: charSet.size,
    bigramDiversity,
    totalBigramTypes: bigramCount
  };
}

// ===== 高频词性分析（新增） =====

function analyzeWordPatterns(text) {
  const patterns = {
    action: (String(text).match(/走|跑|跳|打|踢|抓|推|拉|砍|刺|挥|冲|退|转|站|坐|蹲|跪|躺|爬|跌/g) || []).length,
    emotion: (String(text).match(/笑|哭|怒|惊|惧|喜|悲|愁|忧|恨|爱|慕|怨|叹|怔|愣|颤|抖/g) || []).length,
    sense_visual: (String(text).match(/看|望|瞧|盯|瞥|凝视|注视|打量|观察|远眺|俯瞰|仰望/g) || []).length,
    sense_auditory: (String(text).match(/听|闻声|声响|声音|轰鸣|轰|响|叫|喊|吼|嘶|鸣|嗡/g) || []).length,
    sense_tactile: (String(text).match(/摸|触|碰|握|抓|抚|捏|按|拍|揉|冰冷|滚烫|柔软|坚硬/g) || []).length,
    time: (String(text).match(/忽然|突然|瞬间|刹那|片刻|许久|良久|随即|旋即|不久|片刻后|霎时|顿时/g) || []).length,
    space: (String(text).match(/前方|后方|左右|远处|近处|上方|下方|周围|四面|身后|面前|眼前|头顶|脚下/g) || []).length,
    cognition: (String(text).match(/想|思考|回忆|记得|忘记|意识到|明白|理解|疑惑|猜测|推断|判断|决定/g) || []).length
  };
  const total = countChars(text) || 1;
  const per1k = {};
  for (const [k, v] of Object.entries(patterns)) {
    per1k[k] = Math.round((v / total) * 1000);
  }
  return { raw: patterns, perThousand: per1k };
}

// ===== 章节结构模式分析（新增） =====

function analyzeChapterStructure(text) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 5) return { structure: 'unknown', openingType: 'unknown', closingType: 'unknown' };

  const firstPara = paragraphs[0];
  const lastPara = paragraphs[paragraphs.length - 1];

  let openingType = 'unknown';
  if (/[""''「」]/.test(firstPara.slice(0, 20))) openingType = 'dialogue';
  else if (firstPara.length < 30) openingType = 'short_hook';
  else if (/天气|风|雨|雪|阳光|月|天|云/.test(firstPara.slice(0, 50))) openingType = 'scene_setting';
  else if (/忽然|突然|就在|那一刻|那一瞬间/.test(firstPara.slice(0, 50))) openingType = 'action_hook';
  else openingType = 'narrative';

  let closingType = 'unknown';
  if (/[""''「」]/.test(lastPara.slice(-20))) closingType = 'dialogue_end';
  else if (/……|…/.test(lastPara.slice(-10))) closingType = 'ellipsis_end';
  else if (/[？?]/.test(lastPara.slice(-10))) closingType = 'question_end';
  else if (lastPara.length < 20) closingType = 'short_end';
  else closingType = 'narrative_end';

  // 结构模式：对话-叙述比例变化
  const sections = [];
  const chunkSize = Math.max(1, Math.floor(paragraphs.length / 5));
  for (let i = 0; i < paragraphs.length; i += chunkSize) {
    const chunk = paragraphs.slice(i, i + chunkSize).join('');
    const dialogueRatio = analyzeDialogue(chunk).ratio;
    sections.push(dialogueRatio);
  }

  let structure = 'balanced';
  if (sections[0] > 40 && sections[sections.length - 1] > 40) structure = 'dialogue_frame';
  else if (sections[0] < 15 && sections[sections.length - 1] < 15) structure = 'narrative_frame';
  else if (sections[0] > 30 && sections[sections.length - 1] < 15) structure = 'dialogue_to_narrative';
  else if (sections[0] < 15 && sections[sections.length - 1] > 30) structure = 'narrative_to_dialogue';

  return { structure, openingType, closingType, dialogueFlow: sections };
}

/**
 * 离线分析小说文本，输出结构化风格报告（增强版）
 */
export function offlineAnalyzeStyle(text) {
  const clean = String(text || '');
  if (!clean.trim()) return null;

  const sentences = splitSentences(clean);
  const sentLen = analyzeSentenceLength(sentences);
  const punct = analyzePunctuation(clean);
  const dialogue = analyzeDialogue(clean);
  const genreHints = detectGenreHints(clean);
  const styleFeatures = detectStyleFeatures(clean);
  const topBigrams = topN(bigramFreq(clean), 30);
  const topTrigrams = topN(trigramFreq(clean), 20);

  // 新增分析
  const ngramModel = buildNgramModel(clean, 2);
  const paraRhythm = analyzeParagraphRhythm(clean);
  const emotionCurve = analyzeEmotionCurve(clean);
  const charVoices = extractCharacterVoices(clean);
  const vocabRichness = analyzeVocabularyRichness(clean);
  const wordPatterns = analyzeWordPatterns(clean);
  const chapterStruct = analyzeChapterStructure(clean);

  // 生成伪文本样本
  const sampleText = ngramModel ? generateFromModel(ngramModel, 40) : '';

  const report = {
    writing_style: styleFeatures.join('；') + '。' +
      `平均句长${sentLen.avg}字，` +
      `短句占比${Math.round((sentLen.short / Math.max(sentences.length, 1)) * 100)}%，` +
      `长句占比${Math.round((sentLen.long / Math.max(sentences.length, 1)) * 100)}%。` +
      (paraRhythm.pace === 'fast' ? '段落短促，节奏明快。' : paraRhythm.pace === 'slow' ? '段落绵长，节奏舒缓。' : '段落节奏中等。') +
      (vocabRichness.uniqueRatio > 30 ? '用字丰富多样。' : '用字集中，风格统一。') +
      (sampleText ? `基于 N-gram 模型生成的文风样本：${sampleText}` : ''),
    plot_patterns: `对话占比${dialogue.ratio}%，` +
      (dialogue.ratio > 30 ? '剧情以角色对话推进为主。' : dialogue.ratio < 10 ? '剧情以叙述描写推进为主。' : '叙述与对话均衡推进。') +
      `每段对话平均${dialogue.avgLength}字。` +
      `章节结构模式：${chapterStruct.structure}，` +
      `开头类型：${chapterStruct.openingType}，结尾类型：${chapterStruct.closingType}。` +
      (emotionCurve.dominantEmotion !== 'unknown' ? `情绪基调以${{positive:'积极',negative:'消极',tension:'紧张',calm:'平静'}[emotionCurve.dominantEmotion]}为主，情绪波动幅度${emotionCurve.emotionalRange > 30 ? '大' : '小'}。` : ''),
    logic_rules: '从文本统计特征推断：' +
      (punct.perThousand.question > 8 ? '善用疑问句制造悬念；' : '') +
      (punct.perThousand.ellipsis > 5 ? '善用省略号留白；' : '') +
      (sentLen.avg < 20 ? '善用短句制造紧张节奏；' : '') +
      (wordPatterns.perThousand.time > 10 ? '时间过渡词使用频繁，节奏紧凑；' : '') +
      (wordPatterns.perThousand.cognition > 8 ? '内心活动描写较多，注重角色心理；' : '') +
      '注意保持角色行为逻辑一致，因果关系清晰。',
    worldview: genreHints.length ? `从用词特征推断题材倾向：${genreHints.join('、')}。世界观构建需符合该题材的常见设定规律。` : '无法明确判断题材，需结合上下文分析。',
    character_craft: `全书共${sentences.length}个句子，` +
      `高频词包括：${topBigrams.slice(0, 5).map((b) => b.word).join('、')}。` +
      (dialogue.count > 0 ? `全书约${dialogue.count}处对话，平均每处${dialogue.avgLength}字。` : '对话较少，以旁白叙述为主。') +
      (charVoices.length ? `提取到${charVoices.length}个角色的对话风格：${charVoices.map((c) => `${c.name}(${c.style})`).join('，')}。` : '') +
      (wordPatterns.perThousand.action > 15 ? '动作描写丰富，画面感强。' : '') +
      (wordPatterns.perThousand.emotion > 12 ? '情绪描写密集，注重角色内心。' : ''),
    repliclicable_techniques: styleFeatures.slice(0, 3).join('；') + '。' +
      `标点使用习惯：逗号${punct.perThousand.comma}/千字、句号${punct.perThousand.period}/千字。` +
      `高频三字词：${topTrigrams.slice(0, 5).map((t) => t.word).join('、')}。` +
      `词汇丰富度：${vocabRichness.uniqueRatio}%（去重字符占比）。` +
      `动作词频${wordPatterns.perThousand.action}/千字，情绪词频${wordPatterns.perThousand.emotion}/千字。`,
    _meta: {
      total_chars: countChars(clean),
      sentence_count: sentences.length,
      avg_sentence_length: sentLen.avg,
      sentence_variance: sentLen.variance,
      dialogue_ratio: dialogue.ratio,
      detected_genres: genreHints,
      top_bigrams: topBigrams.slice(0, 15).map((b) => b.word),
      top_trigrams: topTrigrams.slice(0, 10).map((t) => t.word),
      punctuation_per_1k: punct.perThousand,
      sentence_distribution: sentLen.distribution,
      paragraph_rhythm: paraRhythm,
      emotion_curve: {
        dominant: emotionCurve.dominantEmotion,
        range: emotionCurve.emotionalRange,
        averages: emotionCurve.averages,
        curve_length: emotionCurve.curve?.length || 0
      },
      character_voices: charVoices.map((c) => ({ name: c.name, count: c.dialogueCount, avgLen: c.avgLength, style: c.style })),
      vocabulary_richness: vocabRichness,
      word_patterns_per_1k: wordPatterns.perThousand,
      chapter_structure: chapterStruct,
      ngram_model: ngramModel ? { contextCount: ngramModel.contextCount, sampleText } : null
    }
  };
  return report;
}

/**
 * 离线风格学习 — 从已有章节中提取写作风格指南
 * 生成与 AI 分析相同格式的 JSON，供 style_baseline 使用
 */
export function offlineLearnNovelStyle(novelId) {
  const chapters = db.prepare("SELECT content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novelId);
  if (!chapters.length) return null;
  const fullText = chapters.map((c) => c.content).join('\n\n').slice(0, 50000);
  if (!fullText) return null;

  const sentences = splitSentences(fullText);
  const paragraphs = splitParagraphs(fullText);
  const avgSentLen = sentences.length ? sentences.reduce((s, x) => s + x.length, 0) / sentences.length : 0;
  const avgParaLen = paragraphs.length ? paragraphs.reduce((s, x) => s + x.length, 0) / paragraphs.length : 0;
  const sentenceLengths = sentences.map((s) => s.length).sort((a, b) => a - b);
  const shortRatio = sentenceLengths.filter((l) => l <= 15).length / Math.max(1, sentenceLengths.length);
  const longRatio = sentenceLengths.filter((l) => l >= 40).length / Math.max(1, sentenceLengths.length);
  const dialogueCount = (fullText.match(/[""]/g) || []).length / 2;
  const dialogueRatio = dialogueCount / Math.max(1, sentences.length);

  // 词频统计
  const wordFreq = {};
  for (const s of sentences) {
    for (const w of s.match(/[\u4e00-\u9fff]{2,4}/g) || []) {
      wordFreq[w] = (wordFreq[w] || 0) + 1;
    }
  }
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map((e) => e[0]);

  // 标点频率
  const commaCount = (fullText.match(/，/g) || []).length;
  const periodCount = (fullText.match(/。/g) || []).length;
  const exclaimCount = (fullText.match(/[！!]/g) || []).length;
  const questionCount = (fullText.match(/[？?]/g) || []).length;
  const ellipsisCount = (fullText.match(/…/g) || []).length;

  const result = {
    narrative_voice: `叙述以第三人称为主，叙述者与故事保持适中距离，句子平均${Math.round(avgSentLen)}字`,
    sentence_rhythm: `短句占比${Math.round(shortRatio * 100)}%，长句占比${Math.round(longRatio * 100)}%，${shortRatio > 0.3 ? '偏短促有力' : longRatio > 0.3 ? '偏长句铺陈' : '长短交替'}`,
    dialogue_style: `对话占比约${Math.round(dialogueRatio * 100)}%，${dialogueRatio > 0.4 ? '对话密集' : dialogueRatio > 0.2 ? '对话适中' : '以叙述为主'}`,
    description_preference: `段落平均${Math.round(avgParaLen)}字，${avgParaLen > 200 ? '描写详细' : avgParaLen > 100 ? '描写适中' : '描写精简'}`,
    emotion_handling: `感叹号占比${Math.round(exclaimCount / Math.max(1, periodCount) * 100)}%，问号占比${Math.round(questionCount / Math.max(1, periodCount) * 100)}%，${exclaimCount > periodCount * 0.3 ? '情绪外放' : '情绪克制'}`,
    pacing: `省略号${ellipsisCount}次，${ellipsisCount > sentences.length * 0.1 ? '节奏偏缓，留白多' : '节奏紧凑'}`,
    vocabulary_tier: `高频词：${topWords.slice(0, 10).join('、')}`,
    taboo: '避免使用：总之、综上所述、与此同时、值得一提的是、不难看出、可以说、然而、某种程度上',
    opening_habit: '从具体场景或动作切入',
    ending_habit: '留悬念或平缓收束',
    writing_guide: [
      `句子平均${Math.round(avgSentLen)}字，${shortRatio > 0.3 ? '多用短句制造节奏感' : '保持长短交替'}`,
      `对话占比${Math.round(dialogueRatio * 100)}%，${dialogueRatio > 0.3 ? '多用对话推进剧情' : '以叙述为主'}`,
      `段落平均${Math.round(avgParaLen)}字，保持段落长度错落`,
      `逗号与句号比例约${Math.round(commaCount / Math.max(1, periodCount))}:1`,
      '避免书面套话和AI腔',
    ],
    offline_stats: {
      total_sentences: sentences.length,
      total_paragraphs: paragraphs.length,
      avg_sentence_length: Math.round(avgSentLen),
      avg_paragraph_length: Math.round(avgParaLen),
      short_sentence_ratio: Math.round(shortRatio * 100),
      long_sentence_ratio: Math.round(longRatio * 100),
      dialogue_ratio: Math.round(dialogueRatio * 100),
      comma_count: commaCount,
      period_count: periodCount,
      exclamation_count: exclaimCount,
      question_count: questionCount,
      ellipsis_count: ellipsisCount,
      top_words: topWords,
    }
  };
  return result;
}

