# 任务清单 — Stability and Manager Rewrite

> 按"先底层数据 + Worker Job 化 → 再 Manager tool-use → 再前端体验重写"顺序排，每阶段可独立验证后再续。

## Phase 1 — 数据层与兼容升级
- [ ] T1.1 db.js 补齐 9 张新表 + 索引（plan_versions/plan_drafts/plan_change_log/generation_jobs/manager_messages/manager_memory/pending_tool_calls/relationship_nodes/shared_characters），全部 `CREATE TABLE IF NOT EXISTS` + `ensureColumn('novels','length_class',...)` + `ensureColumn('characters','shared_id',...)`。打开旧库无报错、无数据丢失。
- [ ] T1.2 写一个 db-migrate 自检脚本：在已有 novels 的临时库上跑迁移，断言所有新列/表存在且旧表行数不变。
- [ ] T1.3 后端 node --check 通过、前端 npm run build 通过（仅数据层不动 UI）。

## Phase 2 — Worker Job 化（routes/job 模块）
- [ ] T2.1 新增 `server/src/jobs.js`：createJob/updateJob/getJob/listJobsByNovel/listActiveJobs；内存 pub/sub `subscribeJobEvents(cb)`。
- [ ] T2.2 routes.js 内 plan/revise/generateChapter/polish/compress 5 个长流程逐个改：入口 createJob、每阶段 updateJob、失败 updateJob(failed)+不重抛丢状态、成功 updateJob(done)、保留 SSE 透传。
- [ ] T2.3 新增 `GET /novels/:id/job`、`GET /jobs/active`、`GET /jobs/stream`（SSE 跨书 push）。
- [ ] T2.4 mock-llm 端到端：plan 阶段 updateJob 序列 = running~40%~done，断线重连后 `GET /jobs/active` 显示进行中。

## Phase 3 — 方案版本化 + 修订稳定性
- [ ] T3.1 新增 `server/src/planVersions.js`：saveVersion/listVersions/acceptVersion/rollbackTo/getDiff/saveDraft/getDraft/appendChangeLog/getLatestPending。
- [ ] T3.2 新增 `POST /novels/:id/plan/revise` 重写：先 saveDraft 保存当前表单 → AI 生成候选 → saveVersion(kind='revise', accepted=0) → 不再直接 applyPlan。
- [ ] T3.3 新增 `GET /novels/:id/plan/versions`、`POST /novels/:id/plan/versions/:vid/accept`、`POST /novels/:id/plan/versions/:vid/rollback`、`GET /novels/:id/plan/draft`、`PUT /novels/:id/plan/draft`。
- [ ] T3.4 prompts.js PLAN_REVISE_SYSTEM 加"不可变锚点"指令（注入角色名表 + 章节标题表 + "未明确提及项不得改名"约束）。
- [ ] T3.5 revise 解析失败：不进重试死循环，一次失败 → 保留旧版 + 原始 AI 输出回传给前端展示。删除 routes.js revise 内的 `chat retry → extractJson(plan2)` 重试块。
- [ ] T3.6 单测 planVersions 全链；mock-llm revise 解析失败保留旧版验证。

## Phase 4 — 前端状态分片 + 多书并行
- [ ] T4.1 stores/editor.js 改为 `slices = Map<novelId, slice>` + activeNovelId。所有 action 操作 slices.get(activeNovelId)。新增 ensureSlice(id)/switchTo(id)/resetSlice(id)、保留单测入口。
- [ ] T4.2 loadNovel 走 ensureSlice + 读 Job 表恢复正在进行 Job 的进度展示。
- [ ] T4.3 Home.vue 切到 B 书不再自动启动 generation：切 Home 后回到 Editor 才 push route（已有路由不动）。修复串扰 bug：从 Home 进 B 书时 B 没 plan 的话 store.busy 必须为 false。
- [ ] T4.4 Home.vue 卡片上加 Job 徽标轮询 `/jobs/active`。
- [ ] T4.5 mock-llm 端到端双本并行：A 跑 plan 阶段 → 切 B、B 主动点生成 → 双 Job 互不阻塞，UI 各自显示当前 Job。

## Phase 5 — Manager tool-use 路由
- [ ] T5.1 新增 `server/src/tools.js`：toolRegistry 7 个工具 schema + executor 实现（先纯逻辑、不带 needsAuth）：
  - get_novel_progress、list_shared_characters （读类，needsAuth=false）
  - introduce_shared_character、update_outline、update_character、request_revise、request_generate_chapter（写类，needsAuth=true）
- [ ] T5.2 llm.js `chat()` 支持 tools + 返回 tool_calls 数组；`runLLMStream` 透传 tools 字段。
- [ ] T5.3 新增 `/manager/chat` 路由：拼 system（总管身份 + listActiveJobs 跨书摘要）+ manager_messages 历史 → 调 LLM → 收到 tool_calls 逐个判定 needsAuth → 读类直接执行回灌；写类写 pending_tool_calls + 推 SSE `tool_call_pending` 给前端。
- [ ] T5.4 新增 `POST /manager/tool/:callId/authorize` 与 `/reject`：执行/拒绝后写终态、结果回灌 LLM 续对话。
- [ ] T5.5 pending_tool_call 120s 无授权默认 reject + 给 LLM 上下文「用户未响应此操作」。
- [ ] T5.6 端到端 mock：读类工具 manager 可直接答；写类触发授权门、reject 后对话口径正确。

## Phase 6 — 前端 Manager store + ChatPanel 升级
- [ ] T6.1 新增 stores/manager.js：messages/memory/pendingToolCall、send/authorize/reject。
- [ ] T6.2 ChatPanel.vue 改用 manager store；解耦 store.busy（右栏不再被 Worker 阻塞）。
- [ ] T6.3 工具调用「行动卡片」UI：读类展示"已查询/更新结果"；写类展示"AI 准备 X 操作 [允许][拒绝]"授权条。
- [ ] T6.4 回车发送扩展：支持 Ctrl/Cmd+Enter；新增 settings `managerSendBy` (enter | ctrlEnter) 二选一。
- [ ] T6.5 stores/workspaceEventBus.js（轻量 ESM emitter）；Manager store 订阅，Job 变更时把摘要塞入 system 角色 `workspace_event` 注入下次对话上下文。

## Phase 7 — SetupPanel 方案版本化 UI
- [ ] T7.1 SetupPanel.vue plan-dialog 改造为"候选方案 diff + 采纳/回滚 + 版本列表"。
- [ ] T7.2 「先放着，稍后再看」保持候选不撤回；下次进入 SetupPanel 顶部显眼展示"上次有 1 个修订方案待采纳"入口，点击直接恢复 plan-dialog 到待采纳状态。
- [ ] T7.3 plan-dialog diff 渲染：appendOnly 的差异标记（绿色新增/红色删除/灰色不变）。
- [ ] T7.4 表单草稿 PUT `/plan/draft`（防 600ms 防抖自动保存）；onMounted GET `/plan/draft` 恢复。
- [ ] T7.5 mock-llm 端到端：A 书首次 revise 成功、第二次解析失败 → 旧版保留 + 原始输出展示 + 第三个再 revise 又成功不丢前一版。

## Phase 8 — 关系网导图自绘 SVG
- [ ] T8.1 新增 components/RelationshipGraph.vue（替代 echarts）：SVG 主画布 + 节点拖动 + 整体缩放/平移；新增节点默认力导初始布局一次后落位。
- [ ] T8.2 拖动 dragEnd 触发 `PUT /novels/:id/relationships/nodes`（新增路由） 保存 x/y 到 relationship_nodes 表。
- [ ] T8.3 RelationshipPanel.vue 切换到 RelationshipGraph；节点点击弹详情、连线点击弹关系编辑（沿用既有 dialog）。
- [ ] T8.4 节点 ≥3 才渲染连线与避叠；<3 友好空图状态。
- [ ] T8.5 mock：拖动后刷新位置保留；增删角色节点正确出现/消失。

## Phase 9 — 风格库拖拽 + 短篇分级 + 类型扩充 + 跨书角色
- [ ] T9.1 utils/format.js 扩 GENRES（+≥18）+ PRESET_STYLES（+≥12）+ 新增 `LENGTH_CLASSES` + `getLengthDefaults(cls)`。
- [ ] T9.2 Home.vue 新建对话框加篇幅分级单选（短/中/长），按选项动态填默认章数/每章字数；后端 novels.length_class 列已备。
- [ ] T9.3 新增 components/StyleImportDropzone.vue：dropzone .txt/.md 单/多文件；>500KB 拒绝；预览字符数后提交既有 `/extract-style`。
- [ ] T9.4 风格库页面（如有独立页面）接入 dropzone；保留粘贴文本兜底。
- [ ] T9.5 后端 `shared_characters` 升级/引入路径：`POST /novels/:id/characters/:cid/upgrade-shared`、`POST /novels/:id/shared-characters/:sharedId/introduce`、`GET /shared-characters`。characters 表加 `shared_id` 引用、更新时回写共享池。
- [ ] T9.6 SetupPanel/CharacterPanel 角色卡片加"升级为共享角色"；新建小说时关系网面板加"引入共享角色"按钮。
- [ ] T9.7 Manager tool `list_shared_characters` + `introduce_shared_character` 接通，可在对话里跨书联动。

## Phase 10 — 联动总线
- [ ] T10.1 workspaceEventBus emit/订阅把 Worker Job 变更摘要注入 Manager system 角色事件；Manager 能对"现在方案怎样了""让 AI 把第 3 章节奏改慢"作工具调用触发 Worker。
- [ ] T10.2 Manager 在候选方案生成完毕后主动口头提示"方案已生成，请到工作区采纳"。
- [ ] T10.3 Manager 在 Worker 报格式异常时主动提一句"刚才 A 书生成格式异常，已保留旧版，是否要我让 AI 再试一次"。

## Phase 11 — 收尾打包
- [ ] T11.1 后端 node --check 所有新文件；前端 npm run build 通过。
- [ ] T11.2 mock-llm 端到端回归 75 章分批 plan、自动压缩、双本并行、Manager 跨书 query、候选版本 fail 解析保留旧版、authority reject。
- [ ] T11.3 MEMORY.md 追加本轮所有新决策与坑点（plan 版本化 + Job 表 + tool-use + 多书并行 + shared_characters 同步 + SVG 节点坐标持久化）。
- [ ] T11.4 Windows 安装包在用户本机重打：`cd F:\小说\workspace\desktop && git pull && npm run build && npx electron-builder --win nsis`（Linux 环境无法跑此命令；执行者是用户）。
