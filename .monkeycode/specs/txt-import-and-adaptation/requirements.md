# Requirements Document

## Introduction

为 AI 小说工坊新增「TXT 导入 + 整本改编」能力：用户把一本已有的小说 TXT 文件导入系统后，形成一本全新小说（新建小说并导入章节）；随后用户可发起「改编」，系统先询问用户希望怎么改（并可提供改编方案模板供选择），然后**一章一章**地由 AI 重写全书；每章改编结果先落为候选内容，用户在对比视图确认后才采纳生效。

## Glossary

- **导入 (Import)**：把本地 TXT 小说文件解析为章节并落库到一本新建小说的过程。
- **改编 (Adaptation)**：用户对导入小说提出改编意图后，AI 按意图逐章重写全书内容的过程。
- **改编意图 (Adaptation Intent)**：用户在发起改编前给出的修改方向（如"改成爽文""主角换成女性""改成悲剧结局""从第 3 章起改变剧情走向"）。
- **改编方案 (Adaptation Plan)**：系统基于改编意图自动生成的、对全书各章改造要点的结构化描述，供用户预览与确认。
- **候选章节 (Candidate Chapter)**：AI 改编某章后产出的新内容，尚未写入正式章节。
- **采纳 (Accept)**：用户确认候选章节内容后，将其写入正式章节、替换原章节内容的过程。
- **对比视图 (Compare View)**：展示候选章节与原始章节逐字差异（增/删/改标记）的界面。

---

## Requirements

### REQ-01 TXT 导入

**User Story:** AS 作者，I want 把我的 TXT 小说导入系统，so that 导入后能在编辑器里逐章查看并作为改编的底稿。

#### Acceptance Criteria

1. WHEN 用户选择本地 `.txt` 文件并提交导入，THE system SHALL 新建一本小说（novel 行 + 目录，书名为文件名去扩展名），并解析 TXT 内容为章节写入 `chapters` 表。
2. WHEN 解析 TXT 内容，THE system SHALL 按以下优先级识别章节边界：`第X章` 行首标题 → 空行分隔；每章写入 `chapter_index`、`title`、`content`，`word_count` 由正文计算。
3. IF TXT 中无法识别任何章节标题，THE system SHALL 将全文按近似等长（默认每 2000 字）切分为章节，并在界面提示"未识别章节标题，已按字数分章"。
4. WHEN 导入完成，THE system SHALL 同步为每章生成 TXT 副本文件（与现有章节一致），并在前端跳转到该小说的编辑器工作区，章节列表可见。
5. IF 导入过程中发生解析失败或数据库写入异常，THE system SHALL 中止导入、不残留半成品小说，并向用户返回可读错误信息。
6. THE system SHALL 对导入小说同样复用 `backupChapter` 机制：导入即视为第一版原始内容，后续任何覆盖前均先备份。

### REQ-02 改编前询问与方案

**User Story:** AS 作者，I want 在改编前先告诉 AI 怎么改，也能让 AI 先给出改编方案，so that 改编方向符合我的真实意图而非盲改。

#### Acceptance Criteria

1. WHEN 用户在章节工具条或小说级入口点击「改编」，THE system SHALL 弹出改编对话框，展示两种输入方式：`自定义改编意图`（自由文本）与 `改编方案模板`（预设选项，如"改成爽文""主角换性别""改为悲剧结局""节奏加快""世界观更换"）。
2. WHEN 用户选择改编方案模板，THE system SHALL 把该模板展开为结构化改编意图文本，用户可编辑后确认。
3. WHEN 用户提交改编意图，THE system SHALL 生成一份「改编方案」（按章节列改造要点），以 SSE 流式展示，供用户在正式逐章改写前确认；用户确认后方进入逐章改编阶段。
4. WHILE 改编方案生成或逐章改写进行中，THE system SHALL 显示进度百分比（方案阶段 0-100%、逐章阶段按 当前章/总章数），并允许用户中止。
5. IF 用户取消改编对话框或中止进行中的改编，THE system SHALL 不写入任何候选章节，保留全部原始内容。

### REQ-03 逐章改编与候选章节

**User Story:** AS 作者，I want 改编时一章一章地重写，每章结果先作为候选，so that 我能逐章把关内容质量。

#### Acceptance Criteria

1. WHEN 改编方案确认通过，THE system SHALL 按 `chapter_index` 升序逐章调用 AI 重写该章，改编提示词 SHALL 包含：改编意图、本章原文、改编方案中该章的改造要点、前序已采纳章节的摘要（保证连贯性）。
2. WHILE 逐章改编，THE system SHALL 把每章结果写入**候选章节**存储（不改动正式 `chapters` 表），并持久化该候选与来源章节的关联。
3. WHEN 某章候选生成完成，THE system SHALL 在前端展示该章的对比视图（候选 vs 原始，增/删/改高亮），并提供「采纳」「跳过（保留原文）」「重试该章」三个操作。
4. WHEN 用户点击「采纳」，THE system SHALL 将候选内容写入正式 `chapters` 表并覆盖原文，覆盖前先 `backupChapter` 备份原文，随后同步更新 TXT 副本与章节摘要。
5. WHEN 用户点击「跳过」，THE system SHALL 保留原文不变，并继续处理下一章。
6. WHEN 用户点击「重试该章」，THE system SHALL 以该章现有候选为上下文重新生成该章候选并刷新对比视图。
7. IF 某章 AI 改编返回失败（超时/网络/空内容），THE system SHALL 标记该章失败并允许用户单独重试，同时 SHALL NOT 中断其余章节的改编流程。

### REQ-04 改编任务管理

**User Story:** AS 作者，I want 改编作为一个可恢复的长任务，so that 我切换小说或刷新页面后改编进度不丢失。

#### Acceptance Criteria

1. WHEN 用户发起改编，THE system SHALL 创建一个持久化的改编任务（`adaptation_jobs` 表），记录：novel_id、改编意图、改编方案、当前处理到的章节、各章候选/采纳/跳过状态。
2. WHEN 用户切换小说、刷新或重启应用，THE system SHALL 在重新进入该小说时恢复改编任务进度，前端按已有章节状态继续展示对比视图与后续未处理章节。
3. IF 同一小说已有进行中的改编任务，再次发起改编 SHALL 提示冲突并聚焦到已有任务，避免并发改写。
4. WHEN 所有章节处理完毕，THE system SHALL 将任务标记为完成，并在界面提示"整本改编结束"，附已采纳/跳过/失败统计。

### REQ-05 章节连续性与记忆

**User Story:** AS 作者，I want 改编后的章节彼此连贯、保留人名与主线，so that 整本读起来不出现前后矛盾。

#### Acceptance Criteria

1. WHEN 构建某章改编提示词，THE system SHALL 注入「不可变锚点」：当前已采纳的改编后角色名清单与关键剧情节点，并声明用户未明确要求改变的设定 SHALL 保持不变。
2. WHEN 逐章处理，THE system SHALL 将已采纳章节的摘要维护为一个滚动上下文（最近 N 章），供后续章节改编时引用，保证剧情延续。
3. IF 用户改编意图中包含角色名/人名替换要求，THE system SHALL 在全书范围内保持一致替换；已采纳章节中的人名 SHALL 采用新名，未处理章节的改编提示词 SHALL 注入新旧人名映射表。
