# Requirements Document

## Introduction

本轮目标是把 AI 小说工坊从「单本串行 + 同步对话 Петербург」体验全面升级到「多本并行 + 方案版本化 + 总管 AI + 跨书角色联动」的稳定形态，并在过程中根除用户反复遇到的「AI 返回格式异常」与「方案/角色/剧情记忆错乱丢失」两类顽疾。

## Glossary

- **方案 (Plan)**：包含书名、类型、世界观、剧情大纲、角色列表、关系列表、分章大纲（标题+梗概）的整体创作蓝图。
- **修订 (Revise)**：用户对当前方案提出反馈后，AI 据此产出新方案的过程。本方案库中需要产出一个「候选版本」而非直接覆盖原方案。
- **采纳 (Accept)**：用户把候选版本的方案合并到小说主字段（novel 行 + characters/relationships/chapters 表）。
- **方案历史版本 (Plan Version)**：每次 AI 生成的方案快照，持久化存储，可回滚。
- **草稿 (Draft)**：用户在 SetupPanel 表单中尚未保存的输入；修订过程中用户尚未采纳前的状态。
- **总管 AI (Manager AI)**：右侧聊天面板里、能调用后端能力（路由工具）对任意书任意字段下指令的 agent。区别于现有「创作对话」（仅能聊天不能改东西）。
- **员工 AI (Worker AI)**：每本书背后独立运行 plan/generateChapter/revise 的后端任务，被总管 AI 调度。
- **生成任务 (Job)**：后端持久化的、可并发执行的长时任务记录，包含 novel_id、stage、status、word_count、stream cursor、error 等字段。
- **共享角色库 (Shared Character Pool)**：跨小说复用角色（含其基础档案）的全局资源池，供「跨书联动」使用。

---

## Requirements

### REQ-01 方案版本化与修订稳定性

**User Story:** AS 作者，I want 让 AI 修订方案时永远不再直接覆盖我的方案，so that 即使 AI 这次返回格式异常或乱改名我也能一键回到上一版正确方案，且不必再面对「第一次改成功、第二次又异常」的反复。

#### Acceptance Criteria

1. WHEN 用户提交修订意见，THE system SHALL 先持久化用户当前 SetupPanel 表单草稿（含未保存的字段）到 `plan_drafts` 表，再调用 AI 生成「候选方案 v(n+1)」并写入 `plan_versions` 表；候选方案 SHALL NOT 直接写入 novel 主字段或 characters/relationships/chapters 表。
2. WHEN 候选方案生成成功，THE system SHALL 在 plan-dialog 内展示候选方案与当前方案 diff（增/改/删标记），并由「采纳」按钮显式触发落库；用户未采纳前，小说实际方案不变。
3. IF AI 返回的内容无法解析为合法方案 JSON，THE system SHALL 保留前一版方案不变、回滚本次候选写入、向用户明确指引「当前方案未变更，可在保留前一版的基础上重试」，并 SHALL NOT 进入「重试解析」无界循环——失败 accetance 一次即结束，把原始 AI 输出原文展示给用户参考。
4. WHEN 用户在 plan-dialog 中点击「采纳」，THE system SHALL 应用候选版本（写 novel + 全量重建 characters/relationships/chapters），并在 `plan_versions` 表写入一条 `accepted=yes` 记录；旧版本记录保留，`accepted=no` 候选保留以备将来回滚。
5. WHEN 用户点击任意历史版本「回滚到此版本」，THE system SHALL 把该版本快照重新应用为当前方案（写主字段 + 重建关联表），并在 plan-dialog 内可见。
6. WHILE AI 在生成候选方案，THE system SHALL 在「采纳」前禁止再次提交新修订（按钮置灰 + 提示），避免并发覆盖。
7. WHEN 用户「先放置，稍后再看」关闭 plan-dialog，THE system SHALL 不丢弃候选方案；下次进入该小说的「创作设置」时 SHALL 在显眼处展示「上次有 1 个待采纳的修订方案（来自 ... 时间）」入口，点击直接恢复 plan-dialog 到待采纳状态。

### REQ-02 修订角色名/剧情锚定

**User Story:** AS 作者，I want AI 修订时不再擅自改角色名和已确认的主线，so that 与上一版方案保持衔接，避免记忆错乱。

#### Acceptance Criteria

1. WHEN 调用修订提示词，THE system SHALL 在 user prompt 内注入「不可变锚点」段：列出当前已采纳方案的「角色名列表（含 role_type）」与「分章标题列表」，并显式声明「未在用户反馈中明确提及的角色名、关系、章节标题 MUST 保持不变」。
2. THE revise system prompt SHALL 在每条字段后明确约束「字段名与结构对齐当前方案，不得新增/删除字段，不得替换角色名」。
3. IF AI 返回的候选方案中出现用户未提及删除但被去掉的角色或章节，THE system SHALL 在 diff 视图以「红色删除标记」突出展示该差异，由用户在采纳前明确确认。
4. WHEN 候选方案被采纳，THE system SHALL 把「上一版方案 + 本次反馈 + 候选方案」三元组追加到 `plan_change_log` 表，为后续 AI 上下文与人工追溯提供完整链路。

### REQ-03 多本并行不串扰

**User Story:** AS 作者，I want 真后台并行创作多本书，so that 在 A 书生成方案/章节途中切到 B 书，B 书的入口可以是干净的、A 书仍然继续跑、互不干扰。

#### Acceptance Criteria

1. WHEN 用户在 Home 页打开小说 A 进入 Editor 后，再切回 Home 进入小说 B，THE system SHALL 不再复用单一全局 store 状态切换；前端 store 必须按 `novelId` 维度保存状态切片，切书仅切换「当前活跃 novelId」，A 书的 chapters/busy/chat 状态 SHALL 保持。
2. THE backend SHALL 持久化每个生成任务为行级 Job（`generation_jobs` 表），单次 plan/revise/generateChapter 各创建一条 Job；Job 状态独立于前端连接，用户关闭某本书的页面 SHALL NOT 中断后台生成。
3. WHILE 后端 Job 的状态变化（status/progress/word_count/error），THE backend SHALL 通过 SSE 通道或在 GET 时回带最新 Job 状态；前端进入对应小说工作区时 SHALL 自动恢复该书的 Job 进度显示（含 streaming snapshot）。
4. WHEN 用户切到 B 书 Home 页，THE frontend SHALL 不自动启动 B 书的 plan/generation；B 书的工作区必须由用户显式点击「生成创作方案」后才会触发（修复现有「切到 B 显示正在构思世界观」串扰 bug）。
5. THE frontend SHALL 在 Home 页书架卡片上展示每本书的实时 Job 状态徽标（如「正在生成方案」「正在写第 3 章」），状态从后端 Job 表读取，与当前是否打开该书无关。
6. IF 同一小说同一阶段已有 Job 在跑，再次点击「生成」SHALL 提示「该小说已有进行中任务」，避免双发任务并发写库。

### REQ-04 右侧 AI 升级为「总管」

**User Story:** AS 作者，I want 右侧 AI 成为有最高权限的总管，so that 工作区 AI 忙时也能和它对话、它能替我查任意书进度并直接修改任意书任意字段。

#### Acceptance Criteria

1. WHILE 工作区 Worker AI 正在生成方案/章节，THE 右侧 Manager AI SHALL 仍可接收并回复用户对话，不被 `store.busy` 阻塞（ChatPanel 的 `store.busy return` 逻辑改为不影响 Manager 通道）。
2. THE Manager AI SHALL 通过 OpenAI tools / function-calling 协议声明一组后端能力工具，至少包括：
   - `get_novel_progress(novel_id)` 查任意书当前进度
   - `update_outline(novel_id, new_outline)` 修改任意书剧情大纲
   - `update_character(novel_id, name, patch)` 修改角色
   - `request_revise(novel_id, feedback)` 触发任意书方案修订
   - `request_generate_chapter(novel_id, idx)` 触发任意书章节生成
   - `list_shared_characters()` 列出跨书可联动角色
   - `introduce_shared_character(novel_id, shared_id)` 把其他书角色引入当前书
3. WHEN Manager AI 决定调用某工具，THE backend SHALL 在受控的、需用户确认的策略下执行：写操作类工具（update_*, request_*, introduce_*）SHALL 在前端弹出「AI 准备执行 X 操作，是否授权」确认条；读类工具（get_*, list_*）可直接执行。
4. THE Manager AI 的对话历史与「总管记忆」SHALL 持久化到 `manager_messages` 与 `manager_memory` 表，**与所用 LLM 模型解耦**：换模型不丢；记忆内容为「用户长期偏好 + 跨书协调信息」，单本书的剧情记忆仍归 Worker/Job 持有。
5. WHEN 用户从 A 书切到 B 书对话 Manager，「当前上下文小说」也随之变化时，THE Manager SHALL 能继续讨论 A 书进度（通过 `get_novel_progress(A_id)` 工具），具备跨书询问能力。
6. THE ChatPanel UI SHALL 升级显示：工具调用过程以「行动卡片」展示（如「正在查询 A 书进度… → 已写 12/20 章」），让用户清楚 AI 做了什么。

### REQ-05 工作区 AI 与右侧 AI 联动

**User Story:** AS 作者，I want 工作区发生的事（在生成方案、生成章节、报格式异常）能反映到右侧 AI 对话，so that 双方不再是两个互不通气的孤岛。

#### Acceptance Criteria

1. WHEN 工作区 Job 状态变化（启动/进度/完成/出错/触发格式异常自救），THE frontend SHALL 把摘要事件注入到 Manager 对话历史（用户侧不可见的 system 角色「workspace_event」），让 Manager 上下文感知 Worker 进展。
2. WHEN 用户对 Manager 说「帮我看下现在的方案」「让 AI 把第 3 章节奏改慢」等指令，THE Manager SHALL 能解读并调用 `request_revise/request_generate_chapter` 相应工具触发 Worker。
3. WHEN 候选方案生成完毕（待采纳），THE Manager SHALL 主动在对话内口头提示「方案已生成，请你到工作区查看与采纳」。

### REQ-06 关系网导图体验

**User Story:** AS 作者，I want 关系网用更直观的导图方式呈现并可手动拖拽布局，so that 能自由按我脑中的结构组织人物关系。

#### Acceptance Criteria

1. THE RelationshipPanel SHALL 用自绘 SVG 导图替代当前 ECharts 力导图：节点（角色按 role_type 分大小）、连线（带 relation_type 文字标签）、整体可缩放/平移、节点可手动拖动且布局随之固定（持久化 `node_pos` 到 `relationship_nodes` 表，避免刷新后回到自动布局）。
2. WHEN 用户拖动任意节点，THE backend SHALL 在 `relationship_nodes(novel_id, character_id, x, y)` 表持久化坐标，刷新后保持位置；新增节点默认按力导自动布局一次后落位。
3. WHEN 节点点击 SHALL 弹出角色详情面板；连线点击 SHALL 弹出关系编辑窗口（沿用现有 dialog 容器）。
4. THE 导图 SHALL 在角色 ≥3 时才渲染连线和重叠规避，避免空图。

### REQ-07 风格库拖拽导入 TXT

**User Story:** AS 作者，I want 在风格提取对话框里直接把硬盘里的 TXT 文件拖进来，so that 不必复制粘贴或来回切换路径。

#### Acceptance Criteria

1. THE 风格提取入口 SHALL 提供一个拖拽热区（dropzone），支持 `.txt`/`.md` 单文件或多文件拖入；拖入后前端读取文本内容（大小 ≤ 500KB）传给后端 `POST /styles/extract` 既有路径。
2. WHEN 文件超过 500KB，THE frontend SHALL 提示「文件过大，请拆分或截取」并拒绝上传。
3. WHEN 拖入成功，THE frontend SHALL 显示文件名+字符数预览，再点「提取风格」提交；保留现有「粘贴文本」入口作为兜底。

### REQ-08 对话回车发送

**User Story:** AS 作者，I want 在右侧 AI 对话框按回车直接发送，so that 不必每次伸手点鼠标。

#### Acceptance Criteria

1. WHEN 用户在 ChatPanel 输入框按 Enter（无修饰键），THE system SHALL 立即发送当前内容；Shift+Enter SHALL 换行；Ctrl/Cmd+Enter SHALL 也发送（兼容两种习惯）。
2. THE 现有 `@keydown.enter.exact.prevent` 实现 SHALL 扩展为支持 Ctrl/Cmd+Enter（统一发送），并加 bool 设置项「Enter 发送 / Ctrl+Enter 发送」二选一，写入 settings。

### REQ-09 风格与类型扩充 + 长短篇分级

**User Story:** AS 作者，I want 选择更丰富的小说类型、风格，并区分长篇/短篇，so that 选材更精准、AI 生成分章大纲的密度与字数也能匹配篇幅。

#### Acceptance Criteria

1. THE 既有 GENRES 与 PRESET_STYLES 数组 SHALL 扩充：类型新增「同人、二次元、电竞、医道、法医、灵异、神话题材、御兽、机甲、机甲少女、轻推理、社会派、Time-Loop、星际、体育竞技、官场、民国、年代、乡村」等 ≥18 项；风格新增 ≥12 项（含「诗意哲理、克制留白、记录体、意识流、镜头感、燃爽快节奏 II、慢热治愈、克苏鲁诡异、东方玄幻色调、赛博迷离、黑色幽默、温情群像」）。
2. THE 新建小说对话框（Home）与 SetupPanel SHALL 增加「篇幅分级」单选：短篇（≤5 章、每章 ≥3000 字总长 ≤3 万）、中篇（6-30 章、每章 2000-4000）、长篇（>30 章、每章 2000-3000）默认导出对应的目标章数与每章字数表单默认值；后端 `novels.length_class` 字段持久化。
3. WHEN 选短篇且 target_chapters 被 AI 误生成 >6 章，THE plan 校验逻辑 SHALL 警告并建议改为中长篇。
4. THE 既有 genres/style_presets 字段兼容不变。

### REQ-10 跨书角色联动

**User Story:** AS 作者，I want 把以前书的角色引入当前书做联动，so that 形成自己的小说宇宙。

#### Acceptance Criteria

1. THE backend SHALL 新增 `shared_characters` 表，从任意书「升级」一个角色到共享池时复制其 name/role_type/personality/background/description/avatar_color 到该表，并保留 `source_novel_id`。
2. WHEN 用户在某角色卡片点「升级为共享角色」，THE system SHALL 写 shared_characters 表，并可被任意新书 SetupPanel 关系网区「引入共享角色」。
3. WHEN 在新书引入共享角色，THE system SHALL 在该 novel 的 characters 表插入一条引用记录（含 `shared_id` 外键），且在更新角色时同步回写 shared_characters 表，避免分叉。
4. THE Manager AI SHALL 通过 `list_shared_characters` 与 `introduce_shared_character(novel_id, shared_id)` 工具协助跨书联动。

### REQ-11 风格库与类型常量同步

**User Story:** AS 作者，I want 修改的常量同步到所有出现位置，so that 不出现 Home 用 A 列表、SetupPanel 用 B 列表的口径不一。

#### Acceptance Criteria

1. THE GENRES 与 PRESET_STYLES、LENGTH_CLASSES 常量 SHALL 集中放在 `web/src/utils/format.js` 单一来源，由 Home.vue 与 SetupPanel.vue、Editor 风格选择处共同引用；后端 prompts.js 内的常量 SHALL 通过一组对齐常量靠拢（用于提示词体现），二者口径一致。

---

## Validation

- 所有新表（plan_versions/plan_drafts/plan_change_log/generation_jobs/manager_messages/manager_memory/relationship_nodes/shared_characters）在打开旧库时 SHALL 通过 `ensureColumn`/`CREATE TABLE IF NOT EXISTS` 兼容升级，旧库不丢数据。
- 单元测试覆盖：plan 版本写库/diff/回滚、Job 状态机、shouldAutoCompress、shared_character 同步、tools 注册与执行 gate 解释器。
- 端到端 mock：A/B 两本并行 plan；切书瞬间窗刷新不中断；Manager 跨书 query；候选方案 fail 解析时保留旧版。
