import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextToolCalls } from '../src/llm.js';

test('解析 XML 文本形式的 function_calls（用户实际场景）', () => {
  const content = `<function_calls>
<invoke name="get_novel_progress">
<parameter name="type">novel_id</parameter>
<parameter name="novel_id">22</parameter>
</invoke>
</function_calls>`;
  const calls = parseTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_novel_progress');
  const args = JSON.parse(calls[0].args);
  assert.equal(args.novel_id, 22);
});

test('解析多个调用', () => {
  const content = `<function_calls>
<invoke name="web_search">
<parameter name="query">网文反派塑造技巧</parameter>
</invoke>
<invoke name="list_shared_characters">
</invoke>
</function_calls>`;
  const calls = parseTextToolCalls(content);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'web_search');
  assert.equal(JSON.parse(calls[0].args).query, '网文反派塑造技巧');
  assert.equal(calls[1].name, 'list_shared_characters');
});

test('参数为 JSON 对象时解析成对象值', () => {
  const content = `<invoke name="update_character">
<parameter name="novel_id">22</parameter>
<parameter name="name">主角</parameter>
<parameter name="patch">{"personality":"更果断"}</parameter>
</invoke>`;
  const calls = parseTextToolCalls(content);
  assert.equal(calls.length, 1);
  const args = JSON.parse(calls[0].args);
  assert.equal(args.novel_id, 22);
  assert.equal(args.name, '主角');
  assert.deepEqual(args.patch, { personality: '更果断' });
});

test('不支持 XML 的普通文本返回空数组', () => {
  assert.equal(parseTextToolCalls('你好，这本书写得不错').length, 0);
  assert.equal(parseTextToolCalls('').length, 0);
  assert.equal(parseTextToolCalls(null).length, 0);
  assert.equal(parseTextToolCalls(undefined).length, 0);
});

test('普通内容里的 <invoke 字样不误伤', () => {
  const content = '我在文中提到 <invoke name> 这种写法其实不推荐';
  assert.equal(parseTextToolCalls(content).length, 0);
});