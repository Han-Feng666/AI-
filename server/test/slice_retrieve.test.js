import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// 独立临时库，避免污染真实数据
process.env.NOVEL_DATA_DIR = '/tmp/novel-slices-test-data';

let db;
let preClassify, sliceText, extractKeywords, saveStyleSlices, getStyleSlices;
let retrieveFromSlices, getNovelStyleSnippets, getNovelKnowledgeSnippets, SCENE_TAGS;
let saveSamples;

before(async () => {
  ({ db } = await import('../src/db.js'));
  const store = await import('../src/slice_store.js');
  preClassify = store.preClassify;
  sliceText = store.sliceText;
  extractKeywords = store.extractKeywords;
  saveStyleSlices = store.saveStyleSlices;
  getStyleSlices = store.getStyleSlices;
  retrieveFromSlices = store.retrieveFromSlices;
  getNovelStyleSnippets = store.getNovelStyleSnippets;
  getNovelKnowledgeSnippets = store.getNovelKnowledgeSnippets;
  SCENE_TAGS = store.SCENE_TAGS;
  ({ saveSamples } = await import('../src/knowledge_store.js'));
});

test('SCENE_TAGS 枚举完整', () => {
  assert.deepEqual(SCENE_TAGS, ['对话', '动作/打斗', '心理', '环境', '开篇', '悬念/转折', '日常', '情绪高潮']);
});

test('preClassify 规则命中与日常兜底', () => {
  const dialog = preClassify('她低声道："今晚你别走了。"');
  assert.ok(dialog.includes('对话'));
  const fight = preClassify('他一剑挥出，刀光血溅，身形暴退三丈。');
  assert.ok(fight.includes('动作/打斗'));
  const inner = preClassify('他心中暗想，念头一转，决定先走一步。');
  assert.ok(inner.includes('心理'));
  const plain = preClassify('他们坐下来吃了顿饭，聊了聊天气。');
  assert.deepEqual(plain, ['日常']);
});

test('sliceText 空文本返回空数组', () => {
  assert.deepEqual(sliceText(''), []);
  assert.deepEqual(sliceText('   \n\n  '), []);
  assert.deepEqual(sliceText(null), []);
});

test('sliceText 每片不超过 maxLen 且覆盖首尾内容', () => {
  const paras = Array.from({ length: 30 }, (_, i) => `第${i}段，`.repeat(40) + `结尾标记${i}。`);
  const text = paras.join('\n');
  const slices = sliceText(text, { minLen: 100, maxLen: 600, limit: 100 });
  assert.ok(slices.length > 1, `应产生多个切片，实际 ${slices.length}`);
  for (const s of slices) {
    assert.ok(s.text.length <= 600, `切片应不超过 600 字，实际 ${s.text.length}`);
  }
  const joined = slices.map((s) => s.text).join('\n');
  assert.ok(joined.includes('第0段'), '开头内容应被保留');
  assert.ok(joined.includes('结尾标记29'), '结尾内容应被保留');
  assert.deepEqual(slices.map((s) => s.slice_index), slices.map((_, i) => i));
});

test('sliceText 超过 limit 时按 40/30/30 抽样', () => {
  const paras = Array.from({ length: 200 }, (_, i) => `段落${i}，` + '内容填充'.repeat(60));
  const slices = sliceText(paras.join('\n'), { minLen: 100, maxLen: 500, limit: 50 });
  assert.ok(slices.length <= 50, `应不超过 limit=50，实际 ${slices.length}`);
});

test('extractKeywords 输出高频词空格串', () => {
  const text = ('剑光一闪，剑气纵横。').repeat(20);
  const kw = extractKeywords(text, 5);
  assert.equal(typeof kw, 'string');
  assert.ok(kw.length > 0, '重复文本应产出关键词');
});

test('saveStyleSlices/getStyleSlices 往返且无标签时规则兜底', () => {
  const info = db.prepare("INSERT INTO styles (name) VALUES (?)").run('切片测试风格');
  const styleId = info.lastInsertRowid;
  const slices = [
    { slice_index: 0, text: '他一剑挥出，刀光血溅。' },
    { slice_index: 1, text: '她低声说："你回来啦。"', scene_tags: ['对话'] }
  ];
  const n = saveStyleSlices(styleId, slices);
  assert.equal(n, 2);
  const rows = getStyleSlices(styleId);
  assert.equal(rows.length, 2);
  const first = JSON.parse(rows[0].scene_tags);
  assert.ok(first.includes('动作/打斗'), '未传标签时应规则兜底');
  assert.deepEqual(JSON.parse(rows[1].scene_tags), ['对话'], '显式标签应原样保存');
  assert.ok(rows[0].keywords.length > 0);
});

test('retrieveFromSlices 相关查询命中对应切片并按分数排序', () => {
  const info = db.prepare("INSERT INTO styles (name) VALUES (?)").run('检索测试风格');
  const styleId = info.lastInsertRowid;
  const slices = [
    { slice_index: 0, text: '修仙世界里他一剑挥出，剑气纵横三万里，剑光如虹，斗法千回合不分胜负。', keywords: '剑法 斗法 修仙' },
    { slice_index: 1, text: '都市爱情里他们约在咖啡馆，聊起了小时候的趣事，气氛温柔而甜蜜。', keywords: '爱情 咖啡馆' },
    { slice_index: 2, text: '夜色深沉，山间古寺的钟声悠悠荡开，月光洒在石阶上。', keywords: '环境 夜色 山林' }
  ];
  saveStyleSlices(styleId, slices);

  const hits = retrieveFromSlices('style_slices', [styleId], '剑光 剑气 斗法 修仙', { topK: 2, maxChars: 4000 });
  assert.ok(hits.length >= 1, '应至少命中一片');
  assert.equal(hits[0].slice_index, 0, `最高分应是修仙打斗片，实际 ${hits[0].slice_index}`);
  assert.ok(hits[0].score > 0);
});

test('retrieveFromSlices 尊重 maxChars 截断', () => {
  const info = db.prepare("INSERT INTO styles (name) VALUES (?)").run('截断测试风格');
  const styleId = info.lastInsertRowid;
  const bigText = '剑气纵横。'.repeat(200);
  saveStyleSlices(styleId, [
    { slice_index: 0, text: bigText, keywords: '剑法' },
    { slice_index: 1, text: bigText, keywords: '剑法' }
  ]);
  const hits = retrieveFromSlices('style_slices', [styleId], '剑法 剑气', { topK: 4, maxChars: 500 });
  const total = hits.reduce((a, s) => a + s.text.length, 0);
  assert.ok(total <= 500, `总字符应不超过 maxChars，实际 ${total}`);
});

test('retrieveFromSlices 无命中时按顺序兜底返回', () => {
  const info = db.prepare("INSERT INTO styles (name) VALUES (?)").run('兜底测试风格');
  const styleId = info.lastInsertRowid;
  saveStyleSlices(styleId, [
    { slice_index: 0, text: '完全无关的内容甲甲甲甲甲甲甲甲。', keywords: '' },
    { slice_index: 1, text: '完全无关的内容乙乙乙乙乙乙乙乙。', keywords: '' }
  ]);
  const hits = retrieveFromSlices('style_slices', [styleId], '緟遬泐燚龘齉', { topK: 2, maxChars: 3000 });
  assert.ok(hits.length >= 1, '乱码查询也应兜底返回切片');
  assert.equal(hits[0].score, 0, '兜底结果分数应为 0');
});

test('retrieveFromSlices 空入参安全返回', () => {
  assert.deepEqual(retrieveFromSlices('style_slices', [], '随便', {}), []);
  assert.deepEqual(retrieveFromSlices('style_slices', [999999], '随便', {}), []);
});

test('getNovelStyleSnippets 输出范文块并带场景标签', () => {
  const info = db.prepare("INSERT INTO styles (name) VALUES (?)").run('范文测试风格');
  const styleId = info.lastInsertRowid;
  saveStyleSlices(styleId, [
    { slice_index: 0, text: '他一剑挥出，刀光血溅，斗法正酣。', scene_tags: ['动作/打斗'] },
    { slice_index: 1, text: '她低声说："别走。"他站在原地，一动不动。', scene_tags: ['对话'] }
  ]);
  const { snippets, slices } = getNovelStyleSnippets([styleId], '挥剑 打斗 刀光', {});
  assert.ok(snippets.startsWith('[范文1]（动作/打斗）'));
  assert.ok(snippets.includes('一剑挥出'));
  assert.ok(slices.length >= 1, '相关查询应至少命中一片');
  assert.equal(slices[0].slice_index, 0);
  const empty = getNovelStyleSnippets([], '任意查询', {});
  assert.deepEqual(empty, { snippets: '', slices: [] });
});

test('getNovelKnowledgeSnippets 走 knowledge_samples 表', () => {
  const info = db.prepare("INSERT INTO knowledge_corpora (title, genre) VALUES (?, ?)").run('知识切片测试', '玄幻');
  const corpusId = info.lastInsertRowid;
  saveSamples(corpusId, [
    { slice_index: 0, text: '主角在斗气大陆一路修炼，从废柴逆袭成为斗帝，剧情热血。', scene_tags: ['日常'], keywords: '修炼 斗气 逆袭' },
    { slice_index: 1, text: '女主是冰山美人，与主角从敌对到相知，感情线细腻。', scene_tags: ['对话'], keywords: '感情线 女主' }
  ]);
  const { snippets, slices } = getNovelKnowledgeSnippets([corpusId], '修炼 斗气 逆袭 废柴', {});
  assert.ok(slices.length >= 1);
  assert.ok(snippets.includes('斗帝'));
  assert.ok(snippets.includes('女主') === false, '无关片（score=0）应被过滤，只返回相关命中');
  const empty = getNovelKnowledgeSnippets([], '任意', {});
  assert.deepEqual(empty, { snippets: '', slices: [] });
});
