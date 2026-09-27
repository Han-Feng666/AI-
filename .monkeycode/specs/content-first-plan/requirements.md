# Requirements Document — 已有正文优先的规划生成（content-first-plan）

Updated: 2026-09-27（决策已确认：v1 仅第一章粘贴，数据结构按多章数组设计；方案确认后继续手写后续章节走现有章节编辑器+补建管线，无需新增；剧情逻辑以本功能从源头修复，不另加因果链审查管线）

## Introduction

用户经常已经手写了第一章（或前几章）正文，希望以实际正文为锚点生成创作方案，让方案中的人物、设定、后续剧情全部与已有正文一致，从源头消除"方案与正文脱节 → 续不上/剧情错乱"的问题。当前流程是"先出方案再写正文"，方案对用户已写内容一无所知；重出方案时 `applyPlan` 仅按"标题+概要完全相同"保留正文，方案一改标题已写内容即丢失。

## Glossary

- **已有正文（Existing Chapters）**：用户在生成方案前填入的、已经写好的章节文本（v1 支持第一章，数据结构按多章设计）。
- **补建（Backfill）**：对有正文无摘要的章节运行记忆链后处理（摘要/角色状态/关键剧情事实/伏笔），复用 round 38 的 `backfillChapterMemory`。
- **方案（Plan）**：`POST /api/novels/:id/plan` 生成的创作方案（骨架+人物+势力+分章概要）。
- **既定事实铁律**：已有正文中发生的事件、出场人物、确立的设定为既定事实，方案与后续生成必须与之相容。

## Requirements

### Requirement 1 — 方案生成时提交已有正文

**User Story:** AS 作者，I want 在生成创作方案时填入已写好的第一章正文，so that 方案基于我的实际内容制定而非凭空规划。

#### Acceptance Criteria

1. WHEN 用户在方案表单中填入已有正文并点击生成方案，the System SHALL 将该正文保存为对应章节序号的章节记录（content 落库、status='done'），并携带正文进入方案生成流程。
2. WHEN 已有正文长度少于 200 字，the System SHALL 拒绝提交并提示"已有正文过短（至少 200 字）"。
3. WHEN 方案生成请求未携带已有正文，the System SHALL 按现有流程生成方案（行为完全兼容）。
4. IF 同一章节序号已存在有正文的章节记录且用户重新提交了该章正文，the System SHALL 以最新提交的正文覆盖旧正文并重建该章记忆链。

### Requirement 2 — 已有正文进入方案生成的上下文

**User Story:** AS 作者，I want 方案明确知道我第一章写了什么，so that 方案的人物、设定、第二章起的剧情与我的正文严丝合缝。

#### Acceptance Criteria

1. WHEN 方案生成请求携带已有正文，the System SHALL 对每个已有章节运行补建（摘要/角色状态/关键剧情事实），并在方案提示词中注入：章节摘要、关键剧情事实、正文结尾片段（最后约 600 字）。
2. WHEN 方案提示词包含已有正文块，the System SHALL 注入既定事实铁律：已有正文中的人物、事件、设定为既定事实，方案中的人物表/世界观/后续章节概要必须与之相容，严禁改写或忽略已有正文中已发生的事件。
3. WHEN 方案为第 1 章输出概要，the System SHALL 使用基于实际正文补建的摘要，替代模型自行规划的概要。
4. IF 补建（LLM 调用）失败，the System SHALL 降级使用正文末尾 600 字作为衔接依据继续生成方案，并保持方案生成不中断。

### Requirement 3 — 方案应用时保留已有正文

**User Story:** AS 作者，I want 重出方案或采纳修订方案后我写的第一章正文不丢失，so that 我可以放心迭代方案。

#### Acceptance Criteria

1. WHEN `applyPlan` 重建章节表时某章节序号存在快照正文，the System SHALL 按章节序号（而非标题+概要匹配）恢复该章正文、字数与完成状态。
2. WHEN 恢复的章节在快照中已有补建摘要，the System SHALL 保留补建摘要作为该章概要。
3. IF 方案的分章数少于已有正文覆盖的章节数，the System SHALL 仍恢复全部已有正文章节，并将其后的方案章节顺延。
4. WHEN 已有正文章节被恢复，the System SHALL 在方案应用结果中返回保留章节数（preserved_chapters）供前端提示。

### Requirement 4 — 后续章节从实际正文自然续接

**User Story:** AS 作者，I want 方案确认后生成的第二章直接接在我写的第一章结尾，so that 剧情连贯不错乱。

#### Acceptance Criteria

1. WHILE 某小说存在已有正文章节，the System SHALL 在生成其后续章节时使用现有前情管线（上一章结尾片段 + 概要 + 衔接校准 round 39），并保证衔接校准基于实际正文而非方案概要。
2. WHEN 第二章开始生成时方案概要与第一章实际结尾存在衔接偏差，the System SHALL 触发衔接校准自动改写本章概要（round 39 机制，无需新增代码，回归验证即可）。

### Requirement 5 — 前端方案表单支持已有正文

**User Story:** AS 作者，I want 在创作设置页看到一个可选的"已有开头正文"输入区，so that 我可以直接粘贴第一章再生成方案。

#### Acceptance Criteria

1. WHEN 用户打开创作设置页，the System SHALL 在方案表单中提供可折叠的"已有开头正文（可选）"文本域，占位提示说明用途与最低字数。
2. WHEN 用户填写已有正文并点击生成方案，the System SHALL 将正文作为 `existingChapters` 参数随方案请求提交。
3. WHILE 方案生成进行中，the System SHALL 展示"正在消化已有正文…"状态提示。
4. IF 已有正文少于 200 字，the System SHALL 在前端拦截提交并提示原因。

## Non-Functional Requirements

1. 补建与方案生成串行执行，补建失败不阻塞方案生成（降级路径）。
2. 已有正文不进入前端日志或错误信息明文（隐私）。
3. 全流程兼容：无已有正文时所有现有测试（round 7-39）行为不变。
