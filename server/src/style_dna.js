import { analyzeStyleStats } from './offline_learn.js';

/**
 * 风格 DNA — 数值化文风画像
 * - computeStyleDNA: 从文本提取统计特征（复用 offline_learn 纯统计引擎）
 * - mergeDNA: 多风格 DNA 按权重融合
 * - compareDNA: 成章与目标 DNA 的偏差评分（0-100，越小越匹配）
 * - formatDNABlock: 紧凑 prompt 注入块
 */

export const DNA_DIMS = [
  { key: 'avg_sentence_length', label: '平均句长', weight: 0.2, unit: '字', relative: true },
  { key: 'short_sentence_ratio', label: '短句占比', weight: 0.1, unit: '%', relative: false },
  { key: 'long_sentence_ratio', label: '长句占比', weight: 0.1, unit: '%', relative: false },
  { key: 'dialogue_ratio', label: '对话占比', weight: 0.2, unit: '%', relative: false },
  { key: 'avg_paragraph_length', label: '段落均长', weight: 0.15, unit: '字', relative: true },
  { key: 'comma_period_ratio', label: '逗句比', weight: 0.05, unit: '', relative: true },
  { key: 'exclaim_per_1k', label: '感叹号/千字', weight: 0.05, unit: '', relative: false },
  { key: 'question_per_1k', label: '问号/千字', weight: 0.05, unit: '', relative: false },
  { key: 'action_words_per_1k', label: '动作词/千字', weight: 0.05, unit: '', relative: true },
  { key: 'emotion_words_per_1k', label: '情绪词/千字', weight: 0.05, unit: '', relative: true }
];

export function computeStyleDNA(text) {
  return analyzeStyleStats(text);
}

/**
 * 多风格 DNA 融合：数值取加权平均（权重相等时即平均），top_bigrams 取并集前 10
 */
export function mergeDNA(list) {
  const valid = (Array.isArray(list) ? list : []).filter((d) => d && typeof d === 'object');
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  const merged = {};
  for (const dim of DNA_DIMS) {
    const vals = valid.map((d) => Number(d[dim.key]) || 0);
    merged[dim.key] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }
  const words = [];
  for (const d of valid) {
    for (const w of Array.isArray(d.top_bigrams) ? d.top_bigrams : []) {
      if (!words.includes(w)) words.push(w);
    }
  }
  merged.top_bigrams = words.slice(0, 10);
  return merged;
}

/**
 * 偏差评分：0-100，数值越小越匹配目标 DNA。
 * 相对维度用相对偏差，占比维度用绝对差归一化，逐维加权求和后放大到百分制。
 */
export function compareDNA(target, actual) {
  if (!target || !actual) return null;
  let totalWeight = 0;
  let weightedDev = 0;
  const details = [];
  for (const dim of DNA_DIMS) {
    const t = Number(target[dim.key]);
    const a = Number(actual[dim.key]);
    if (!Number.isFinite(t) || !Number.isFinite(a)) continue;
    totalWeight += dim.weight;

    let dev;
    if (dim.relative) {
      dev = t === 0 ? (a === 0 ? 0 : 1) : Math.min(Math.abs(a - t) / Math.abs(t), 1);
    } else {
      const norm = Math.max(Math.abs(t), 10);
      dev = Math.min(Math.abs(a - t) / norm, 1);
    }
    weightedDev += dev * dim.weight;
    details.push({
      dim: dim.key,
      label: dim.label,
      target: t,
      actual: a,
      unit: dim.unit,
      deviation: Math.round(dev * 100)
    });
  }
  if (!totalWeight) return { score: 0, details: [] };
  const score = Math.min(100, Math.round((weightedDev / totalWeight) * 100 * 1.5));
  details.sort((x, y) => y.deviation - x.deviation);
  return { score, details };
}

/**
 * 紧凑注入块：让模型知道目标文风的量化指标
 */
export function formatDNABlock(dna) {
  if (!dna || typeof dna !== 'object') return '';
  const t = (key, digits = 0) => {
    const v = Number(dna[key]);
    return Number.isFinite(v) ? v.toFixed(digits) : '-';
  };
  const paceMap = { fast: '段落短促节奏快', medium: '段落节奏适中', slow: '段落绵长节奏缓' };
  const lines = [
    `平均句长${t('avg_sentence_length', 1)}字（短句占比${t('short_sentence_ratio')}%、长句占比${t('long_sentence_ratio')}%），`,
    `对话占正文${t('dialogue_ratio')}%，段落平均${t('avg_paragraph_length')}字（${paceMap[dna.paragraph_pace] || ''}），`,
    `逗句比${t('comma_period_ratio', 1)}:1，感叹号${t('exclaim_per_1k')}/千字、问号${t('question_per_1k')}/千字，`,
    `动作词${t('action_words_per_1k')}/千字、情绪词${t('emotion_words_per_1k')}/千字。`
  ];
  if (Array.isArray(dna.top_bigrams) && dna.top_bigrams.length) {
    lines.push(`高频词：${dna.top_bigrams.slice(0, 8).join('、')}。`);
  }
  return `【目标文风量化指标（本作风格 DNA，写作时按这些数值控制语感）】
${lines.join('\n')}
写作后请自查：句子长短、对话密度、段落节奏应向上述数值靠拢。`;
}

/**
 * 把偏差明细转成可执行的润色指令（供按 DNA 重润使用）
 */
export function buildDNAPolishInstructions(comparison) {
  if (!comparison?.details?.length) return '';
  const significant = comparison.details.filter((d) => d.deviation >= 20);
  if (!significant.length) return '';
  const lines = significant.slice(0, 5).map((d) => {
    const direction = Number(d.actual) > Number(d.target) ? '偏高' : '偏低';
    const target = Number(d.target);
    const actual = Number(d.actual);
    const delta = target !== 0 && Math.abs(target) >= Math.abs(actual)
      ? `目标 ${d.target}${d.unit}，当前 ${d.actual}${d.unit}`
      : `当前 ${d.actual}${d.unit}，目标 ${d.target}${d.unit}`;
    let action = '';
    if (d.dim === 'avg_sentence_length') action = direction === '偏高' ? '多用短句，把长句拆分' : '适当合并短句，增加铺陈';
    else if (d.dim === 'dialogue_ratio') action = direction === '偏高' ? '减少对话篇幅，改为叙述描写' : '增加人物对话推进剧情';
    else if (d.dim === 'avg_paragraph_length') action = direction === '偏高' ? '把大段落拆小' : '合并零碎段落，充实描写';
    else if (d.dim === 'short_sentence_ratio') action = direction === '偏高' ? '减少超短句' : '适当增加短句制造节奏';
    else if (d.dim === 'long_sentence_ratio') action = direction === '偏高' ? '减少超长句' : '允许少量长句铺陈';
    else action = `向目标值调整`;
    return `- ${d.label}${direction}（${delta}）：${action}`;
  });
  return `【文风偏差修正（基于风格 DNA 对比，请按以下维度改写）】\n${lines.join('\n')}`;
}
