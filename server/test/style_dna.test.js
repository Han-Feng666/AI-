import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DNA_DIMS,
  computeStyleDNA,
  mergeDNA,
  compareDNA,
  formatDNABlock,
  buildDNAPolishInstructions
} from '../src/style_dna.js';

// 两种风格差异明显的样本文本
const dialogueHeavy = Array.from({ length: 30 }, (_, i) =>
  `"这么晚了还不睡？"林然压低声音。\n"睡不着。"她别过脸。\n"在想什么？"\n"想你。"\n`
).join('');

const narrativeLong = Array.from({ length: 12 }, () =>
  '夜色像一块浸透了墨汁的绸缎，沉沉地压在这座古老的城市之上，街道两旁的梧桐树在晚风里轻轻摇晃，' +
  '沙沙的叶子声连成一片，仿佛无数细小的私语从遥远的岁月深处传来，路灯的光晕在湿漉漉的石板路上晕开，' +
  '像一朵一朵开败了的黄花，行人稀少，偶尔有一辆自行车碾过积水，惊起一圈一圈细碎的涟漪。\n\n'
).join('');

test('computeStyleDNA 输出覆盖所有 DNA 维度且取值合理', () => {
  const dna = computeStyleDNA(dialogueHeavy);
  assert.ok(dna, '非空文本应产出 DNA');
  for (const dim of DNA_DIMS) {
    assert.ok(Number.isFinite(dna[dim.key]), `维度 ${dim.key} 应为有限数值，实际 ${dna[dim.key]}`);
  }
  assert.ok(dna.dialogue_ratio >= 0 && dna.dialogue_ratio <= 100);
  assert.ok(dna.avg_sentence_length > 0);
  assert.ok(Array.isArray(dna.top_bigrams));
});

test('computeStyleDNA 空文本返回 null', () => {
  assert.equal(computeStyleDNA(''), null);
  assert.equal(computeStyleDNA('   \n  '), null);
  assert.equal(computeStyleDNA(null), null);
});

test('computeStyleDNA 对话密集文本的对话占比显著高于长叙述文本', () => {
  const a = computeStyleDNA(dialogueHeavy);
  const b = computeStyleDNA(narrativeLong);
  assert.ok(a.dialogue_ratio > b.dialogue_ratio + 20,
    `对话型占比 ${a.dialogue_ratio} 应显著高于叙述型 ${b.dialogue_ratio}`);
  assert.ok(b.avg_sentence_length > a.avg_sentence_length,
    `叙述型均句长 ${b.avg_sentence_length} 应大于对话型 ${a.avg_sentence_length}`);
});

test('mergeDNA 空入参返回 null，单元素原样返回', () => {
  assert.equal(mergeDNA([]), null);
  assert.equal(mergeDNA(null), null);
  const d = computeStyleDNA(dialogueHeavy);
  assert.equal(mergeDNA([d]), d);
});

test('mergeDNA 数值取平均且 top_bigrams 去重并集', () => {
  const a = computeStyleDNA(dialogueHeavy);
  const b = computeStyleDNA(narrativeLong);
  const m = mergeDNA([a, b]);
  assert.ok(m);
  const avg = (k) => Math.round(((Number(a[k]) + Number(b[k])) / 2) * 10) / 10;
  for (const dim of DNA_DIMS) {
    assert.equal(m[dim.key], avg(dim.key), `融合维度 ${dim.key} 应为两者平均`);
  }
  const union = [...new Set([...(a.top_bigrams || []), ...(b.top_bigrams || [])])];
  assert.ok(m.top_bigrams.length <= 10);
  assert.ok(m.top_bigrams.every((w) => union.includes(w)));
});

test('compareDNA 完全相同的 DNA 偏差为 0 分', () => {
  const d = computeStyleDNA(dialogueHeavy);
  const cmp = compareDNA(d, d);
  assert.ok(cmp);
  assert.equal(cmp.score, 0);
  assert.equal(cmp.details.length, DNA_DIMS.length);
  assert.ok(cmp.details.every((x) => x.deviation === 0));
});

test('compareDNA 风格迥异文本得分高且明细按偏差降序', () => {
  const target = computeStyleDNA(dialogueHeavy);
  const actual = computeStyleDNA(narrativeLong);
  const cmp = compareDNA(target, actual);
  assert.ok(cmp.score > 30, `差异大的两文本得分应超 30，实际 ${cmp.score}`);
  const devs = cmp.details.map((d) => d.deviation);
  const sorted = [...devs].sort((x, y) => y - x);
  assert.deepEqual(devs, sorted, '明细应按偏差从大到小排序');
});

test('compareDNA 缺参返回 null，维度缺失时跳过该维度', () => {
  assert.equal(compareDNA(null, {}), null);
  assert.equal(compareDNA({}, null), null);
  const partial = { avg_sentence_length: 20, dialogue_ratio: 30 };
  const cmp = compareDNA(partial, partial);
  assert.equal(cmp.score, 0);
  assert.equal(cmp.details.length, 2, '只应统计 target 中存在的维度');
});

test('formatDNABlock 包含量化指标与自查提示', () => {
  const dna = computeStyleDNA(dialogueHeavy);
  const block = formatDNABlock(dna);
  assert.ok(block.includes('目标文风量化指标'));
  assert.ok(block.includes('平均句长'));
  assert.ok(block.includes('对话占正文'));
  assert.ok(block.includes('高频词'));
  assert.equal(formatDNABlock(null), '');
  assert.equal(formatDNABlock('x'), '');
});

test('buildDNAPolishInstructions 低偏差返回空、高偏差给出行动指令', () => {
  const d = computeStyleDNA(dialogueHeavy);
  assert.equal(buildDNAPolishInstructions(compareDNA(d, d)), '', '零偏差不应生成指令');
  const cmp = compareDNA(computeStyleDNA(dialogueHeavy), computeStyleDNA(narrativeLong));
  const text = buildDNAPolishInstructions(cmp);
  assert.ok(text.includes('文风偏差修正'));
  assert.ok(text.includes('偏差'));
  assert.equal(buildDNAPolishInstructions(null), '');
});
