# 任务清单 — TXT 导入与整本改编

> 按"先数据层 + 解析 → 再改编后端链路 → 再前端体验"顺序排，每阶段可独立验证后再续。

## Phase 1 — 数据层与 TXT 解析
- [ ] T1.1 db.js 新增 2 张表：`adaptation_jobs`（id/novel_id/intent/plan/status/current_index/total_chapters/accepted_count/skipped_count/failed_count/error/created_at/updated_at）、`adaptation_candidates`（id/novel_id/job_id/chapter_index/original_title/original_content/candidate_title/candidate_content/status/error/created_at），候选表加唯一索引 `(job_id, chapter_index)`。全部 `CREATE TABLE IF NOT EXISTS`，旧库打开无报错。
- [ ] T1.2 lib.js 新增 `parseTxtChapters(text)`：`第X章` 行首（含中文数字/阿拉伯数字/章回节卷）分割；无标题则按每 2000 字切分并返回 `splitted=true`。单测覆盖中文数字、`第一章`+空行混合、无标题切分、超大 TXT。
- [ ] T1.3 `node --check` 通过（仅数据层+解析，不动 UI）。

## Phase 2 — 导入路由与 TXT 副本
- [ ] T2.1 routes.js 新增 `POST /novels/import-txt`：接收 `{ title, content }` → `parseTxtChapters` → 事务内建 novel + 批量插 chapters（chapter_index/title/content/word_count）→ 逐章 `writeChapterTxt`；解析无标题时返回 `splitted=true` 供前端提示；失败回滚。
- [ ] T2.2 e2e（mock-llm 不需要，纯解析）：导入 3 章 TXT → `GET /novels/:id` 章节数正确、word_count 非 0、`server/src/data/novels/{书名}/第X章-*.txt` 文件存在；无标题 TXT → 按字数分章 + `splitted=true`。

## Phase 3 — 改编方案生成
- [ ] T3.1 routes.js 新增 `POST /novels/:id/adaptation/plan`：建 `adaptation_jobs`（status=`drafting_plan`）→ `runLLMStream` 流式生成改编方案（复用强化版 extractJson）→ status=`plan_ready` → SSE 返回方案 + 进度事件。
- [ ] T3.2 prompts.js 新增 `ADAPTATION_PLAN_SYSTEM`：意图展开为逐章改造要点，输出 `{"chapters":[{chapter_index,title,actions}],"global_notes"}`。
- [ ] T3.3 e2e：mock-llm 返回方案 JSON → 落库 `adaptation_jobs.plan`、status=`plan_ready`；方案 JSON 解析失败一次即报错不无界重试。

## Phase 4 — 逐章改编与候选
- [ ] T4.1 routes.js 新增 `POST /novels/:id/adaptation/start`（接收确认后的 plan，job status=`adapting`）与 `POST /novels/:id/adaptation/next`（生成当前章候选：原文+意图+方案要点+前 N 章已采纳摘要 → 写入 `adaptation_candidates` → 推进 current_index 并更新进度）。
- [ ] T4.2 routes.js 新增候选操作路由：`POST /adaptation-candidates/:cid/accept`（backupChapter → 覆盖 chapters → writeChapterTxt → 更新摘要）、`:cid/skip`（保留原文）、`:cid/retry`（重新生成刷新候选）。
- [ ] T4.3 routes.js 新增 `GET /novels/:id/adaptation`（返回 job + 全部候选，供恢复进度）。
- [ ] T4.4 prompts.js 新增 `ADAPTATION_CHAPTER_SYSTEM`：注入「不可变锚点」（角色名清单 + 关键剧情点 + 新旧人名映射表）。
- [ ] T4.5 e2e（mock-llm）：start→next 逐章出候选 → accept 覆盖正式章节且 `chapter_backups` 有快照 → skip 保留原文 → retry 刷新候选 → 冲突时再次 start 返回 409 → 中断后 GET 恢复 job+候选。

## Phase 5 — 前端体验
- [ ] T5.1 Home.vue / SetupPanel.vue 新增「导入 TXT」入口（仅 .txt，读文本提交），store 新增 `importTxt` 成功后切到新书。
- [ ] T5.2 新增 AdaptDialog.vue 改编对话框：自定义意图文本域 + 模板下拉（爽文/换性别/悲剧结局/节奏加快/换世界观）+ 改编方案 SSE 流式展示。
- [ ] T5.3 ChapterArea.vue 章节工具条新增「改编」按钮；渲染候选对比视图（diff 依赖做增/删/改高亮），提供采纳/跳过/重试。
- [ ] T5.4 stores/editor.js 新增 `adaptation` 切片（job+candidates+currentIndex）与 action：adaptationPlan/adaptationStart/adaptationNext/acceptCandidate/skipCandidate/retryCandidate/loadAdaptation；纳入现有 slice 多书机制。
- [ ] T5.5 api/index.js 新增对应方法（复用 streamRequest）。
- [ ] T5.6 `npm run build` 通过；页面交互手测：导入→改编→方案→逐章候选→对比采纳全链路。

## Phase 6 — 打包回归
- [ ] T6.1 `node --check` + `prepare-deps.cjs` 通过。
- [ ] T6.2 重新打包 exe 并验证产物包含新路由与前端资源。
