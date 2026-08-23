import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// 使用临时数据目录，避免污染 src/data 下的真实库
process.env.NOVEL_DATA_DIR = '/tmp/novel-test-data';

let scan;
before(async () => {
  const m = await import('../src/lib.js');
  scan = m.scanAiPatterns;
});

test('真人风格文本不命中 AI 黑名单', () => {
  const human = `他蹲在门槛上，把烟屁股在鞋底碾灭。
王婶从巷口挑着两桶水回来，桶里晃着傍晚的云。他帮着把水倒进缸里，缸底的水花翻起来，又慢慢沉下去。
"吃饭没？"王婶问。
"没呢，等您那锅红薯。"他往灶台那边看了一眼，火膛里柴火噼啪响。`;
  const hits = scan(human);
  const bad = hits.filter((h) => h.word.includes('仿佛') || h.word.includes('宛如') || h.word.includes('不禁'));
  assert.equal(bad.length, 0);
});

test('命中 AI 高频词被检出', () => {
  const ai = '他不禁微微一怔，眸底闪过一道精光，仿佛整个世界都凝固了。';
  const hits = scan(ai);
  const words = hits.map((h) => h.word);
  assert.ok(words.some((w) => w.includes('仿佛')), `应命中仿佛，实际: ${words.join(',')}`);
  assert.ok(words.some((w) => w.includes('微微一怔')), `应命中微微一怔，实际: ${words.join(',')}`);
});

test('省略号堆叠被检出', () => {
  const hits = scan('他看着远处…………，然后又说……，最后全都散了。');
  const words = hits.map((h) => h.word);
  assert.ok(words.some((w) => w.includes('省略号堆叠')), `words=${words.join(',')}`);
});

test('感叹号连用被检出', () => {
  const hits = scan('快跑！！');
  const words = hits.map((h) => h.word);
  assert.ok(words.some((w) => w.includes('感叹号连用')));
});

test('干净文本不因段落碎片化被误伤', () => {
  const normal = Array.from({ length: 8 }, (_, i) => `第${i + 1}段：他今天去了县城的集市，把卖粮赚的钱换了两斤肉和一小包盐，回来的路上走得快，因为天边那块乌云压得越来越低。`).join('\n\n');
  const hits = scan(normal);
  assert.equal(hits.length, 0, `不应误报，实际命中: ${JSON.stringify(hits)}`);
});

test('短句碎片化被检出', () => {
  const frag = ['他很累。', '他坐下。', '他喝茶。', '他发呆。', '他抬头。', '他困了。'].join('\n'.repeat(2));
  const hits = scan(frag);
  const words = hits.map((h) => h.word);
  assert.ok(words.some((w) => w.includes('碎片')), `words=${words.join(',')}`);
});