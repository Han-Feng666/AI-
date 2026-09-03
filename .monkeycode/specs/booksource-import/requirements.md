# Requirements Document — 书源导入与搜索（booksource-import）

Updated: 2026-09-03

## Introduction

用户持有「书源」（Legado / 阅读 3.0 兼容格式的 JSON 规则，描述某个小说站的搜索、详情、目录、正文提取规则）。本功能让用户像使用小说 App 一样：导入书源 → 按关键词搜索小说 → 选择某本书整本导入。导入后复用既有的后台队列与分析管线（风格库 / 知识学习库），解决番茄网页端仅开放前 10 章试读、无法获取整本正文的问题。

## Glossary

- **书源（Book Source）**: Legado 兼容的 JSON 配置，包含 `bookSourceUrl`、`searchUrl`、`ruleSearch`、`ruleBookInfo`、`ruleToc`、`ruleContent` 等字段，指向某个小说站点
- **规则引擎**: 解析书源规则、向目标站点发起请求并提取数据的本工具内置模块
- **支持的规则子集**: 本工具实现解析的规则语法，包含：默认链式规则（`class.x@tag.y@text`）、`@css:` 选择器、JSON 路径（`$.a.b`）、`##正则#替换` 净化、`searchUrl` 模板变量（`{{key}}`、charset 声明）
- **不支持的规则类型**: 依赖 JavaScript 引擎（`<js>` 块、`{{java.xxx}}`）与 XPath（`@XPath:`）的规则，本工具解析时会跳过并提示

## Requirements

### Requirement 1 — 书源导入与校验

**User Story:** AS 用户，我想粘贴书源 JSON 导入工具，以便用我已有的书源搜索小说。

#### Acceptance Criteria

1. WHEN 用户粘贴书源 JSON（单个对象或对象数组）并提交，系统 SHALL 按 Legado（阅读 3.0）字段结构解析，校验必填字段（`bookSourceUrl`、`searchUrl`、`ruleSearch`、`ruleToc`、`ruleContent`）并将通过校验的书源保存入库
2. IF JSON 解析失败或某条书源缺少必填字段，系统 SHALL 返回明确的错误信息（指出第几条书源、缺失字段名）并附期望的字段结构说明，且保存同批次中通过校验的其他书源
3. WHEN 书源包含系统不支持的规则类型，系统 SHALL 保存该条书源并标记「部分支持」，在导入结果中列出具体原因
4. WHEN 用户重复导入 `bookSourceUrl` 相同的书源，系统 SHALL 覆盖更新既有条目

### Requirement 2 — 书源管理

**User Story:** AS 用户，我想查看和管理已导入的书源，以便控制哪些书源参与搜索。

#### Acceptance Criteria

1. 系统 SHALL 展示已导入书源列表（名称、站点域名、支持状态、导入时间）
2. 系统 SHALL 支持对单个书源执行启用、禁用、删除操作
3. WHEN 书源被禁用，系统 SHALL 在搜索入口中排除该书源

### Requirement 3 — 多书源聚合搜索

**User Story:** AS 用户，我想用关键词同时搜索所有启用的书源并合并结果，以便在重名小说之间选择正确的书。

#### Acceptance Criteria

1. WHEN 用户提交关键词，系统 SHALL 向所有已启用书源并发发起搜索、按各自 `ruleSearch` 解析，合并展示结果列表（书名、作者、最新章节、简介、来源书源名称、详情链接）
2. IF 某个书源搜索失败（超时、HTTP 非 200、解析结果为空），系统 SHALL 在结果页单独列出该书的失败原因，且不阻塞其他书源的结果展示
3. IF 所有启用书源全部搜索失败，系统 SHALL 展示全部失败原因汇总
4. WHEN 关键词为空，系统 SHALL 在前端阻止提交

### Requirement 4 — 整本导入（后台队列）

**User Story:** AS 用户，我想把搜到的某本书整本导入分析管线，以便获得完整的风格学习 / 知识库语料。

#### Acceptance Criteria

1. WHEN 用户选择某条搜索结果并确认导入，系统 SHALL 创建后台导入任务：抓取目录 → 逐章抓取正文并拼接 → 复用既有分析管线（目标库：风格库或知识学习库，与番茄导入一致）
2. WHILE 任务进行中，系统 SHALL 持久化任务进度（总章数、已抓章数、跳过章数）并在队列面板展示
3. IF 单章正文抓取失败或解析结果为空，系统 SHALL 跳过该章并计入跳过数，队列继续处理后续章节
4. 系统 SHALL 对同一站点的连续请求保持节流（250ms 间隔）以降低对目标站点的压力
5. 系统 SHALL 支持任务取消、失败重试与服务重启恢复，行为与番茄导入队列一致
6. WHEN 任务完成，系统 SHALL 按目标库复用既有入库流程（风格库生成风格 DNA，知识库完成切片与场景打标）

### Requirement 5 — 合规与使用范围

**User Story:** AS 工具维护者，我要求抓取行为保持在个人学习用途边界内。

#### Acceptance Criteria

1. 抓取的书本内容 SHALL 仅用于本工具内的个人风格分析与知识库学习
2. 系统 SHALL 沿用既有定位，不提供书本内容的分发、公开分享功能
