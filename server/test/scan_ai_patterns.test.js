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
test('模糊量词堆叠被检出（密度超阈值）', () => {
  // 生成 >1000 字文本，密集塞入「一丝/一抹/一股」
  let txt = '他站在巷口看着那扇门。'.repeat(3);
  txt += '一丝不安。一抹冷笑。一股寒意。一丝疑虑。一抹红晕。一丝苦涩。一股焦味。一丝光亮。一抹残阳。一股土腥味。';
  txt += '他想起白天的事，又把这念头压下去，接着往前走，路过修车铺，老板在收摊，卷帘门哗啦啦响，他没停，拐进了另一条巷子，巷子更深，灯也更暗，脚下的石板松了一块，踩上去哐当响。'.repeat(16);
  const hits = scan(txt);
  const words = hits.map((h) => h.word);
  assert.ok(words.some((w) => w.includes('模糊量词堆叠')), `words=${words.join('|')}`);
});

test('正常量词密度不误报', () => {
  const txt = `老周把车支在路边，用袖子擦了擦车座。巷子里飘着谁家炖肉的香味，他咽了口唾沫，推车进了院。
"回来啦？"屋里媳妇在剥豆角，头也没抬。
"嗯。"他把车靠墙放好，从兜里摸出两张皱巴巴的票子放在桌上，"这个月奖金。"
媳妇手停了一下，没说话，把豆角扔进盆里，水花溅出来几点。
他脱了外套挂在门后，坐下，端起凉茶喝了一大口。茶是中午剩的，有点馊，他还是喝完了。`;
  const hits = scan(txt);
  const words = hits.map((h) => h.word);
  assert.ok(!words.some((w) => w.includes('模糊量词堆叠')), `不应误报，实际: ${words.join('|')}`);
});

test('近距离重复用词被检出', () => {
  // 同一实义词「梧桐」在窗口内密集出现
  let txt = '夜深了，他沿着河边走，路灯把影子拉得老长，风从河面上过来，带着水腥气。'.repeat(2);
  txt += '梧桐叶落在肩上。他捡起一片梧桐叶，又抬头看那棵梧桐树。梧桐树很老了，树皮裂开，梧桐籽掉了一地。';
  txt += '他站了一会儿，把叶子夹进书里，继续往前走，走过桥头，桥头有个夜宵摊，摊主在收凳子，收音机里放着评书，他听了一句，是单田芳的嗓子，又往前走，河对岸的楼亮着零星几户灯。'.repeat(17);
  const hits = scan(txt);
  const words = hits.map((h) => h.word);
  assert.ok(words.some((w) => w.includes('近距离重复用词')), `words=${words.join('|')}`);
});
