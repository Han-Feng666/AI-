import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillFile } from '../src/skill_parser.js';

test('解析带 frontmatter 的标准 SKILL.md', () => {
  const r = parseSkillFile({
    name: '悬念技巧.md',
    content: `---
name: 悬念设置技巧
description: 每章结尾必须留一个具体的悬念钩子
tags: 悬念,节奏
---

# 悬念设置技巧

## 核心要点
- 钩子要具体

## 检查清单
- [ ] 有钩子
`
  });
  assert.equal(r.error, undefined);
  assert.equal(r.name, '悬念设置技巧');
  assert.equal(r.description, '每章结尾必须留一个具体的悬念钩子');
  assert.equal(r.tags, '悬念,节奏');
  // 首个 # 标题应被移除
  assert.ok(!r.content.includes('# 悬念设置技巧'));
  // ## 应转换为 ###
  assert.ok(r.content.includes('### 核心要点'));
  assert.ok(r.content.includes('### 检查清单'));
});

test('frontmatter 中带引号的 description 被去引号', () => {
  const r = parseSkillFile({
    name: 'foo.md',
    content: `---
name: 视角切换
description: "含 '中文引号' 与符号：a/b"
tags: 视角
---

# 视角切换

正文内容。
`
  });
  assert.equal(r.name, '视角切换');
  assert.equal(r.description, `含 '中文引号' 与符号：a/b`);
  assert.equal(r.tags, '视角');
});

test('无 frontmatter 时用文件名作技能名', () => {
  const r = parseSkillFile({ name: '我的技巧.md', content: '## 核心\n正文' });
  assert.equal(r.name, '我的技巧');
  assert.equal(r.description, '');
  assert.equal(r.content, '### 核心\n正文');
});

test('纯文本文件（.txt）也能解析', () => {
  const r = parseSkillFile({ name: '对话写法.txt', content: '对话要短。' });
  assert.equal(r.name, '对话写法');
  assert.equal(r.content, '对话要短。');
});

test('空内容报错', () => {
  const r = parseSkillFile({ name: '空技能.md', content: '   ' });
  assert.equal(r.error, '技能内容为空');
});

test('空名称报错', () => {
  const r = parseSkillFile({ name: '', content: '正文' });
  assert.equal(r.error, '未解析到技能名称');
});

test('frontmatter 只给 title 没有 name 时回退文件名', () => {
  const r = parseSkillFile({
    name: 'mystery.md',
    content: `---
title: 某种标题
---

# 正文
内容
`
  });
  assert.equal(r.name, 'mystery');
  assert.equal(r.content, '内容');
});

test('单引号包裹的 frontmatter 值', () => {
  const r = parseSkillFile({
    name: 'x.md',
    content: `---
name: '打斗写作'
description: '动作要具体'
---

# 打斗写作
正文
`
  });
  assert.equal(r.name, '打斗写作');
  assert.equal(r.description, '动作要具体');
});