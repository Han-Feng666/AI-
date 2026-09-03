import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { extractInitialState, deobfuscate, loadDeobfMap, DEOBF_MIN_RATIO } = await import('../src/fanqie.js');

const FIXTURE_1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'fanqie_reader_1.html'), 'utf-8');
const FIXTURE_2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'fanqie_reader_2.html'), 'utf-8');

function stripState(html) {
  // 提取 SSR 正文并仅做标签清理（不做混淆还原），用于拿到「混淆态」输入
  const state = extractInitialState(html);
  return state.reader.chapterData;
}

describe('fanqie extractInitialState', () => {
  test('从真实阅读页 fixture 提取章节数据', () => {
    const state = extractInitialState(FIXTURE_1);
    assert.ok(state, '应解析出 __INITIAL_STATE__');
    assert.ok(state.reader?.chapterData?.content, '应包含正文 content');
    assert.ok(state.reader.chapterData.title, '应包含章节标题');
  });

  test('正文含私用区混淆字符', () => {
    const cd = stripState(FIXTURE_1);
    const hasPUA = [...cd.content].some((c) => {
      const code = c.codePointAt(0);
      return code >= 0xe000 && code <= 0xf8ff;
    });
    assert.ok(hasPUA, 'fixture 正文应包含私用区字符');
  });

  test('缺失 __INITIAL_STATE__ 时返回 null', () => {
    assert.equal(extractInitialState('<html><body>nothing</body></html>'), null);
    assert.equal(extractInitialState(''), null);
  });
});

describe('fanqie deobfuscate', () => {
  const { map } = loadDeobfMap();

  test('映射表非空', () => {
    assert.ok(Object.keys(map).length >= 362, '映射表应至少 362 条');
  });

  test('fixture 全部私用区字符均能命中映射表', () => {
    for (const fx of [FIXTURE_1, FIXTURE_2]) {
      const cd = stripState(fx);
      const pua = [...cd.content].filter((c) => {
        const code = c.codePointAt(0);
        return code >= 0xe000 && code <= 0xf8ff;
      });
      assert.ok(pua.length > 0);
      const missing = pua.filter((c) => !map['0x' + c.codePointAt(0).toString(16)]);
      assert.deepEqual(missing, [], '不应存在未映射的私用区字符');
    }
  });

  test('还原真实章节正文且无残留私用区字符', () => {
    const cd = stripState(FIXTURE_1);
    const r = deobfuscate(cd.content, map);
    assert.equal(r.residual, 0, '不应有无法还原的字符');
    assert.equal(r.ratio, 1);
    assert.ok(!/[\uE000-\uF8FF]/.test(r.text), '还原后不应残留私用区字符');
    assert.ok(r.text.includes('屋子中央'), `关键句应正确还原: ${r.text.slice(0, 60)}`);
    assert.ok(r.text.includes('十分繁复'));
    assert.ok(r.text.includes('愣了三秒'));
    assert.ok(!r.text.includes('image_domain'), '不应残留模板占位符');
    assert.ok(!/<img/i.test(r.text) && !/<p>/i.test(r.text), '不应残留 HTML 标签');
  });

  test('第二章节还原关键句', () => {
    const cd = stripState(FIXTURE_2);
    const r = deobfuscate(cd.content, map);
    assert.equal(r.residual, 0);
    assert.ok(r.text.includes('青银高速'));
    assert.ok(r.text.includes('一百二十迈'));
  });

  test('段落以换行分隔（供切片按段落聚合）', () => {
    const cd = stripState(FIXTURE_1);
    const r = deobfuscate(cd.content, map);
    assert.ok(r.text.includes('\n'), '正文应包含换行分段');
  });

  test('unknown 字符保留原样并计数', () => {
    const fake = '前\uE999后';
    const r = deobfuscate(fake, {});
    assert.equal(r.residual, 1);
    assert.ok(r.text.includes('\uE999'), 'unknown 字符应保留');
    assert.ok(r.ratio < DEOBF_MIN_RATIO, '全 unknown 时还原率应低于阈值');
  });
});
