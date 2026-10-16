import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWriteIntent } from '../src/writeIntent.js';

test('detectWriteIntent 命中写操作意图', () => {
  const positives = [
    '帮我改一下大纲',
    '把剧情大纲更新成穿越流',
    '请修改人物设定',
    '帮我修订方案',
    '重新写一下大纲',
    '生成下一章吧',
    '写新的一章',
    '修改第5章的节奏',
    '帮我调整第 12 章的剧情',
    '引入共享角色到这本新书',
    '改大纲，龙傲天变成幕后流',
    '帮我生成新章节，接着写',
    '把角色人设改成妙龄少女'
  ];
  for (const s of positives) {
    assert.ok(detectWriteIntent(s), `应命中: ${s}`);
  }
});

test('detectWriteIntent 非写操作不命中', () => {
  const negatives = [
    '你好',
    '这本书写得不错',
    '帮我看看现在的方案',
    '大纲里主角的名字叫什么',
    '搜索网文写作技巧',
    '帮我查一下这本书的进度',
    '写得还行',
    '',
    null,
    undefined
  ];
  for (const s of negatives) {
    assert.ok(!detectWriteIntent(s), `不应命中: ${s}`);
  }
});