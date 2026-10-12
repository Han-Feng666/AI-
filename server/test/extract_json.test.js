import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, extractArray } from '../src/prompts.js';

const idea = (n) => ({
  title: `书名${n}`,
  genre: '校园言情',
  hook: `钩子${n}`,
  logline: `梗概${n}`,
  story_engine: {
    central_question: '主角能否在一起',
    antagonist: '拆散两人的班主任',
    escalation: '从班级到全校公开',
    inner_need: '学会表白'
  },
  protagonist: { name: `林${n}`, identity: '高三学生', golden_finger: '无特殊优势', personality: '嘴硬' }
});

test('标准 JSON 数组可解析', () => {
  const arr = [idea(1), idea(2)];
  const got = extractArray(JSON.stringify(arr));
  assert.ok(Array.isArray(got) && got.length === 2);
  assert.equal(got[0].title, '书名1');
});

test('未闭合 json 围栏可解析', () => {
  const body = JSON.stringify([idea(1)]);
  const got = extractArray('```json\n' + body);
  assert.ok(Array.isArray(got) && got.length === 1);
  assert.equal(got[0].title, '书名1');
});

test('前缀文字加数组可解析', () => {
  const got = extractArray('以下是创意：\n' + JSON.stringify([idea(1), idea(2)]));
  assert.ok(Array.isArray(got) && got.length === 2);
});

test('单键 ideas 对象可下钻成数组', () => {
  const got = extractArray(JSON.stringify({ ideas: [idea(1), idea(2)] }));
  assert.ok(Array.isArray(got) && got.length === 2);
});

test('并列创意对象不包数组时仍能捞回', () => {
  const text = `创意1：${JSON.stringify(idea(1))}\n创意2：${JSON.stringify(idea(2))}`;
  const got = extractArray(text);
  assert.ok(Array.isArray(got) && got.length === 2, `应捞回 2 条，实际 ${got && got.length}`);
  assert.equal(got[0].title, '书名1');
  assert.equal(got[1].title, '书名2');
});

test('extractJson 不把 story_engine 内层当整段结果', () => {
  const text = JSON.stringify(idea(1));
  const got = extractJson(text);
  assert.equal(got && got.title, '书名1');
  assert.ok(got.story_engine && got.story_engine.antagonist);
});

test('字符串内嵌套引号不让解析整批失败', () => {
  const raw = '[{"title":"外号"刀客"少年","hook":"开局","logline":"一句话"}]';
  const got = extractArray(raw);
  assert.ok(Array.isArray(got) && got.length === 1);
});
