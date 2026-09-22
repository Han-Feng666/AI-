# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while fixing the white-screen issue after installing the desktop app (Electron packaged build showed a blank window with no content)
- Category: Troubleshooting & Debugging
- Instructions:
  - White-screen root cause pattern: a Pinia options store with a `get xxx()` getter mistakenly placed inside the `actions` object (instead of `getters`) makes Pinia evaluate the getter during store setup, accessing state before initialization and throwing `TypeError: Cannot read properties of undefined`; this aborts app mount and produces a fully white window. See web/src/stores/settings.js (fixed by moving isConfigured to getters).
  - Verification flow for packaged builds in this repo: (1) build frontend with `cd web && npm run build`; (2) run `node scripts/prepare-deps.cjs` in desktop; (3) build `npx electron-builder --linux dir`; (4) run the packaged backend fork + BrowserWindow from `desktop/release/linux-unpacked/resources/server/index.js` under `xvfb-run` with `--no-sandbox`, then inspect `document.getElementById('app').innerHTML` — empty `<!---->` means Vue mount failed, non-empty `app-shell` means OK.
  - Packaged backend serves frontend from `resources/web/dist`; on Linux app data/logs live in `~/.config/ai-novel-studio-desktop/` (render.log records renderer console errors, server.log records backend).
  - Electron 37 `webContents` 'console-message' event now uses a single Event object argument (event.message / event.level / event.sourceId / event.lineNumber); the old 5-arg signature logs undefined and emits a deprecation warning.

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while rebuilding the Windows NSIS installer (electron-builder NSIS target failed with ERR_ELECTRON_BUILDER_CANNOT_EXECUTE)
- Category: Build Methods / Environment Configuration
- Instructions:
  - NSIS target on Linux requires a working 32-bit wine: electron-builder compiles a temp installer, runs it under wine to extract `__uninstaller.exe`, then embeds it. A ~143KB `Setup *.exe` in release/ means the build FAILED at uninstaller extraction (a complete installer embeds the app payload and is tens of MB).
  - On this environment the stock wine (wine-8.0) shipped without wine32. Fix: `dpkg --add-architecture i386 && apt-get update && apt-get install -y wine32:i386` (software-install class, allowed). Then `wineboot` crashed with `could not load kernel32.dll` until a fresh prefix was created: `export WINEPREFIX=/tmp/winefresh && wineboot --init` (takes 3-5 min; rundll32 setupapi stage is slow). The default `~/.wine` prefix was corrupted by the failed attempts and must be replaced.
  - electron-builder 26 `toolsets.wine: "1.0.1"` downloads a wine-11 bundle that is NOT usable on this system (only 36 DLLs; wineboot fails to load ntdll.dll/wineboot.exe c0000135). Do not use it — instead set `USE_SYSTEM_WINE=true` plus a healthy WINEPREFIX env when running `npx electron-builder --win nsis`.
  - Win NSIS build command that works here: `cd desktop && export WINEPREFIX=/tmp/winefresh USE_SYSTEM_WINE=true WINEDEBUG=-all && npx electron-builder --win nsis`. Verify by checking `release/AI小说工坊 Setup 1.0.0.exe` size (tens of MB) and that `release/win-unpacked/resources/web/dist/assets/` contains the fixed frontend hash.
  - Do NOT uninstall/upgrade the wine-11 toolset cache; simply avoid the `toolsets.wine` config.
  - Verified end-to-end with the packaged win-unpacked backend fork + BrowserWindow (renders app-shell, HTML len ~9117).

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while fixing 5 UX bugs in the AI novel studio desktop app (model auto-fetch, plan-generation param mixups, form state loss, collapsed panels unclickable, unusable AI chat)
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - "Like code tools" model picker pattern: frontend triggers a model auto-fetch on blur of Base URL / API Key (500ms debounce + dedupe) via `POST /api/settings/models`, which proxies `{baseUrl}/v1/models` and normalizes both OpenAI `data[]` and bare-array responses; the model select is dropdown-first with `filterable + allow-create` so manual entry remains a fallback. Empty API key must not send a blank `x-api-key` header.
  - Plan-generation param bug: SetupPanel form defaults must stay decoupled from the persisted novel (`planForm` ref synced from novel via watch with a `syncing` flag to prevent the auto-save watch from echoing back); auto-save drafts with a 600ms debounced deep watch calling `saveNovelSettings`; backend `/novels/:id/plan` reads body `chapterWordCount`/`targetChapters` first (`Number(x) || novel.chapter_word_count || 2000`), so the persisted values drive generation and are never overwritten by the LLM plan output.
  - extractJson (server/src/prompts.js) robustness: strips ```json fences, converts Chinese punctuation (，： “” ‘’) to ASCII, strips control chars, drops trailing commas, and falls back to single-quote→double-quote relaxation plus object/array slicing. Verified end-to-end against code-block-wrapped and mixed-quote weak-model JSON with a streamed mock LLM (SSE `/v1/chat/completions` on localhost) — pass. Bare unquoted string values (e.g. `genre: 玄幻`) are out of scope and stay unsupported.
  - Collapsed panel bug: `.left-col.collapsed`/`.right-col.collapsed` with `width:0; overflow:hidden` clips the toggle button so it becomes unclickable; keep `width:8px; overflow:visible` instead.
  - Windows packaging DNS fix: `getaddrinfo ENOTFOUND release-assets.githubusercontent.com` during electron-builder download is solved repo-side by `desktop/.npmrc` with `electron_mirror=https://npmmirror.com/mirrors/electron/` and `electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/`; rebuild happens on the user's Windows machine (F:\小说\workspace\desktop), not in this Linux env.

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while fixing "cannot auto-fetch available models" and "plan generation stuck at 构思世界观 then AI 返回格式异常" in the AI novel studio
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - Model-list endpoint bug: `POST /api/settings/models` must not blindly append `/v1/models`. Provider presets differ — openai/qwen/moonshot/ollama baseUrl already end in `/v1`, deepseek/zhipu do not. Blind append produced `https://…/v1/v1/models` → 404 → "获取可用模型列表失败". Fix: strip a trailing `/chat/completions`, then try `${root}/v1/models` and `${root}/models` in order (dedupe `/v1`), normalizing both `data[]`, bare-array, and `{models:[]}` shapes. Verify both a `/v1`-suffixed and non-suffixed baseUrl resolve.
  - Plan generation must be split into stages, because `NOVEL_PLAN_SYSTEM` asked for one JSON containing ALL chapters; with many target chapters (e.g. 446) the output exceeded maxTokens(8192) and the truncated JSON always failed `extractJson` → the "AI 返回格式异常，正在重试解析…" loop (retry truncates the same way). Fix in server/src/routes.js `/novels/:id/plan`: (1) skeleton stage via `PLAN_SKELETON_SYSTEM` (title/genre/world_view/outline/characters/relationships, no chapters), then (2) chapter batches of ≤30 via `PLAN_CHAPTERS_SYSTEM` using a `buildSkeletonBrief()` text snapshot, emitting granular `{type:'status'}` events per stage. `extractJson` (prompts.js) already tolerates code fences, Chinese punctuation, single quotes, trailing commas.
  - Frontend must surface progress: SetupPanel renders `store.busyLabel` (stage status) plus a scrollable `store.genStream` live view so users see "正在构思世界观、角色与剧情大纲…" and "正在规划章节 1-30…" instead of a frozen button; editor.js `generatePlan` forwards backend status→busyLabel and delta→genStream.
  - Settings.vue model auto-fetch triggers on both `@input` (debounced 600ms) and `@blur`; a failed/empty auto-fetch shows an inline `fetchError` banner under the model field instead of silently dropping, so users see the real HTTP reason.
  - Verification harness: mock OpenAI-compatible SSE server that branches on the user prompt ("请规划第 X 至第 Y 章" → chapter array; otherwise skeleton) proved 75 chapters = skeleton + 3 batches of 30/30/15 all parse and persist.

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while validating real LLM gateway (tokenrhythm.studio, model deepseek-v4-flash) and adding usability features ("目标章节数" ambiguity, left nav stats)
- Category: Troubleshooting & Debugging / Build Methods / Workflow
- Instructions:
  - extractJson brittle against English DOUBLE QUOTES used inside Chinese string values (e.g. `"名为"灰烬之灾"的"`): PLAN_SKELETON_SYSTEM itself contains English-quote examples (line 108 "XX之X""XXX录") that induce models to emit unescaped `"` inside string values, breaking JSON.parse. Fix: in server/src/prompts.js extractJson, drop the old `.replace(/“|”/g, '"')` and `.replace(/‘|’/g, "'")` (they turn LEGAL Chinese quotes into bare English quotes and CAUSE damage); instead normalize only `,`/`:` punctuation, then repair English quote pairs INSIDE Chinese context via a regex whose anchor/-lookahead are Chinese chars/Chinese punctuation (NOT `\s` or `,`/`:` — those match JSON structure like `"desc": "..."` and would destroy field-value quotes). Working pattern: `.replace(/([\u4e00-\u9fff。；、！？…（）“”「」])["']([^"'\n]{1,40}?)["'](?=[\u4e00-\u9fff。；、！？…（）“”「」])/g, '$1“$2”')`. Regression: 5/5 OK on real gateway; mock still 45/45.
  - tokenrhythm.studio is an OpenAI-compatible 中转站 carrying reasoning models (deepseek-v4-flash delivers a `reasoning_content` field +_SEP_ usage chunks where `choices[0].delta.content` may be empty for many chunks); llm.js consumeStream already tolerates empty-content/usage chunks with optional chaining, no change needed to support it. Each plan stage with reasoning model needs generous maxTokens (8192 default is fine), but a tiny test max_tokens=200 yields empty content (consumed by reasoning) — do not use for validation.
  - "目标章节数" is genuinely ambiguous: it means FULL-BOOK total chapter count (AI generates a complete chapter outline up to that number in the plan stage; chapters are created as "planned" then written one by one). Frontend fields renamed to "全本总章数" in both SetupPanel.vue and Home.vue create-dialog, with a tooltip explaining "AI will first plan the complete chapter outline of the whole book". Backend target_chapters semantics unchanged.
  - Left nav (NavBar.vue, 92px icon rail) anchors work via store.setWorkspace(id); added a "统计" (stats) item mapped to a new StatsPanel.vue in the center workspace-pane (Editor.vue v-else-if). Stats are computed purely from existing store state (totalWords getter, chapters, novel, characters, foreshadowings): no new backend endpoints. Editor.vue workspace dispatch must keep adding new ids in the v-else-if chain.

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while auto-compressing novel context so authors no longer need to decide when to compress manually
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - Auto-compress design (server/src/lib.js `shouldAutoCompress(novel, config, recentChars)` pure fn + routes.js `compressNovelContext(novel, config, {send,ctrl})` shared helper): trigger when `autoCompress===true` AND `context_compressed!==1` AND recent-3-chapters char count ≥ `max(4096, (contextBudget - maxTokens - 4096)) * compressThreshold * 1.5`. Default threshold 0.5 → chars budget ~15360 with ctx 32768/maxTok 8192 (~8 chapters at 2000 chars/ch, ~4 at 4000). After first compress sets `context_compressed=1` + `compressed_upto_chapter=N`; subsequent compresses use the INCREMENTAL path (every 5 new chapters), unchanged. Manual `/compress` route + Editor button coexist with the auto path.
  - The auto-compress block lives at the END of generateChapter (after summary/key-moments/foreshadowing writes), so it sees fresh `word_count`s; it calls shouldAutoCompress with recent3 chars summed from `chapters` then invokes `compressNovelContext` and emits `{type:'status',message:'上下文已自动压缩为故事简报，后续生成将更省 tokens'}` on success. Settings row: `autoCompress` switch + `compressThreshold` number (0.2–0.9) in Settings.vue; persisted via the existing `llm_config` blob (no new columns).
  - Mock LLM branch routing gotcha: when simulating multi-stage novel generation, route by the SYSTEM prompt identity (e.g. `sys.includes('中文小说作者')` for body, `sys.includes('剧情规划师')` for chapters, `sys.includes('创作主编')` for skeleton) — routing by user-prompt keywords breaks because body-stage user prompts are long (13k chars) and also contain "伏笔"/"关键剧情" bait from injected kmBlock/foresBlock, causing the wrong else-if to fire and returning a 5-char "本章梗概。" that gets persisted as chapter content. The end-to-end PASS proves context_compressed==1, compressed_upto_chapter==3, and the SSE status sequence includes "已写章节较多，正在自动压缩上下文… → 正在压缩 N 章内容… → 上下文已自动压缩为故事简报".

[Project Knowledge Summary]
- Date: 2026-08-06
- Context: Discovered by Agent while executing the spec at .monkeycode/specs/stability-and-manager-rewrite/ (multi-book parallel + plan versioning + Manager tool-use + cross-book linkage rewrite). Phase 1-4 done, Phase 5-11 pending.
- Category: Build Methods / Workflow / Troubleshooting & Debugging
- Instructions:
  - Job-ification (server/src/jobs.js): createJob(novelId, stage, params)/updateJob(id, patch {status,progress,word_count,stream_cursor,error,result_ref})/getJob/listJobsByNovel/getActiveJobByNovel/listActiveJobs/tryCreateJob (returns `{conflict:true, jobId}` if a running job for same novel+stage exists — Phase 2 routes return 409 on conflict). Memory `subscribeJobEvents(cb)` pub/sub drives GET /jobs/stream SSE (multi-book single-connection broadcast). Jobs are durable across client disconnects: client reconnecting calls `GET /novels/:id/job` → restore busy/busyLabel/genStream from `status='running'`. routes.js keeps local `runLLMStream` (defined inline at routes.js:161, NOT exported — don't try to import from llm.js).
  - Plan versioning (server/src/planVersions.js): revise route writes candidate snapshot to `plan_versions` (kind='revise', accepted=0) and DOES NOT call applyPlan; user must `POST /novels/:id/plan/versions/:vid/accept` which calls applyPlan + sets accepted=1 + appends plan_change_log. `rollback` only allows accepted=1 versions. `getLatestPending` returns most recent accepted=0; SetupPanel (Phase 7) is supposed to show a "上次有 1 个待采纳方案" banner. Plan draft form persists to `plan_drafts` via PUT/GET /novels/:id/plan/draft.
  - PLAN_REVISE_SYSTEM (prompts.js) injects an immutable anchor in revise user prompt listing current `characters[].name` and chapter titles; the system prompt says names/章节标题 MUST stay unless user feedback explicitly mentions them — kills the "AI 改着改着主角改名/主线错位" symptom. revise also removed the old `chat retry → extractJson(plan2)` infinite loop: parse-fail now returns error + raw output once, leaving old plan intact.
  - Store multi-book parallel (web/src/stores/editor.js): added internal `_slices: Map<novelId, slice>` + `_persistentFields` list + `_saveSlice/_loadSlice` + new `switchTo(id)` action (saves current top-level slice to map by novelId, loads target slice into top-level state; loadNovel still works but Editor.vue onMounted + watch(novelId) now call `switchTo` so切书时旧 novel 的 busy/genStream/chat 不被复用顶层覆盖). `syncJobState()` calls api.getActiveJob on load to restore busy state after refresh/切回. Top-level state fields (`store.novel/store.busy`…) remain as View of active slice — 190+ existing call sites kept unchanged.
  - Home.vue job badge: `activeJobs: {}` ref keyed by novel_id polled from `api.listActiveJobs()` every 4s; `.job-badge` overlay with pulse dot on `.cover` shows "正在生成方案/正在写章节…". This is the visible proof of multi-book background parallelism on the书架.
  - Phase 5-11 pending per tasklist.md: tool-use `/manager/chat` route + tools.js registry + pending_tool_calls auth gate + Manager store + ChatPanel rewrite + SetupPanel version diff UI + 图自绘 SVG (relationship_nodes coords persist) + StyleImportDropzone + length_class 短/中/长 + GENRES/PRESET_STYLES 扩展 + shared_characters upgrade/introduce + workspaceEventBus + final Windows pack.

[Project Knowledge Summary]
- Date: 2026-08-06
- Context: Discovered by Agent while building Phase 6-10 front-end (manager store / SetupPanel diff / SVG repo graph / style dnd / event bus)
- Category: Build Methods / Workflow & Collaboration / Environment Configuration
- Instructions:
  - Phase 6：前端 `stores/manager.js` 创建，独立于 editor store —— ChatPanel 不再被 `store.busy` 阻塞（REQ-04），工作区 AI 工作时仍可对话。store state {messages, pendingToolCalls, busy, replyStream, loadedNovelId} + actions {load, send, authorize, reject, clearLocal}。actions.send 走非流 API `/manager/chat` 一次返回 reply + pendingToolCalls, scene: ChatPanel `quickPrompts` 数组 + 回车/Ctrl+Enter 发送模式（`settings.managerSendBy` ∈ {enter, ctrlEnter}）后端透传存 settings 表 `manager_send_by`.
  - Phase 7：SetupPanel 增加"待采纳横幅" + "diff 对话框" + "历史版本抽屉"。editor store 接受 `pendingVersion`（id/versionNo/feedback/snapshot/createdAt）—— revise 路由现在返回 `{data: {version}}` 而非直接落库——前端 SetupPanel 显示 `diffs` (title/genre/world_view/outline 双栏对照，红/绿区域) + 角色/章节新增/移除 pills。`acceptPendingVersion()` 调 `/api/plan/versions/:vid/accept` → 后端 applyPlan 落库；`rollbackToVersion(versionId)` 调 `/api/plan/versions/:vid/rollback` 只允许 `v.accepted` 的版本回滚。
  - Phase 8：`RelationshipPanel.vue` 完全重写——抛弃 echarts（Editor.js chunk 从 1.1MB 降到 95KB，节省 900KB），改为自绘 SVG：`<svg viewBox=0 0 600 380>` + `<g transform=translate scale>` viewport 缩放 + `<circle>` 节点可拖拽 + 滚轮缩放 + 空白平移。后端新增 3 路由 `GET /novels/:id/relationship-nodes`、`PUT /novels/:id/relationship-nodes/:cid` (单点更新)、`PUT /novels/:id/relationship-nodes` (批量) —— 坐标存在 plan_versions 表的 `relationship_nodes` 子表（id/novel_id/character_id/x/y + UNIQUE constraint）。前端拖动节点 mouseup 后自动 `saveRelNode(novelId, cid, x, y)` 持久化。
  - Phase 9：`utils/format.js` 重拳调整 GENRES (50+ 选项) + PRESET_STYLES (35 选项含"老白文""二次元中二味""方言口语化"等) + 新增 LENGTH_CLASSES [{key:short/medium/long, label:短篇/中篇/长篇, chapterWordCount,targetChapters}]。SetupPanel 显示 3 个长度单选卡片（短篇/中篇/长篇连载），点击把 chapterWordCount/targetChapters 推荐值写入表单。后端 plan 路由 + saveNovels 路由 (PUT /novels/:id) 都接收 lengthClass/length_class 字段，UPDATE novels 长度列 (Phase 1 已 `ensureColumn('novels','length_class')`)。"创作风格"区改为可拖到目标区：拖动预置 tag (draggable=true, setData text/style-preset) 到 `<div class=style-target @drop>`，drop 处理 push 数组允许双击×移除；点击 tag 也可加入。
  - Phase 10：`utils/workspaceEventBus.js` ESM 单例 emitter，事件类型 'novel:planGenerated' / 'novel:planAccepted' / 'novel:outlineUpdated' / 'novel:characterUpdated' / 'novel:chapterGenerated' / 'novel:reviseRequested' / 'novel:generateChapterRequested'。editor store generatePlan/acceptPendingVersion/rollbackToVersion 各发对应事件；manager store authorize 完成时根据工具名发 outlineUpdated / characterUpdated / reviseRequested / generateChapterRequested；ChatPanel.vue onMounted 订阅 outlineUpdated/characterUpdated emit 后调 editor.refresh() — Manager 决定改大纲后 SetupPanel 自动同步不需要用户手动刷新。
  - Windows 打包：本环境 Linux 可交叉打包 Windows NSIS 安装包（见下方案，已实测成功），无需用户在本机执行。若确需在用户 Windows 本机重建（F:\小说\workspace\desktop）：(1) 同步代码 (pull repo + 把 web/dist 拷到 electron resources/app 或直接 `pnpm install && pnpm build && pnpm run dist:win`)；(2) `cd desktop && yarn install`；(3) `cd ../web && npm install && npm run build`；(4) `cd ../desktop && yarn electron:build`。(3) 必须先做完，否则 desktop packager 拿不到 dist。e2e mock-ac 在 /tmp/opencode/mock-ac.js 永久可用。


[Project Knowledge Summary]
- Date: 2026-08-06
- Context: Discovered by Agent while building Manager tool-use route (Phase 5 of stability-and-manager-rewrite spec)
- Category: Build Methods / Troubleshooting & Debugging
- Instructions:
  - llm.js `chat()` signature extended: now accepts `tools` (openai fn array) + `toolChoice`, and returns `{content, finishReason, toolCalls: [{id, name, args}]}`. Only NON-STREAM calls should pass tools — streaming tool_call delta handling is deferred (Manager uses non-stream). Trim-messages the budget normally. Same `runLLMStream` inline at routes.js:161 still does streaming + does NOT support tool_calls; Plan/revise/generateChapter continue using it.
  - tools.js exports `toolRegistry` mapping name→{needsAuth, schema, executor}; 7 tools (get_novel_progress, list_shared_characters, introduce_shared_character, update_outline, update_character, request_revise, request_generate_chapter). `getToolSchemas()` returns OpenAI-shape array. update_character executor同步回写 shared_characters 表（避免分叉）via `c.shared_id` foreign key列（Phase 1 已加 `shared_id`）.
  - /manager/chat flow: insert user → fetch recent manager_messages (filtered by current novel_id OR NULL for cross-book) → call chat(,tools) → for each tool_call: read-class executor runs directly + persisted as manager_messages role='tool' (tool_call_id intact); write-class generates randomUUID callId + INSERT INTO pending_tool_calls(status='pending') + pushes pending → IF any pending: return {reply, pendingToolCalls} (frontend shows auth bar); ELSE (all read) → second non-stream chat WITHOUT tools → LLM gives final answer → persist + return.
  - POST /manager/tool/:callId/authorize → run executor(args) → UPDATE pending_tool_calls status='done' result=JSON → INSERT manager_messages role='tool' tool_call_id=callId content=result. POST /reject → status='rejected' + manager_messages role='tool' content=`{rejected:true}`. Both paths let LLM see the outcome in next turn (history includes role='tool' rows with tool_call_id carried forward).
  - Mock LLM testing gotcha: when simulating multi-turn tool-use, the mock must read user content from `messages.findLast(role='user')` NOT `find(role==='user')` — find() returns the FIRST user message ever inserted into history, so subsequent calls match stale prompts (kept returning "查一下进度" branch when sending "改大纲"). Fixed in mock-ac.js line 26-27 via `findLast?.(...) ?? filter().pop()`. Real LLM providers don't have this gotcha (they read the latest message).
  - End-to-end PASS: read class (get_novel_progress) → manager_messages has 1 role='tool' row with title/status/chapterCount → reply "操作已执行". Write class (update_outline) → pendingToolCalls returned → authorize → novel.outline updated to "新的剧情大纲：英雄觉醒" in DB → manager_messages gets role='tool' content=`{ok:true,title}`. reject → status='rejected' + tool history shows {rejected:true}. Verified novel id=1 row outline 列真实写入.
  - Phase 6 pending: 前端 manager store + ChatPanel 行动卡片 + 解耦 store.busy 阻塞 + Enter/Ctrl+Enter send 选项. Phase 7 SetupPanel diff/采纳 UI. Phase 8 自绘 SVG 关系网. Phase 9 StyleImportDropzone + length_class + GENRES 扩展 + shared_characters upgrade path 后端 endpoints. Phase 10 workspaceEventBus. Phase 11 windows pack.

[Project Knowledge Summary]
- Date: 2026-08-07
- Context: Discovered by Agent while implementing P0-P3 long-form memory infrastructure
- Category: Build Methods / Architecture
- Instructions:
  - 7 张新表在 db.js DDL 区（shared_characters 表后）：chapter_summaries(level 0-3 分层摘要) / chapter_chunks(RAG 分块) / novel_facts(结构化事实+版本链 superseded_by) / character_timeline(角色变化) / style_drift_log(文笔漂移) / novel_timeline(故事时间线). foreshadowings 加 ensureColumn expected_recall_chapter.
  - memory.js 核心模块：saveChapterSummary / buildHierarchicalContext(近5章用L0→更远用L1节→L2卷→L3部) / compressSummaryLevel(每5章触发L1压缩/25章L2/100章L3) / saveFact+checkFactConflicts(同subject+key变更时旧值superseded) / formatFactsBlock / saveCharacterChange / formatTimelineBlock / detectStyleDrift(LLM对比早期vs最近章节文风0-1分) / saveTimelineEvent / formatTimelineSummary / buildEnhancedMemoryBlock(组合全部记忆块注入context).
  - rag.js 纯JS TF-IDF检索：tokenize(中文2-gram+单字) / buildTfIdf(IDF+归一化向量) / cosineSim / storeChunks(按段落~500字分块+提取高频2-gram关键词) / retrieveRelevant(query top-K) / formatRagBlock. 无外部embedding API依赖.
  - routes.js 章节生成路由集成点：生成前(profileBlock后)注入 enhancedMemBlock + ragBlock；生成后(character profile更新后)依次执行 P0-1 saveChapterSummary+compressSummariesIfNeeded / P0-2 storeChunks / P1-1 fact抽取+冲突检测 / P1-2 char变化抽取 / P2-1 伏笔回收预测 / P2-2 detectStyleDrift(每10章) / P3 时间线抽取. 全部 try-catch 不阻塞.
  - 新增6个查询API：GET /novels/:id/summaries /facts /character-timeline /style-drift /timeline /enhanced-memory + POST /rag-search.
  - prompts.js 新增5个提取提示词：FACT_EXTRACT_SYSTEM / CHAR_CHANGE_EXTRACT_SYSTEM / FORESHADOW_RECALL_PREDICT_SYSTEM / TIMELINE_EXTRACT_SYSTEM / HIERARCHICAL_SUMMARY_SYSTEM.
  - e2e验证：glm-5.2生成第11章718字→chapter_summaries 6条+chapter_chunks 2章+novel_facts 2条+character_timeline 9条(7条来自ch11真实抽取)+novel_timeline 3条(1条来自ch11). ch12增强记忆块1075字含分层摘要+硬事实+角色变化+故事时间线.

[Project Knowledge Summary]
- Date: 2026-08-07
- Context: Discovered by Agent while implementing quality enhancement + cross-model consistency
- Category: Build Methods / Troubleshooting & Debugging / Architecture
- Instructions:
  - glm-5.2 是思考模型，默认生成 reasoning_content（思考 token），会吞掉 max_tokens。thinking:{type:'disabled'} 和 enable_thinking:false 都无法关闭。修复：llm.js chat() 函数在非流式响应中检测 content=='' && finishReason=='length' && effectiveMax<4000 时，自动用 max(4000, effectiveMax*4) 重试一次。流式调用不受影响（streaming delta 包含 content）。
  - 质量增强架构（3层防 AI 味 + 跨模型一致性）：
    1) 生成前注入：ANTI_AI_STYLE 铁律(强化版，含具体好/坏示例) + 小说宪法(novels.constitution, 每20章重建) + 角色语音档案(character_voices表, 每章提取) + 跨模型一致性铁律("无论你是哪个模型，必须匹配本作文风基准")。buildChapterSystem 现接受 opts={constitution, characterVoices}。
    2) 强制质量门（不再依赖 config.autoPolish）：生成后先 runDetection → score>30 或黑名单命中才 iteratePolish → 达标为止。ch12=15分通过，ch13=0分满分。
    3) 生成后校验：角色语音提取(CHARACTER_VOICE_EXTRACT_SYSTEM) + 剧情一致性校验(PLOT_CONSISTENCY_CHECK_SYSTEM, 检查角色/事实/时间/伏笔/知识边界5维度)。
  - 新增表/列：character_voices(novel_id+character_name UNIQUE, speech_pattern/vocabulary/catchphrases/tone/updated_chapter) + novels.constitution(ensureColumn)。
  - 新增提示词：CHARACTER_VOICE_EXTRACT_SYSTEM / PLOT_CONSISTENCY_CHECK_SYSTEM / NOVEL_CONSTITUTION_BUILD_SYSTEM(输出角色铁律/世界铁律/剧情铁律/风格铁律4板块)。
  - memory.js 新增函数：saveCharacterVoice(ON CONFLICT upsert) / getCharacterVoices / formatCharacterVoices / getConstitution / buildConstitution(从characters+facts+keyMoments+foreshadowings+voices合成) / checkPlotConsistency(5维度校验)。
  - 角色语音跨章一致：林风 ch12="极简短/单字回应/沉默寡言" → ch13="几乎不开口/仅以单字应答/沉默寡言"（一致更新）。周老六 ch12="短句连珠/粗直老辣" → ch13="短句为主/祈使句/老江湖"（一致更新）。新角色老船夫自动提取="极简/一问一答/不寒暄"。

[Project Knowledge Summary]
- Date: 2026-08-13
- Context: Discovered by Agent while enhancing plan-generation continuity + chapter writing tone control
- Category: Build Methods / Architecture
- Instructions:
  - 方案生成批次连续性：批量规划章节时把上一批末尾 6 章的概要作为「【前情】」注入下一批 user prompt，防止批次间剧情脱节/重复。`routes.js` plan 路由 while 循环内 prevTail = allChapters.slice(-6)。
  - 章节 emotion/arc_hint 字段全链路：chapters 表 ensureColumn 加 emotion/arc_hint 列；PLAN_CHAPTERS_SYSTEM 要求 emotion 具体到开收场情绪、arc_hint 点明弧线+伏笔；applyPlan 落库时写入；章节创作时若 existing.emotion/arc_hint 存在则注入 userPrompt「本章情绪基调/本章推进的剧情线」。NOVEL_PLAN_SYSTEM 与 PLAN_REVISE_SYSTEM 的章节结构也含 emotion/arc_hint（修订时 story_arcs 字段加入输出结构防丢）。
  - 新增 AI 味检测维度（lib.js）：scanSentenceOpeners（连续≥5句同开头、全章句首同字占比>45%）与 scanTransitionOveruse（转折连词全文≥12处、于是/然后+人称≥8处），已挂入 scanAiPatterns。ANTI_AI_STYLE 新增第12/13条铁律（句首单调、转折连词堆砌），AI_DETECT_SYSTEM 检测类别扩展到 13 类。
  - 剧情逻辑修复：CHAPTER_SYSTEM 新增【剧情逻辑自洽】铁律（关系建立过程/异常反应/因果链/时空/力量体系/设定一致/信息边界）；PLOT_CONSISTENCY_CHECK_SYSTEM 从 5 维扩展到 10 维（新增因果/关系/反应/空间/力量逻辑）；新增 PLOT_FIX_SYSTEM + iteratePlotFix 修复循环，检测到 major_issues 时自动修复章节内容并复检落库。
  - 打包版本号规则：package.json 里的 version 字段（desktop/package.json 和 server/package.json），每次打包前递增。当前 1.0.0，下一个 1.0.1，满十进一（1.0.10 → 1.1.0）。两个 package.json 的版本号要同步。
  - 第三轮全面增强（写作/方案/剧情细节）：
    - 场景节拍接入章节生成：生成正文前调用 CHAPTER_BEAT_SYSTEM 拆解 3-6 个 beat（scene/location/characters/action/sensory_detail/purpose/tone），强格式化为【本章场景规划】注入 userPrompt。beats 失败 try-catch 降级不阻塞。
    - 章节 hook 字段全链路：chapters 表新增 hook 列；PLAN_CHAPTERS_SYSTEM/NOVEL_PLAN_SYSTEM/PLAN_REVISE_SYSTEM 章节结构含 hook（本章结尾钩子，具体到物/人/事件）；applyPlan 落库；章节创作 prompt 注入"本章结尾钩子"，CHAPTER_SYSTEM 第 17 条要求 hook 落实到具体画面、第 18 条要求每章至少 1 个记忆点画面。
    - cleanAiText 新增规则：相邻重复字清理（他他/了了/的的等，紧跟中文后续才收拢，避开嘿嘿/哈哈拟声）+ 中文字间多余半角空格清除。
  - 第四轮全面增强（写作去AI味 + 改编多方案）：
    - ANTI_AI_STYLE 扩到 15 条：新增"不要每一帧都写满"（省略伸手-够到-端起的中间步骤）、"句尾'了'/'着'过载"、"对话标签别花式代替（真人多用'他说''她说'）"。AI_DETECT_SYSTEM 同步扩到 15 类。
    - lib.js 新增 scanVerboseFrames：动作逐帧扫描（连续≥4个短动作句）+ 句尾"了"过载（>35%句子以"了"结尾），已挂入 scanAiPatterns。
    - 改编多方案：ADAPTATION_PLAN_SYSTEM 改为一次生成 3 个方案（minimal稳健/bold大胆/fresh焕新，各有 intent_summary/approach/global_notes/chapters）；adaptation_jobs 表新增 plans 字段（JSON 数组）；新增 POST /adaptation/select-plan 接口把选中方案写入 job.plan 供逐章改编；GET /adaptation 兼容返回。前端 AdaptDialog 加多方案卡片选择 UI；Editor.vue 支持 /novel/:id?adapt=1 自动弹窗询问是否改编；Home.vue 导入完成后跳转带 ?adapt=1。

[User Instruction Summary]
- Date: 2026-08-13
- Context: 用户提供「网文标点强制规范」，要求所有小说生成遵循
- Instructions:
  - 网文标点规范（必须强制应用到所有正文生成/润色/修复）：
    1. 连贯的同一段心理/动作/对话用逗号衔接，不得用句号切短句；只有完整语义结束、场景切换、想法彻底终止才用句号（"他抬起头，目光望向远处" 而非 "他抬起头。目光望向远处。"）
    2. 禁止连续三句以上超短独立陈述句句号连发（"他走了。她来了。天亮了。"）
    3. 对话标点：动作前置"他低声道：'xxx。'"；动作穿插"'xxx，'他笑了笑，'xxx。'"；禁止对话标签后又用句号切开动作
    4. 分号能不用就不用，一律优先逗号；省略号只用"……"
    5. 禁止大量短句一句号一行（碎片化排版）
  - 落地位置：ANTI_AI_STYLE 第16/17/18条、AI_DETECT_SYSTEM 检测维度扩到17类（第16/17类）、POLISH_SYSTEM 第6条、PLOT_FIX_SYSTEM 内嵌铁律第5条、lib.js scanAiPunctuation（句号过度切割+分号滥用检测）、cleanAiText 规则7（"动作短句。身体部位短语"改逗号衔接，保守不误伤对话/真实收尾）。

[User Instruction Summary]
- Date: 2026-08-13
- Context: 用户提供「硬性写作约束 + 人物逻辑硬性规则」，要求不可违反
- Instructions:
  - 硬性写作约束（6条）：①不凭空创造没铺垫的人物/宝物/奇遇/冲突，突发剧情须有伏笔；②角色行动符合人设/实力/处境，禁止行为前后矛盾；③禁止开辟与主线无关的新支线；④不强行造无逻辑反转，冲突循序渐进；⑤不清楚前文信息时不脑补设定，维持现状；⑥不随意结束/开启恩怨与势力斗争，重大转折循序渐进。
  - 人物逻辑硬性规则（5条）：①角色认知局限，无上帝视角，不知道的事会有疑问；②初次相遇必带生疏警惕，禁止初识就如老友；③遇到反常现象（深夜闯入等）第一反应是疑惑/警惕/主动发问；④剧情承接上一章结尾事态，重大互动须有过渡铺垫；⑤所有行动对话贴合身份处境，杜绝脱离常识的无脑反应。
   - 落地位置：CHAPTER_SYSTEM 新增【硬性写作约束】(23-27条) 与【人物逻辑硬性规则】(28-32条)，以及流程要求第8条"硬性约束执行检查"；PLOT_CONSISTENCY_CHECK_SYSTEM 检测维度扩到14类（新增 invention凭空创造/side_plot无关支线/abrupt_turn越级转折/assumption脑补设定）；PLOT_FIX_SYSTEM 修法对照表补齐这4类修法。

[Project Knowledge Summary]
- Date: 2026-09-05
- Context: 持续增强小说生成质量，让文笔更自然、逻辑更严密
- Category: Build Methods / Quality Enhancement
- Instructions:
  - 质量门加严：
    1. AI_SCORE_PASS_DEFAULT 15→10（更严格的达标阈值）
    2. AI_MAX_ROUNDS 3→4（增加润色迭代轮数）
    3. MAX_AUTO_REGENERATE 2→3（增加整章重生成次数）
  - 章节创作提示词增强：
    1. CHAPTER_SYSTEM 新增 12 条"拒绝"规则：形容词堆叠、情绪标签化、对话修饰语堆叠、心理活动长篇、句式重复、副词堆砌、空泛搭配、时间套话、场景无锚点、收尾升华
    2. CHAPTER_BEAT_SYSTEM 新增：场景地点与剧情逻辑一致、时间递进、角色行为符合常理
  - 润色系统增强：
    1. POLISH_SYSTEM 新增 6 条：心理活动克制、情绪外化、叙述留白、口语化停顿、场景锚定、收尾不升华
    2. WRITING_QUALITY_SYSTEM 新增 3 个维度：情感表达、场景构建、段落节奏
  - AI 检测系统增强：
    1. AI_DETECT_SYSTEM 新增 6 类：程度副词堆砌、空泛形容词套用、时间套话、场景元素错位、角色行为违背常理、对话修饰语堆叠
    2. ANTI_AI_STYLE 黑名单扩展至 200+ 高频词
  - 重生成优化：
    1. 因 AI 味/文笔生硬被拒时，强化首稿人味要求
    2. regenNote 区分 idx===1 的情况

[Project Knowledge Summary]
- Date: 2026-09-05
- Context: 全面审计代码并修复潜在问题 + 增强小说生成质量
- Category: Troubleshooting / Build Methods / Architecture
- Instructions:
  - 高危修复：
    1. longestCommonSubstring 完整 DP 矩阵（50000×50000 ≈ 20GB OOM）→ 改为滚动数组
    2. SSE keepalive 定时器异常循环 → 异常时调用 stopKeepalive
  - 中危修复：
    1. 新增 escapePromptInput 函数，转义用户输入中的【】──防止 prompt injection
    2. 前端 _abortHandlers Map 独立存储 abort 函数，避免 Pinia 序列化问题
    3. saveGenDraft/clearGenDraft 使用 originId 防止切书后草稿写入错误小说
    4. saveSamples/saveStyleSlices 使用事务包裹确保数据完整性
    5. tryCreateJob 时区问题：SQLite 本地时间字符串不加 Z 解析
    6. llm.js onDelta 回调异常时终止流并抛出，避免静默中断
    7. llm.js retryMax 限制为模型上下文窗口 80%，避免超限 400
    8. getKnowledgeByGenres LIKE 通配符转义防止非预期匹配
  - 质量增强：
    1. ANTI_AI_STYLE 黑名单扩展：新增动词类/神态类/修饰类共 200+ 高频词
    2. 新增 scanClauseMonotony（句式单调检测）、scanAdverbStack（副词堆叠检测）、scanEmptyAdjective（空泛形容词检测）
    3. POLISH_SYSTEM 新增 5 条改写要求：句式多样化、副词克制、空泛形容词替换、对话自然化、段落节奏
    4. 行为逻辑检测新增：普通人做出超能力行为、外行做出专业级的事、活人出现在不该出现的地方
    5. scanSceneElementMismatch 扩展：增加太平间/停尸房/火化炉等场景，增加 bridge 词
    6. regenNote 区分 idx===1 的情况：明确提示"本章是全书第一章，不得从上一章结尾续写"

[Project Knowledge Summary]
- Date: 2026-09-05
- Context: 用户反馈「风格库和知识学习库导入小说经常失败，生成创作方案有时候也会失败」
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - 风格库/知识库导入失败根因：
    1. `chunkWholeText` 分块过大（min 50K 字/块），单块 LLM 分析容易超时或返回截断
    2. `analyzeChunksRateLimited` 在 LLM 返回非 JSON 时静默丢块，导致全部块失败时抛「所有块分析均失败」
    3. `tagSlicesRateLimited` 计数逻辑错误：JSON 解析失败时既设了 fallback 又计为 failed
  - 创作方案生成失败根因：
    1. 预算裁剪 `sysContent.slice(0, ...)` 可能截断 UTF-8 多字节字符中间，导致系统提示词乱码，模型无法解析
    2. 新增的 conceptRule 增加了 userPrompt 长度，加剧了截断风险
  - 修复方案：
    1. `chunkWholeText`: minChunkSize 50K→15K，maxChunks 50→80，减少单块大小
    2. `analyzeChunksRateLimited`: JSON 解析失败时重试（最多 4 次），不再静默丢块
    3. `tagSlicesRateLimited`: 重写计数逻辑，每批结束后统一统计 tagged/failed
    4. 新增 `safeTruncateUtf8` 函数，避免截断 UTF-8 字符
    5. 预算裁剪改用 `safeTruncateUtf8` 替代 `sysContent.slice`

[Project Knowledge Summary]
- Date: 2026-08-13
- Context: Bug — 用户反馈「AI 管家显示触发重写但实际没有重写」
- Category: Troubleshooting & Debugging
- Instructions:
  - root cause：manager store authorize() 授权 request_revise/request_generate_chapter 后只 emit workspaceEventBus 事件『novel:reviseRequested』/『novel:generateChapterRequested』，但**没有任何组件监听这两个事件**（ChatPanel 只监听了 outlineUpdated/characterUpdated，仅做 editor.refresh）。后端 request_revise/request_generate_chapter 的 executor 也只返回 hint、不真正触发 Job。
  - 修复：ChatPanel.vue 新增 unsubRevise/unsubGen 两个事件监听，收到后调用 editor.revisePlan(feedback)/editor.generateChapter({mode:'next'}) 真正触发 SSE 重写任务；目标 novel 与当前打开不一致时先 ElMessageBox 确认并 editor.switchTo(target)；novel_id 缺省时回退当前书；editor.busy 时提示稍后。onBeforeUnmount 需同时注销这两个订阅。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈「切换/添加多个大模型要手动输入太麻烦」—— 多模型添加对话框原先纯手填 Base URL/模型名
- Category: Build Methods / UI
- Instructions:
  - Settings.vue 多模型对话框（showModelDialog）原有唯一入口 openAddModel/openEditModel，配置全靠手动输入 baseUrl/model。
  - 增强：在对话框顶部加「服务商预设下拉」（复用 PROVIDERS 常量：openai/deepseek/moonshot/qwen/zhipu/ollama/custom），选中自动填充 baseUrl+provider+默认 model；加「从默认主力复制」按钮（copyFromMain 把 store.llm_config 带入）；加「拉取模型」按钮 + 输入时防抖自动拉取（fetchMMModels → api.fetchModels，Ollama 免 Key 也可拉）；模型名输入框在有拉取结果时切换为 filterable el-select。新增样式 .mm-quick-bar/.mm-model-row。
  - 后端无需改动（/settings/models 已存在）。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈「设置页内容全挤左边、右边空、文字重叠」，且上下文长度上限 197K 太少
- Category: Troubleshooting & Debugging / UI
- Instructions:
  - 设置页布局根因：.settings-page 无容器样式（卡片靠左留白），.settings-card 固定 max-width:720px；.two-col 用写死 grid 1fr 1fr 在窄容器挤压文字重叠；.polish-switch/.model-row/.mm-quick-bar 等 flex 不换行；多处 el-form 内联 max-width:640px；.tips-card max-width:720px；.field-tip 负 margin -8px 上顶叠加。
  - 修复：Settings.vue 新增 .settings-page{max-width:1080px;margin:0 auto;width:100%} 居中容器；.settings-card/.tips-card 改 width:100%+box-sizing；.two-col 改 repeat(auto-fit,minmax(280px,1fr))；移除三处 el-form 的 max-width:640px；polish-switch/model-row/mm-quick-bar/mm-model-row/actions/preset-bar 加 flex-wrap；.polish-tip 加 flex:1+min-width:200px；.field-tip 负 margin 改 -2px。
  - 上下文长度选项扩到 2M：两处 el-select（单模型 + 多模型对话框）选项数组 [8192,16384,32768,65536,131072,196608,262144,393216,524288,786432,1048576,1572864,2097152]。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户希望「根据当前大模型自动获取最高的上下文长度」，避免手动选
- Category: Build Methods / UI
- Instructions:
  - 后端 /settings/models 只返回模型 id 数组，不含 context 窗口信息（各平台 /v1/models 无 context 字段）。
  - 实现：Settings.vue 新增 MODEL_CONTEXT_HINTS 前缀正则映射表（google/gemini→1M、gpt-4.1→1M、gpt-5→400K、gpt-4o/gpt-4→128K、o系列→200K、claude→200K、deepseek/qwen/glm/kimi/混元/文心/讯飞/llama/mistral/internlm→128K、doubao→256K、qwen2.5/llama3.1→128K 等）+ inferContextForModel(model) + autoFillContext(cfg)（推断到且当前值<推断值才覆盖，避免覆盖手选）。
  - 挂载点：单模型 onProviderChange / save / 模型 select @change / 手动 input @blur / fetchModels 自动选中后；多模型对话框 applyModelProvider / saveModel / 模型 select @change / input @blur / fetchMMModels 后。上下文长度下拉 label 标注"选好模型后自动填入最高支持值"。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: Bug — 生成时报错「模型 API 拒绝请求（HTTP 400）：'temperature' must be Float」
- Category: Troubleshooting & Debugging
- Instructions:
  - root cause：用户配置里的 temperature/maxTokens/contextLength 可能被存成字符串（历史数据/手输/JSON 序列化），chat() 构造 body 时原样透传字符串 → 部分服务商严格类型校验返回 400。
  - 修复（三重防线）：① llm.js chat() 构造 body 用 safeNum 规范化 temperature 与 max_tokens（null/空/非法→默认）；② lib.js 新增 normalizeLLMConfig（temperature→0.9、maxTokens→8192、contextLength→32768、max_tokens→8192、compressThreshold 夹在 0.1-0.95），getLLMConfig/saveLLMConfig 读写在净化；③ 各保存/路由入口净化：routes.js /settings(lang) 与 /settings(llm-presets 创建/更新/apply)、model_router.js saveModels/getModels/getTaskConfig 统一 normalizeLLMConfig。注意 toNum 须排除 null/空串（Number(null)=0 会误通过）。
  - 验证：字符串配置 '0.9'/'4096' 实际发出 temperature=0.9 number、max_tokens=4096 number。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈生成章节的剧情仍然莫名其妙，举了具体例子（苏怜空降知道内情、鬼魂无前因）
- Category: Build Methods / Troubleshooting & Debugging
- Instructions:
  - 根因分析：PLOT_CONSISTENCY_CHECK_SYSTEM 虽有"信息边界"和"凭空创造"维度，但 prompt 描述不够具体，LLM 把"知道内情的神秘人"当成恐怖小说惯例而放过；PLOT_FIX_SYSTEM 也缺少针对"信息渠道缺失"的修复方法；CHAPTER_SYSTEM 生成前约束未覆盖"信息角色必须有来源"。
  - 修复：① 增强 PLOT_CONSISTENCY_CHECK_SYSTEM 第9条（信息边界）与第11条（凭空创造）——加入"空降信息角色"具体示例，明确即使超自然/悬疑题材，神秘角色也必须交代信息来源（"我听我外婆说过"等），不能天然知道一切；issues.type 新增 source 类型。② 增强 PLOT_FIX_SYSTEM 修法表——新增"信息渠道缺失"修法（补一句知识来源）。③ CHAPTER_SYSTEM 硬性写作约束第28条——新增"信息角色必须有来源"规则，明确超自然题材不能豁免。人物逻辑规则编号顺延为 29-33。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈两个问题——①知识库/风格库导入一个后再导入没反应；②DeepSeek 方案生成格式异常经常失败
- Category: Troubleshooting & Debugging / UI
- Instructions:
  - 问题①根因：el-upload 组件内部保留文件状态，openImport/openCreate 未调用 clearFiles()，第二次打开对话框时旧文件残留导致无法触发新文件选择。
  - 修复：KnowledgeBase.vue 和 StyleLibrary.vue 的 script 加 uploadRef = ref(null)，template 的 el-upload 加 ref="uploadRef"，openImport/openCreate 中调用 uploadRef.value?.clearFiles()。
  - 问题②根因：DeepSeek chat 模型可能默认开启 thinking 模式，enable_thinking 只对 reasoner 模型关闭；章节批次 max_tokens=2048 可能被截断；重试未递增 max_tokens。
  - 修复：llm.js enable_thinking 匹配加上 deepseek-chat；routes.js skeletonMaxOut 改为 8192、chapterMaxOut 改为 4096；jsonFrom 重试时 mt *= 1.5 递增 max_tokens；FORMAT_REMINDER 加"不要输出 think/thinking 内容"。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈 AI 管家乱码 + 生成角色设定不遵循（苏怜设定古代女鬼却白天现代装出现）
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - 乱码根因：llm.js 非流式（non-streaming）chat() 路径未调用 unescapeUnicode，部分模型返回的 \uXXXX 序列未被转义为中文。流式路径已调 unescapeUnicode 但非流式遗漏。
  - 修复：llm.js 非流式 3 处 content 赋值（首次 + retry 2 处）均包 unescapeUnicode()。
  - 角色不遵循根因：CHAPTER_SYSTEM 的写作流程要求第8条只覆盖了"硬性约束检查"但未明确要求角色外貌/服装/活动时间严格遵循设定；PLOT_CONSISTENCY_CHECK_SYSTEM 第1条角色一致性未具体到"古代女鬼白天穿现代装"这类矛盾；PLOT_FIX_SYSTEM 缺少对应修法。
  - 修复：CHAPTER_SYSTEM 写作流程要求新增第9条"角色设定强制遵循"（外貌/服装/活动时间与设定一致）；PLOT_CONSISTENCY_CHECK_SYSTEM 第1条角色一致性加具体示例（古代鬼魂穿现代服装/白天出现）；PLOT_FIX_SYSTEM 修法表新增"角色设定矛盾"修法。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户要求内置参数预设 + 方案生成界面加男女主名字输入框
- Category: Build Methods / UI
- Instructions:
  - 参数预设：Settings.vue 温度/上下文/最大输出 Token 下方加一行预设按钮（精确/平衡/创意/长文本/快速），点击即设三个值，仍可手动微调。
  - 方案生成加男主/女主名字：SetupPanel.vue planForm 加 protagonistName/heroineName；模板加两列输入框（男主角名字/女主角名字，可选）；后端 routes.js /plan 路由注入 userPrompt；novels 表加 protagonist_name/heroine_name 列（ensureColumn）；applyPlan 落库时保留；autoSaveDraft patch 含这两个字段。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈「timeout of 60000ms exceeded」axios 超时
- Category: Troubleshooting & Debugging / UI
- Instructions:
  - 前端 axios 默认超时 60s 对 LLM 测试/导入等慢操作不够用。
  - 修复：web/src/api/index.js 默认 timeout 从 60000 改为 120000；testLLM、styleLearn、styleLearnFromChapters、importTxt、importTxtPreview、testLLMRoute、localChatTest 等 7 个接口加 per-request timeout: 180000。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈主角名字输入消失 + 生成前需参考方向 + 剧情逻辑弱
- Category: Troubleshooting & Debugging / UI / Build Methods
- Instructions:
  - 名字消失修复：SetupPanel.vue 加 nameDirty 标记，watch 只覆盖未手动输入的字段；用户输入后 watch 不再覆盖。
  - 生成前参考方向：SetupPanel.vue 加「参考方向」按钮 + refSearchOpen 对话框；调用后端 /novels/:id/reference-search（搜索同类小说+格式化）；api/index.js 加 referenceSearch；对话框底部「已了解，开始生成方案」按钮触发 startPlan。
  - 剧情逻辑10项增强：CHAPTER_SYSTEM 新增【剧情逻辑10项增强】第10-19条（因果链追踪/动机外显/节奏匹配/场景锚点/对话回应/世界观规则/战力守恒/信息节奏/悬念平衡/配比控制）；PLOT_CONSISTENCY_CHECK 检测维度扩到24类；PLOT_FIX 修法表补齐11项修法。
  - 联网参考同类小说：章节生成时 useReference 参数开启后搜索同类小说注入 prompt；LeftPanel.vue 加 checkbox「参考同类热门小说」。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户要求多本融合改编功能（同时导入多本小说，AI 分析后询问怎么融合）
- Category: Build Methods / UI
- Instructions:
  - 多本融合：AdaptDialog.vue 加 mergeMode 切换（单本改编/多本融合）；mergeFiles 数组存放多本文件；mergeFileContents 存放文本内容；onMergeFileChange 支持多文件上传（最多10本）；analyzeMerge 调用后端 /novels/:id/adaptation/analyze-merge；后端用 chat({system+user}) 分析各本特点并返回 merge_suggestions（3个融合方向）；前端展示融合分析结果 books + merge_suggestions，用户选方向后填充 intentText 并生成改编方案。
  - 后端：routes.js 新增 POST /novels/:id/adaptation/analyze-merge（接受 novels 数组，每本截取前3000字分析，返回 JSON {books, merge_suggestions}）。
  - 前端 API：api/index.js 加 analyzeMergeNovels。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 继续增强——章节阶段定位 + 类型强约束
- Category: Build Methods
- Instructions:
  - routes.js 新增 chapterStageLabel(idx, total) 按章节占比区分6阶段（开篇引入/铺展上升/中期发酵/高潮前积累/高潮收束/终局收尾），每个阶段带节奏指导。
  - 章节生成 userPrompt 注入「全书共 X 章，当前处于 Y 阶段」+「小说类型：X，本章题材基调必须严格符合该类型」；方案章节规划批次也注入当前阶段。
  - PLOT_CONSISTENCY_CHECK_SYSTEM 新增第25项类型偏题检测，issues.type 加 genre；PLOT_FIX_SYSTEM 修法表新增类型偏题修法。
  - 参考方向注入方案：SetupPanel「参考方向」对话框加 checkbox useReferenceInPlan，勾选后把参考小说列表注入 /plan 的 referenceNotes 参数，方案 prompt 借鉴同类题材套路。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈导入功能连续导入不生效，一次只能导入一个
- Category: Troubleshooting & Debugging / UI
- Instructions:
  - root cause：el-upload 配 :limit="1" + on-exceed 吞错，on-change 处理完后不清空 upload 内部 fileList，第二次选文件被 limit 阻断，必须切界面重挂组件才能再选。
  - 修复（4处+1处改编）：KnowledgeBase.vue / StyleLibrary.vue 的 onFileChange、Home.vue 与 SetupPanel.vue 的 onImportPick 处理完文件后调用 uploadRef.value?.clearFiles()；全部移除 :limit="1" 和 :on-exceed；Home/SetupPanel 加 importUploadRef，openImport/onImportPick/onImportRemove 均 clearFiles；AdaptDialog 多本融合 onMergeFileChange 也 clearFiles（mergeUploadRef 保持空，允许持续追加）。
  - 注意：el-upload 的 clearFiles 是清内部 UI fileList，不影响自己管理的数据数组（importFile/mergeFiles）。这是连续导入的根治方案。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈导入无成功反馈 + 改编多本融合导不了>5M 文件
- Category: Build Methods / UI
- Instructions:
  - 大文件限制：Home.vue / SetupPanel.vue 的 5MB 限制改为 200MB（doImport 检查 + el-upload tip 文案）；AdaptDialog 多本融合 onMergeFileChange 加 200MB 检查；后端 server/index.js express.json limit 从 50mb 提到 200mb（大 TXT 转 JSON 会膨胀，50mb 挡住 30MB+ 原文）。
  - 导入成功反馈：Home.vue confirmImport 成功 ElMessage.success(`「文件名」导入成功，共 N 章`)；doImport 解析完成提示；AdaptDialog onMergeFileChange 读取完成 ElMessage.success(`「文件名」已加入待融合列表`)。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户反馈生成 bug 清单（章节名缺失/生成中断/文笔生硬/知识库无效/破折号过度/下一章重复）
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - "下一章"重复第一章修复：routes.js generate 路由 mode='next' 时，若 firstEmpty 章节号 ≤ 已写章节最大号则改用 max+1（避免永远指向未写成功的旧占位章）。
  - 生成中断修复：续写 for 循环增加 prematureStop 判断（finishReason='stop' 但字数 < 60% 目标时不 break，继续补写），进度到目标或自然收尾才停。
  - 破折号过度修复：cleanAiText 新增规则8（"——"+陈述句起始词 → "，"，连续破折号压缩），测试通过。
  - 知识库不生效修复：SetupPanel 原本只 Home 新建可选知识库、编辑时无法改；补 availableKnowledge/knowledgeIds state + 列表加载 + autoSaveDraft 保存 knowledge_corpus_ids + 模板 checkbox + goKnowledge。
  - 章节标题清洗：title 生成后剥离引号/第X章/换行并截断15字。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用真实中转站 API（littleapi.gay，deepseek-v4-flash）端到端验证生成修复
- Category: Testing / Troubleshooting & Debugging
- Instructions:
  - 用户提供中转站 https://littleapi.gay/v1（API-key 已用于测试配置，勿外泄），模型 deepseek-v4-flash 可用。
  - 关键修复验证通过：①"下一章"连续生成 → 第1→2→3章正确推进（不重复）；②生成完成信号提前——SSE 在质量门通过后立即返回 done，不再等 15 个记忆后处理（修复前会卡 5 分钟，用户看到"中途停止"）；③章节标题全部生成，无空标题。
  - 实现方式（routes.js generate 路由）：质量门后插入 ★ 提前 done 块（send progress 100 + updateJob done + end done），原 2303 处重复 done 删除，catch 中若 job 已 done 则不再标 failed；后处理仍串行执行（send 有 writableEnded 保护静默跳过）。
  - 测试发现后台终端 stdout 不捕获问题：node -e 的 fetch SSE 脚本输出文件恒 0 字节，改用同步 node -e 直接打印事件流才看到结果。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 用户要求增强知识库对生成质量的影响——不只是分析文字，还要让剧情参考导入的小说
- Category: Build Methods
- Instructions:
  - 增强知识库注入（routes.js 章节生成+方案生成两处）：
    1. getSampleSnippets 每本从 3000→5000 字，总上限 8000→12000
    2. 新增 plotReferenceBlock：从各知识库取开头片段作为剧情参考，注入【已导入同类小说的剧情结构参考】
    3. KNOWLEDGE_SAMPLE_INTRO 强化为"参考文笔与剧情样本"，提及"剧情推进节奏、悬念设置方式、冲突制造手法"
    4. 方案生成骨架也注入知识库分析+原文片段（planSamples + planKnowledgeBlock）
  - 用真实模型测试验证：导入恐怖小说片段→生成章节→内容明显参考了知识库的风格（环境细节、声音描写、悬念推进），质量好。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: Bug — 风格库/知识学习库页面白屏（连按钮都没有、导入数据看不到）
- Category: Troubleshooting & Debugging
- Instructions:
  - root cause：编辑 KnowledgeBase.vue / StyleLibrary.vue（加 uploadRef/clearFiles 连续导入修复）时意外删除了 `load()` 函数定义，但 `onMounted(load)` 引用保留 → 浏览器报 `ReferenceError: load is not defined` → Vue 组件中断渲染 → 整个页面只剩侧边栏白屏，数据其实还在。
  - 修复：重建两个文件的 `load()`（调用 api.listKnowledge / api.listStyles，finally 置 loading=false）。用 xvfb + Electron（go2.cjs：loadURL http://127.0.0.1:3001/styles|knowledge + executeJavaScript 读 innerText + 数 button）实测两页面正常：styles 显示2卡片、knowledge 显示空态提示。
  - 排查经验：Electron 白屏定位用 `xvfb-run -a node_modules/electron/dist/electron --no-sandbox` + webContents.on('console-message') 抓 `ReferenceError`；dist 需先同步到 release/linux-unpacked/resources/web/dist。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Bug — 生成章节出现"请把末尾节选发给我"垃圾内容 + 现代题材混入古代市井跑题（老六/铜钱/烟锅）
- Category: Troubleshooting & Debugging
- Instructions:
  - 续写占位话术 bug：buildContinuePrompt 措辞"请把【末尾节选】的实际文字发给我"让模型误以为用户要等粘贴，错误输出占位话术当正文。修复：改为明确的"你就是作者，直接继续写"，强调不得输出说明/占位/标题/总结。并在落库前检测 resumeResidue/纯占位话术（<300字含"末尾节选/粘贴/发给我"或开头"请/麻烦把"）→ 判定失败不落库。
  - 题材跑题 bug：deepseek-v4-flash 在现代/都市题材中顽固冒出"老六/烟锅/门槛/铜钱/镖局/客栈/青石板/扁担/水缸/红绳/布衫"等古代市井意象。prompt 约束压不住。修复：lib.js 新增 scanTopicDrift(text, genre)——现代题材命中 TOPIC_DRIFT_WORDS 返回 hits；routes.js 在正则清污后、落库前调用，命中则 return error「本章与现代世界观不符（老六、烟锅），未保存，请点击重写」。真实模型实测生效：第二章跑题被拦截 not 落库，第一章保持干净。
  - 验证方法：xvfb+Electron 抓 console；真实模型通过 littleapi.gay 的 deepseek-v4-flash。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Bug — 生成当前章节时切换其它界面再返回章节丢失/空白，只能重新生成
- Category: Troubleshooting & Debugging / UI
- Instructions:
  - 后端链路验证无 bug（getChapter 返回完整 content；生成后 chapters.word_count/status 正确）。
  - 前端修复（editor.js）：
    1. selectChapter 加 try-catch，getChapter 拉取失败时用本地 chapters 兜底（避免切回后 activeChapter 空白）。
    2. syncJobState 的 running / done 两个分支都增加"刷新 getNovel → chapters"，并在当前章节无内容（word_count<=0）时自动 selectChapter 最近有内容章节。判定用 word_count 而非 content 字段缺失（getChapters 列表不带 content）。
  - 语义：切到其它界面再返回（Editor 重挂载 → switchTo → syncJobState）时，若 job 已 done，原来不会刷新章节 → 用户看到空白。现在自动刷新并选中最新有内容章节。

[Project Knowledge Summary]
- Date: 2026-08-15
- Context: Bug — 章节生成完成/跑题拦截后点击重新生成，报"该小说已有进行中的章节生成任务"
- Category: Troubleshooting & Debugging
- Instructions:
  - root cause：多处 return end(error) 分支（AI 未返回内容、续写占位话术、题材跑题拦截）没有调用 updateJob(job.id,{status:'failed'})，导致 job 残留 running。用户再次点生成时 tryCreateJob 检测到同 stage running 冲突 → 409。
  - 修复：① 三个 return error 分支前补 updateJob(job.id,{status:'failed', ...})；② generate 路由 tryCreateJob 冲突时先 abortJob(残留 running job) 再新建（用户意图明确要生成/重写）。
  - 验证：插入残留 running job → regenerate 请求 → 事件流首个是 job（新任务创建）、旧 job aborted、新 job done；无 409 冲突。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: 继续增强——多本融合 UI 完善（清除所有按钮、重复按钮修复）
- Category: Build Methods / UI
- Instructions:
  - AdaptDialog.vue 修复：单本改编的"生成改编方案"按钮外包 <template v-if="!mergeMode"> 防止多本融合模式下重复显示；加 merge-file-actions 样式和"清除所有"按钮重置 mergeFiles/mergeFileContents/mergeAnalysis。

[Project Knowledge Summary]
- Date: 2026-08-26
- Context: Bug — 用户反馈三个生成质量问题：重新生成输出思考过程、章节衔接不上、AI 味标点/分段（过量破折号/断句/一行一段）
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - 思考残留（推理型模型如 deepseek-v4-flash 把"复述任务要求"当正文开头输出，如"我们需要回答用户：重写《X》第一章正文，约2000字，直接正文"）：routes.js 新增 detectThinkingResidue（逐句扫描开头 600 字，THINK_RESIDUE_SENTENCE 正则数组）+ stripThinkingResidue（落库前剥离开头思考句段）+ isThinkingResidueSentence；cleanAiText 之后、落库前调用 strip；质检 problems 循环加 0c 检测，命中即整章重生成。剥离后为空则返回原文交质检判失败。
  - 章节衔接：prevTailLen 从 next=800/regenerate=2000 提升为 1200/2000；prevTailBlock 增加【衔接要求】（第一句必须紧接上一章结尾动作/对话/悬念）；质检新增 0a 开头跳转/脱节检测（时间过了很久/与此同时/镜头一转/另一边等开头话术→判重生成）。
  - AI 味标点/分段：lib.js scanAiPunctuation 新增破折号过密检测（≥8 处且密度 > 每 400 字 2 处）；cleanAiText 规则 8 破折号清洗的陈述起始词扩展（整间/整个/铺里/屋里/房里/店里/门外/窗外/身后/身前/脚下/头顶/眼前/街/巷/房间/屋子等）。
   - prompts.js CHAPTER_SYSTEM 写作流程新增 1b【严禁输出思考/任务复述】铁律（只输出故事正文，禁止复述/规划/解释任务）。

[Project Knowledge Summary]
- Date: 2026-09-05
- Context: 全面排查代码潜在问题并修复
- Category: Troubleshooting / Build Methods / Architecture
- Instructions:
  - 修复高危问题：
    1. longestCommonSubstring 完整 DP 矩阵改为滚动数组，避免大文本 OOM
    2. SSE keepalive 定时器异常时调用 stopKeepalive 防止循环异常
  - 修复中危问题：
    1. 新增 escapePromptInput 函数，转义用户输入中的【】──防止 prompt injection
    2. 前端 _abortHandlers Map 独立存储 abort 函数，避免 Pinia 序列化问题
    3. saveGenDraft/clearGenDraft 使用 originId 防止切书后草稿写入错误小说
    4. saveSamples/saveStyleSlices 使用事务包裹确保数据完整性
    5. tryCreateJob 时区问题：SQLite 本地时间字符串不加 Z 解析
    6. llm.js onDelta 回调异常时终止流并抛出，避免静默中断
    7. llm.js retryMax 限制为模型上下文窗口 80%，避免超限 400
    8. getKnowledgeByGenres LIKE 通配符转义防止非预期匹配
  - 修复低危问题：
    1. consumeStream idleTimeout 在 reader.read() 成功后重置
    2. buildNovelContext 所有用户输入经 escapePromptInput 处理
  - 测试：独立 node 脚本复刻上述正则逻辑验证（思考剥离 10 用例、破折号 4 用例、衔接 6 用例全过）；语法 node --check 通过。server node_modules 未装、无法起真实服务端到端，验证靠独立正则测试。

[User Instruction Summary]
- Date: 2026-08-26
- Context: 用户明确要求——以后说「打包」就默认打包成 Windows 安装包（NSIS .exe），像今天这次一样在本环境直接产出
- Instructions:
  - 用户说「打包」即指打包成 Windows 安装包（NSIS `.exe`，产物为 `desktop/release/AI小说工坊 Setup <版本号>.exe`），默认在本 Linux 环境直接交叉打包产出，无需再询问目标平台。
  - 本环境打包 Windows 安装包的完整流程（已实测通过）：
    1. 若 `server/node_modules`、`web/node_modules`、`desktop/node_modules` 缺失，分别执行 `npm install --no-audit --no-fund`（server/web/desktop）。
    2. 构建前端：`cd web && npm run build`（生成 `web/dist`）。
    3. 复制后端依赖：`cd desktop && node scripts/prepare-deps.cjs`（生成 `.build/server-deps`）。
    4. 打包：`cd desktop && export WINEPREFIX=/tmp/winefresh USE_SYSTEM_WINE=true WINEDEBUG=-all && npx electron-builder --win nsis`。
    5. 产物校验：`desktop/release/*.exe` 应为完整安装包（几十 MB 级，非 ~143KB 失败残留）；`win-unpacked/resources/web/dist/assets/` 含前端哈希产物、`resources/server/` 含完整后端代码与 node_modules。
  - 关键环境依赖：需要 wine32 + wine64（`dpkg --add-architecture i386 && apt-get install -y wine32:i386 wine64`），且必须用干净前缀 `WINEPREFIX=/tmp/winefresh`（`wineboot --init` 初始化，首次约 3-5 分钟）；必须设 `USE_SYSTEM_WINE=true`，禁用 electron-builder 自带的 toolsets.wine。桌面端镜像源在 `desktop/.npmrc`（electron 与 electron-builder-binaries 指向 npmmirror）。
   - 打包前若需递增版本：同步递增 `desktop/package.json` 与 `server/package.json` 的 version 字段（满十进一）。

[User Instruction Summary]
- Date: 2026-09-05
- Context: 用户反馈「生成创作方案有问题」——灵感明确写「主角是现代人意外死亡后身穿玄幻世界、没有家人」，但方案总是魂穿进某某身上 + 家族废物嫡子
- Instructions:
  - 根本原因：方案生成的提示词缺少「灵感忠实度」硬约束，LLM 默认套用网文常见模板（魂穿+家族废物）
  - 修复方案：
    1. prompts.js 新增 `buildConceptFidelityRule(concept)` 函数：解析灵感原文，生成「灵感优先铁律」文本块，包含身穿/魂穿区分、无家人/家族废物区分等硬约束
    2. prompts.js 新增 `detectConceptViolations(concept, plan)` 函数：检测方案是否违反灵感约束（身穿写成魂穿/没家人写成家族废物）
    3. 将 `CONCEPT_FIDELITY_CORE` 注入 NOVEL_PLAN_SYSTEM / PLAN_SKELETON_SYSTEM / PLAN_CHAPTERS_SYSTEM / PLAN_REVISE_SYSTEM 四个系统提示词
    4. routes.js 生成骨架时调用 `detectConceptViolations` 校验，若违反则自动重试一次，前端提示冲突内容
    5. userPrompt（骨架/章节/修订/细纲）统一注入 `buildConceptFidelityRule(conceptText)` 作为最高优先级约束
     6. GENRE_GUIDE_REBIRTH 新增第60b条：身穿与魂穿必须按灵感区分，严禁把身穿默认写成魂穿进世家废物

[Project Knowledge Summary]
- Date: 2026-09-16
- Context: Discovered by Agent while implementing incremental hot-update to eliminate 30-min full-installer downloads
- Category: Build Methods / Operations & Deployment
- Instructions:
  - 增量热更新机制：补丁格式为 JSON `{ version, files: [{ path, content, encoding }] }`，path 相对 resources 目录（server/ 或 web/dist），encoding 为 utf8（文本）或 base64（二进制），零依赖无需解压库。
  - 后端模块 `server/src/updater.js`：`applyPatch()`（路径沙箱限制在 server/ 和 web/dist，旧文件备份到 userData/backups/）、`getCurrentVersion()`（读 server/package.json）、`buildPatchFromFileList()`。
  - 路由（routes.js 末尾 export 前）：`POST /api/update/apply`（接收补丁 JSON，覆盖文件，记录 update_log 到 settings 表）、`GET /api/update/info`（返回当前版本+最近更新记录）、`POST /api/update/restart`（200ms 后 `process.exit(43)` 触发重启）。
  - Electron 重启（desktop/electron/main.cjs）：`serverProc.on('exit')` 检测 code===43 → `app.relaunch(); app.exit(0)`。main.cjs 在 asar 内（不可通过补丁更新），但首个含此功能的 NSIS 安装包已包含重启逻辑，后续补丁只需更新 server/ 和 web/dist。
  - 前端 UI（Settings.vue）：「软件增量更新」卡片——隐藏 file input 选 .patch.json → ElMessageBox 确认 → POST /api/update/apply → 显示结果 → 延迟调 POST /api/update/restart 触发重启。API 层（web/src/api/index.js）：`getUpdateInfo`/`applyUpdate`/`restartApp`。
  - 补丁生成器 `scripts/make-patch.cjs`：开发环境用，`node scripts/make-patch.cjs [--build] [--out <path>] [--from <ref>]`。用 `git diff --name-only` + `git status --porcelain` 收集 server/ 变动文件（含未跟踪），web/dist 因 gitignored 全量打包（walkDir 递归）。版本号读 desktop/package.json。
  - 工作流：改代码 → `cd web && npm run build` → `node scripts/make-patch.cjs` → 用户在「设置→软件增量更新」选 .patch.json → 自动应用+重启。补丁典型 1-3 MB vs 完整安装包 134 MB。

[User Instruction Summary]
- Date: 2026-09-16
- Context: 用户要求——每次修复/优化代码后，必须自动构建并生成增量补丁给用户下载，不能只改代码不产出补丁
- Instructions:
  - **修复/优化代码后必须执行**：跑 `node scripts/build-and-patch.cjs --bump` 一键生成增量补丁。此脚本自动：递增版本号 → 构建前端 → 检测改动 → 生成 .patch.json 到 `desktop/release/update-<版本号>.patch.json`。
  - `--bump` 每次必加（递增 patch 版本号，如 1.4.15→1.4.16），让用户更新历史能看到版本变化。
  - 若仅改后端（无前端改动），可加 `--no-build` 跳过前端构建加快速度。
  - 脚本会自动检测基准：有未提交改动时对比 HEAD，已全部 commit 时对比 HEAD~1。也可用 `--from <ref>` 手动指定。
  - 产出后告知用户补丁路径（`desktop/release/update-<版本号>.patch.json`），用户在已安装软件「设置→软件增量更新」选择该文件应用即可。
  - 补丁生成后再 commit + push 代码。顺序：改代码 → `build-and-patch.cjs --bump` → commit → push。
  - `scripts/build-and-patch.cjs` 与 `scripts/make-patch.cjs` 的区别：前者是面向 Agent 的一键流程（含版本递增+前端构建），后者是底层工具（仅生成补丁）。日常用前者。

[Project Knowledge Summary]
- Date: 2026-09-18
- Context: 用户反馈勾选都市/青春/校园/言情生成的创作方案仍是穿越/系统/召唤/中年内容
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - 题材一致性架构（v1.4.21-1.4.23）：三层注入点必须同步维护——①/ideas 路由 (routes.js ~1670, FANTASY/YOUTH_KEYWORDS 分轨差异化轴) ②PLAN_SKELETON_SYSTEM 边界铁律 (prompts.js ~352) ③buildPlanGenreConformity() (prompts.js, 共享函数) 注入方案生成 userPrompt+骨架系统提示词+修订端点。
  - 陷阱：PLAN_SKELETON_SYSTEM 曾把"重生/穿越"列为现实向合法元素（"穿越/重生的优势是信息差"），只禁力量体系却放行套模板开局——禁模板与禁力量体系必须分开表述。势力枚举（宗门|王朝|异族）和 ability 字段（特殊能力）都会诱导幻想向，已加现实向注记。
  - 用户勾选"穿越/重生"题材时 buildPlanGenreConformity 动态放行对应模板（仅信息差优势），禁系统/超凡力量不变。
  - e2e 测试方案生成：后台起 node server/index.js → POST /api/novels 建书 → POST /api/novels/:id/plan (SSE, 600s 内可能只完成骨架+章节占位, job 后台续跑) → 轮询 GET /api/novels/:id 看 world_view/outline + /characters /factions /chapters 检查超凡词命中。
  - LLM 配置写库（用户提供的自己的 key）：settings 表 key='llm_config'，字段必须 camelCase (apiKey/baseUrl/model)；模型名查 /models 端点确认（当前 deepseek-v4-flash 全小写）。

[Project Knowledge Summary]
- Date: 2026-09-18
- Context: 用户贴出第一章原文反馈AI味浓——品级漂移/条款改口/动作回环/节拍复读逃过全部25类检测
- Category: Build Methods / Quality Enhancement
- Instructions:
  - 章内一致性检测架构（v1.4.24）：lib.js 新增 scanRankDrift（品级漂移→problems重生成）/scanRuleDrift（系统条款降级→problems）/scanBeatEcho（意象体感词根归并计数，单组≥5或双组≥3→structureFixes润色）/scanActionLoop（掐腿/更衣/纸条掏塞×2→structureFixes）。挂入 routes.js 5a3 段，与时间线/称呼检测同级。
  - 关键陷阱：buildPolishWithIssues 此前对字符串型 issue 读 it.quote/it.problem 等对象字段渲染成空——structureFixes 全线是字符串，定向修复信号一直被静默稀释。已兼容 typeof it==='string' 直出。
  - CHAPTER_SYSTEM 铁律 22d/22e/22f（数字条款即铁律/单次动作/节拍不重复）+ 交稿自查9b（五项清单）；AI_DETECT_SYSTEM 新增 26-29 类。
  - 扫描器验证 SOP：用户原章节阳性（全命中）+ 场景化阴性（雨×2/凉×2/深吸一口气×1 必须放行，防误杀健康白描）。scanRuleDrift 的 s.length<200 门槛会拦截短测试样例，测试文本须 ≥200 字。

[Project Knowledge Summary]
- Date: 2026-09-18
- Context: 用户第五轮反馈"一个都不认识——不是不认识，是认不全"式自我改口腔漏检
- Category: Quality Enhancement
- Instructions:
  - 否定改口腔（v1.4.25，scanDenyReframe）：破折号改口"X——不是(不)X"、双重否定"不是不X，是Y"、"不是A而是B"密度、"与其说A不如说B"四类句式。触发阈值：改口+双重否定合计≥2 或 对照≥4 或 ≥2.5/千字 或 与其说≥2。只进 structureFixes 定向润色，保留 1 处有信息量改口空间，不触发重生成。
  - 提示词同步：CHAPTER_SYSTEM 铁律 22g（禁自我改口，全章≤1处）+ AI_DETECT_SYSTEM 第30类。当前检测类别共 30 类。
  - 测试陷阱（第二次踩）：scanDenyReframe 门槛 400 字，测试样例必须写足长度；bash -e 双引号内嵌反引号模板字符串会被命令替换吞掉，正则调试必须用 .mjs 测试文件。

[Project Knowledge Summary]
- Date: 2026-09-19
- Context: 第六轮——用户要求分阶段思考强度 + 继续去AI味 + 修逻辑问题
- Category: Build Methods / Quality Enhancement
- Instructions:
  - 分阶段思考强度（v1.4.26）：llm_config.thinkingTasks = {planning/writing/analysis/polishing: off|low|medium|high|xhigh}，chat() 内 resolveEffort() 按任务取档、回退全局 reasoning。润色类调用 task='polishing'（model_router 无此键，安全回退默认模型）。DeepSeek V4 思考极性 bug 已修（原 low/medium/high 注入 thinking:disabled，现 enabled+reasoning_effort）。UI 在 Settings.vue "思考功能"下拉下方四行。
  - 修辞类扫描器（scanRhetoricPileup/scanToldEmotion/scanOverBut）：全部进 structureFixes 定向润色。阈值：明喻>4/千字、升华≥3、排比≥3、程度副词>6/千字、情绪直给≥4、转折>5/千字。测试样本必须 ≥600 字符（低于门槛直接短路，已三次踩长度坑）。
  - 逻辑硬伤：铁律 22h（人物在场）/22i（物品信息来源）/22j（因果链）+ AI_DETECT 31-33 类。这类逻辑错误无法正则检测，全靠生成前铁律约束 + LLM 检测兜底。
  - 测试方法坑：bash -e 双引号内嵌反引号模板字符串会被命令替换吞掉（表现为样例变空串），Python heredoc 写中文测试文件易混入英文字符；正则/扫描器测试一律用 write 工具写 .mjs 文件或 node --input-type=module heredoc 内联。

[Project Knowledge Summary]
- Date: 2026-09-19
- Context: 第七轮体检+治理——用户要求检查前后端并继续去AI味
- Category: Quality Enhancement / Testing Methods
- Instructions:
  - 第七轮扫描器：scanOminousForeshadow（上帝视角剧透腔：他不知道的是/命运齿轮/一切才刚刚开始，≥2触发）、scanClicheGesture（俗套神态：眼神闪动/唇角/眉部/空气凝固/把玩/玩味笑，双类≥2或单类≥5触发）。铁律22k + AI_DETECT 34-35。当前共 11 个专项扫描器 + 35 检测类别。
  - 体检 SOP：`for f in server/src/*.js; do node --check` 全量语法 → background_terminal 起服务 → curl /api/settings|/api/novels|/api/novels/1/chapters/1|/api/styles 探活 → 后台终端跑 vite build 验前端可构建（约23s）。
  - 测试样本长度教训（已四次）：600 字门槛下测试阳性样本必须实测 txt.length ≥ 600；触发条件是"组合达标"（如 detail≥2 类），样本需覆盖至少两类各达下限。写完样本先 console.log(length) 再断言。

[Project Knowledge Summary]
- Date: 2026-09-19
- Context: 用户反馈设置页看不到新加的四行思考档位——排查发现 v1.4.26 补丁缺新 UI
- Category: Troubleshooting & Debugging / Build Methods
- Instructions:
  - 补丁打包铁律：凡改动 web/src 下任何前端源码，build-and-patch 必须跑完整构建（去掉 --no-build）；--no-build 只允许纯 server 端改动使用。v1.4.26 因此把旧 dist 打进补丁，用户设置页缺新档位。
  - 排查链路（已验证有效）：git log 查源码提交时间 → grep web/dist/assets/*.js 是否含新 UI 字符串 → python 检查补丁 json 里 Settings chunk content → 确认 index.html 引用的 chunk hash。
  - 补丁机制事实：applyPatch 按 path 覆盖文件、不校验 fromVersion、旧 chunk 不删除只换引用；全量补丁（不带 --no-build）单包自足可覆盖任意旧版本，碎片场景优先打全量。

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第八轮（v1.4.29, 15cb7a8）主角名保护+开局模板检测
- Category: Build Methods
- Instructions:
  - 第13/14扫描器 scanNameGuard/scanOpeningCliche 已挂 routes.js 5a4 段；角色表用 role_type 含"主角"筛主角，字段无 is_main
  - 名字变体检测会贪婪吞字（"陈辰安是"），已做等长前缀裁剪——改这段时保留裁剪逻辑
  - 开局模板特征要抓语序变体（"快燃尽的油灯"语序与"油灯烧尽"相反）；用户原章 test_chapter1.txt 开局也是模板（被冻醒+硬枕头+油灯），是现成阳性素材
  - 检测类别已至 37；铁律已至 22m；AI_DETECT_SYSTEM 在 prompts.js ~1255 区域

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第九轮（v1.4.30, b8d1e40）概要设定缺失检测
- Category: Build Methods
- Instructions:
  - 第15扫描器 scanPremiseDrift(plan, text) 挂 5a4 段，用 existing?.summary 做章级合同（routes.js:3487 的 existing 含 summary 字段）
  - 要素从属关系：穿越从属于系统（面板兑现即穿越成立，防每章复述穿越的误报）；系统缺席提示会检测正文纸条类物件并给定向话术（用户事故：概要写绑定系统、正文纸条替代）
  - 已有"AI套路豁免"（conceptExempt/sysExempt ~4528）管正向误报，scanPremiseDrift 管反向缺失，二者互补勿混
  - 检测类别已至 38；铁律已至 22n

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第九轮增补（v1.4.31, 39f7f95）唤醒句式开头独立判定
- Category: Build Methods
- Instructions:
  - 模型会"换皮规避"检测：概要/铁律里点名的具体例子（焦味熏醒）被换成同句式变体（公鸡打鸣吵醒）——规则必须锁句式结构（是被…醒的/唤醒动词在开头90字）而非锁唤醒源词汇；铁律 22m 已附公鸡打鸣反例
  - scanOpeningCliche 现在开头唤醒优先于组合特征判定（根因优先，else-if 结构）
  - 扫描器阈值口诀：换皮对抗 → 锁结构；组合误报 → 锁组合阈值

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第九轮增补二（v1.4.32）开局正形四步结构
- Category: Build Methods
- Instructions:
  - 用户贴的好开头样本（秋雨砸青石板+雨幕爬起+乌木笏板+葱油饼老妪）经全扫描器验证零误伤，是"健康开局"基准素材
  - 铁律 22m 改为"禁令+正形"双段：正形四步（环境动态细节/动作半途切入/物件不对劲带悬念/烟火气具体细节），正向结构与负向禁令缺一不可
  - prompts.js 中引用用户样本时要抽象成通用例子（乌木笏板→物件不对劲），避免模板化复制到其他小说

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第十轮（v1.4.33, 3f42255）灵感生成器题材修复+男频女频+生硬过渡
- Category: Build Methods
- Instructions:
  - 灵感生成器在 routes.js /ideas 路由（~1641）；题材贴合块的禁令必须动态生成（用户没选的元素才禁），写死"禁穿越系统"会跟"题材=穿越系统"自相矛盾导致模型漂移
  - GF_POOL 池子内容即模型输出倾向：池里放"前世记忆/重生"就会给青春文强推重生——池子要跟题材纯净性对齐
  - 第16扫描器 scanStiffTransition 挂 5a4；门槛 600 字；检测段首标签（时间/视角/转折），同类≥2 或总量≥4 触发
  - 阈值长度坑第 5 次确认：阴性样本也必须超门槛再验，门槛下 clean 不算真阴性
  - 男频/女频走 req.body.channel，前端 InspirationGenerator.vue radio 组；改了 web/src 必须完整 vite build（本轮 45.84s）
  - 检测类别已至 38；铁律已至 22n；9b 自查已至九项

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第十一轮（v1.4.34, 待填hash）定语堆叠+句长节奏+回溯剧透腔
- Category: Build Methods
- Instructions:
  - 第17/18扫描器 scanAdjectivePileup/scanRhythmMonotony 挂 5a4；门槛 600/1500 字
  - 句长窗口教训：先实测 AI 输出的句长分布再定窗口（实测均匀句 35-36 字，直觉定的 10-30 窗口全部漏检）
  - 长度坑第 6/7 次确认：python heredoc 改测试文件的 replace 目标串有 typo 会静默失败，改用 Edit 工具；样本 repeat 计数要算好字数
  - 检测类别已至 40；铁律 22a-22n；9b 自查十项

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第十一轮增补二（v1.4.36, 见git log）系统题材矛盾禁令全库排查
- Category: Build Methods
- Instructions:
  - 题材禁令铁律：禁单必须按用户勾选的题材动态生成——用户勾了X就严禁在禁单里出现"禁X"，否则模型收到矛盾指令会随机漂移到邻近题材（系统→血脉觉醒即此机制）
  - 同源三处已修：/ideas 的 genreConformityBlock、prompts.js buildPlanGenreConformity、buildGenreBoundaryRule + routes.js 方案骨架"题材边界强调"；关键词表有三套（FANTASY_KEYWORDS/PLAN_FANTASY_KEYWORDS/SUPERNATURAL_TAGS），"系统流"都在但裸"系统"只在 SYSTEM_KEYWORDS/SUPERNATURAL_TAGS——改动题材判定时三套表都要核对
  - 系统题材金手指纯净性：勾系统未勾玄幻时，金手指必须是纯系统载体（面板/任务/兑换/签到/模拟），血脉/灵根/传承/法宝/契约全禁

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: 第十二轮（v1.4.37）双女主题材+灵感四问+空泛描写检测
- Category: Build Methods
- Instructions:
  - 双女主/双男主：GENRES 标签 + /ideas 的 dualBlock（isDualHeroine/isDualHero）+ IDEAS_SYSTEM 的 protagonist2 字段（含 relation）+ 前端卡片第二主角块；双层主角结构走 protagonist/protagonist2 双字段
  - 灵感质量靠"优质创意四问"自检清单（金手指代价/钩子绑困境/反派自利/副线第二推动力）压在 IDEAS_SYSTEM 最高层，比加卖点多两句有效
  - 第19扫描器 scanVagueAbstraction 挂 5a4（空泛感受/难以言喻/物在诉说/气息交织密度检测）；门槛 600
  - 检测类别已至 41；测试文件拼接模板串时 add_p 常量必须定义在引用之前

[Project Knowledge Summary]
- Date: 2026-09-20
- Context: v1.4.38-39 双男主移除/双女主感情线定位
- Category: Build Methods
- Instructions:
  - 用户不要双男主题材（已从 GENRES/dualBlock/IDEAS_SYSTEM 全部移除）；双女主保留
  - 双女主感情线按用户明确要求：感情文（含百合向爱情线）与羁绊文（姐妹/知己/搭档/亦敌亦友）都允许，由创意风格决定
  - web/dist 在 gitignore 中，commit 时不要 add web/dist（会被拦截导致整个 commit 失败）；dist 由 build-and-patch 脚本打进补丁

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: 第十三轮（v1.4.40）超长篇一致性三防线
- Category: Build Methods
- Instructions:
  - 长篇一致性防线分层：正则扫描器（免费，挂结构扫描段）→ LLM 复核确认真伪 → problems 重生成 / structureFixes 定向润色；LLM 校验只在 problems 空时跑（避免重复调用叠加成本）
  - scanPersonaDrift 契约：锚点=角色档案 profile+personality，未确立的特质不判漂移（防误伤）；TRAIT_GUARD_RE 转变/扮演词豁免角色弧线；门槛 800 字；只查主角+建档角色前 6 人
  - 记忆校验 checkMemoryConsistency 是独立函数（非增强 checkPlotConsistency）：章内逻辑与跨章记忆分开审，severity high→重生成、medium→structureFixes；记忆库全空（前1-2章）直接放行
  - 开篇去模板化组合拳：ch1Note 开篇铁律对 idx===1 首次生成也生效 + 6 路随机开局路线注入（动作中途/对话中途/反常细节/声音先至/物件特写/体感先行）+ scanOpeningCliche 禁止唤醒模板
  - 角色档案超长篇保护：profileBlock 主角优先排序+3500 字截断；第 1 章即建档（idx===1 || idx%10===0）；formatFactsBlock 上限待下轮补

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: 第十四轮（v1.4.41）事实库预算截断
- Category: Build Methods
- Instructions:
  - formatFactsBlock(novelId, currentIdx, budget=4200)：角色组（character:）永远优先，其余按组内最新章号降序；超预算省略整组并注明"另有 N 组较早设定未逐条列出"；首组超预算时截断保留防空块
  - 测试隔离 DB 用 NOVEL_DATA_DIR 环境变量重定向到 /tmp/opencode/r14data（db.js:8 支持），测试建小说直接 db.prepare INSERT INTO novels（db.js 无 createNovel 辅助函数）
  - 截断类测试数据要按预算密度放大（4200 字预算需 ~120 条长事实才能触发截断），否则断言永不触发

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: 第十五轮（v1.4.42）灵感生成解析失败自愈
- Category: Troubleshooting & Debugging
- Instructions:
  - "模型返回内容无法解析"类报错排查链：先看 tryVariants 覆盖面（尾逗号/字符串内裸换行是最常见模型坏格式）→ 端到端 curl /api/ideas 复现 → 解析最终失败时查 data/idea_parse_failures.log（头800+尾400 字符留痕）
  - extractJson 自愈层清单（改前先核对别重复加）：think 标签剥离/围栏剥离/中文逗号/单引号键/内层引号/引号配对/注释剥离/截断自愈/尾逗号(v1.4.42)/裸控制符转义(v1.4.42)
  - 解析类任务兜底策略：正则自愈失败后用 LLM 自修复（模型修自己的坏输出）比正则补丁召回率高；ideas 路由已用此模式（1 次修复调用）
  - 测试解析器用 /tmp/opencode/test_round15.mjs 的形态样本（尾逗号/多行字符串/截断+换行/转义不破坏）

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: 第十六轮（v1.4.43）文笔扫描器盲区补齐
- Category: Build Methods
- Instructions:
  - 加新扫描器前先 grep '^export function scan' server/src/lib.js 盘点存量（本轮 49→53 个），避免重复造轮子
  - 章级特征（章尾钩子）扫章尾切片并按硬伤（problems）处理——章尾是下章门面；全文级套话（生理反应/伪精确）走 structureFixes 定向润色
  - 阈值定式沿用：单处可容忍（真人也有惯用语），同类 ≥3 处或跨类合计超限才报；测试要有"阴性样本也过门槛"用例（T7 多类各 1 次不报）
  - 扫描器挂载点：routes.js 5a 段（scanStiffTransition 附近），结构类进 structureFixes、硬伤进 problems

[Project Knowledge Summary]
- Date: 2026-09-21
- Context: 第十七轮（v1.4.44）灵感生成器增强
- Category: Build Methods
- Instructions:
  - 灵感生成器三层差异化机制：差异化轴（金手指+身份槽位随机分配）→ 跨批去重（historyIdeas 签名排除）→ 反套路禁令（ANTI_TROPE_POOL 每批随机 3 条，锁"套路结构"而非具体词汇）
  - 用户种子想法（seed）定位是"种子而非枷锁"：围绕它做 N 个角度展开，仍须满足彼此差异化铁律
  - 前端构建铁律执行记录：web/src 改动 → cd web && npm run build（vite，约 18s）→ build-and-patch --bump（不带 --no-build）
  - /api/ideas 为 SSE 流式端点，端到端测试用 curl -N -X POST 抓 "type":"done" 判成功

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第十八轮（v1.4.45）方案层同质化防线
- Category: Build Methods
- Instructions:
  - 反套路机制分层复用：ANTI_TROPE_POOL/buildAntiTropeBlock 抽在 prompts.js 作为单一来源，/ideas 与 /novels/:id/plan 共用（防"创意反套路、方案又套路回去"）
  - 灵感种子保真校验（detectSeedLoss）：提取灵感中引号强调短语 + "能/会/可以+动词短语"能力描述，方案中全部丢失即触发重写；命中判定用 4 字滑窗容错（模型会部分复述原短语）；灵感 <20 字跳过（不误报）；挂在 detectConceptViolations 尾部，自动获得骨架重试链路
  - 违规重试提示词必须按实际 violations 动态生成，禁止硬编码特定约束（原"必须身穿且无家人"对无此约束的灵感是错误指令）
  - AI_DETECT_SYSTEM 现为 45 类，与 lib.js 53 个扫描器对应；加扫描器后须同步补检测类别，两边不同步会导致 LLM 审查漏检
  - 测试集：/tmp/opencode/test_round17.mjs（题材分类 25 用例 + seed loss 5 用例 + 反套路块 4 用例）；round7-16 全部可回归且当前全绿

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第十九轮（v1.4.46）灵感载体跑偏修复（用户实锤：勾历史架空穿越系统，产出通感溯源/先祖残魂）
- Category: Troubleshooting & Debugging
- Instructions:
  - 题材跑偏的隐蔽形态：模型"保留功能、偷换载体"——信息溯源系统→摸物通感、任务系统→先祖残魂发任务；genre 字段照抄合规标签，标签门禁（genreAllowed）查不出内容偷换
  - 禁令分层口诀升级：锁具体词汇（血脉/灵根/法宝）→ 模型造新词绕过；锁载体结构（系统必须有面板/提示音/任务列表等界面化形态）才有效
  - 三种偷换形态实锤：①感官异能化（系统→身体感官）②残魂寄宿化（系统→亡魂/先祖充当）③器物灵性化（系统代价→草木枯荣/器物损耗灵性）；MYSTICAL_CARRIER_RE 按这五类载体特征词扫描
  - 灵感页 FANTASY_KEYWORDS 与方案层 PLAN_FANTASY_KEYWORDS 语义不同勿合并：灵感页=超凡金手指池开关（穿越/重生/系统故意排除走专门分支），方案层=现实向约束放行名单；合并会让"历史+穿越"塞血脉觉醒池
  - 门禁剔除后全空必须短路 return error：掉进"解析失败→LLM修复"路径会把刚剔除的违规创意原样解析回来
  - 校验器测试定式：实锤事故案例必须命中 + 合法系统创意（面板/签到/模拟器）不误报 + fantasyOk 跳过 + 逗号短句边界（"摸到断簪，看见"间隔集须允许逗号）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十轮（v1.4.47）灵感解析失败加固（用户实锤：生成等很久后报"内容无法解析"）
- Category: Troubleshooting & Debugging
- Instructions:
  - "模型返回内容无法解析"排查链升级：先查 data/idea_parse_failures.log 失败形态 → extractJson 盲区核对（前缀+截断组合曾漏救）→ 解析类失败现在有三层兜底：正则自愈/截断修复 → 自动重试一次主生成 → LLM 修复器（输入 16000 字符，提示词含"截断只保留完整元素"）
  - extractJson 截断修复必须先剥前缀：模型输出"以下是创意：\n[…"被截断时，含前缀修复后仍无法 parse——先 search(/[\[{]/) 定位 JSON 起点
  - 切片顺序定式：对象/数组切片按 JSON 起点类型选优先级（[ 在 { 前则数组优先）——固定顺序会让"前后缀+数组"切出单元素对象、让"前缀+骨架对象"切出内层 characters 数组
  - 截断自愈会救回"只有 title"的半成品对象：调用方须过滤关键字段双缺的残缺项（ideas 场景=hook/logline 双缺剔除）
  - maxOut 缩放定式：数组型大输出按元素数缩放（ideas=ideaCount*2200 封顶 16384），用户显式 maxTokens 原样透传；8192 下限对 6 创意不够用
  - 测试素材：/tmp/opencode/test_round19.mjs（前缀截断/围栏截断/深层截断/think 截断/切片顺序/maxOut 公式 17 用例）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十一轮（v1.4.48）方案题材矩阵精细化（用户实锤：勾历史穿越架空，产出神秘老商人超自然金手指+高学历不懂学问剧情）
- Category: Build Methods
- Instructions:
  - 题材标签分两类：真超凡（玄幻/仙侠/灵异——世界观本身超凡）vs 机制型（穿越/重生/系统——剧情机制，世界观仍现实向）；"幻想向放行"开关只认真超凡（hasTrueFantasyTag），机制型组合必须进精细约束矩阵
  - isFantasyGenre（含穿越/重生/系统）与 hasTrueFantasyTag 语义不同并存：前者保持原调用方语义，后者用于约束放行判断；"历史+穿越"整体放行会让超自然金手指漏出
  - 穿越+无系统+无玄幻的载体锁定话术：优势必须落在现代知识/技能/记忆/信息差且知识边界写实（懂什么不懂什么为什么懂）；神秘人物/残魂/器物有灵/神秘力量交换点名禁止（实锤案例写进 prompt 效果最好）
  - 设定与行为硬矛盾（高学历却不懂学问）无法正则检测：用 LLM 复核（PLAN_COHERENCE_CHECK_SYSTEM），判定纪律要写清豁免条款（穿越者对环境陌生不算矛盾、偏科生疏不算矛盾），宁放行不误伤；复核失败静默放行不阻塞主流程
  - LLM 复核接入重试链路的模式：violations（正则）+ coherenceIssues（LLM）合并成一个 allIssues 列表，重试提示词按实际问题动态生成；重试后再复核，问题数减少才采纳
  - 测试素材：/tmp/opencode/test_round20.mjs（hasTrueFantasyTag 7 用例 + 约束矩阵 9 用例 + prompt 在位 3 用例）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十二/二十三轮（v1.4.49）穿越灵感身份自由化（用户两轮实锤：底层打工+魂穿原主+遗留关系绑架）
- Category: Build Methods
- Instructions:
  - 用户明确指令（生成内容硬底线）：穿越=身穿（禁魂穿/附身/夺舍/穿成原主）；开局孤家寡人无家人朋友；身份不要固定——可白手起家随剧情发展获得地位；严禁开局给人打工；严禁现代职业直译成古代同类营生（运动员→纤夫式一一对应）
  - 槽位措辞陷阱：身份槽位写"穿越成X"会引导模型写成魂穿（实锤：槽位"穿越成纤夫"→"身体是原主的"）；预设具体身份槽位会把创意框死（底层身份槽位→清一色打工故事）——穿越分支身份已完全放开，硬底线用约束块管，差异化靠金手指轴+反套路+批内去重
  - 反套路禁令矫枉过正教训：'目标必须是具体的有限的执念（找到一个人/赎回一件东西）'被模型字面执行成"还半贯钱/送木匣/赎银簪"流水账——禁令必须加下限（执念挂大阴影或硬期限），否则模型会滑向另一个极端
  - "轻松日常"风格的看点定义要显式给出：错位与机智的喜剧张力；不给定义模型会理解成无冲突日常琐事
  - 灵感页现役约束块：genreConformityBlock（题材贴合）+ transmigrationBlock（穿越形态）+ antiTropeBlock（反套路）+ 载体门禁（!isFantasy 时扫 MYSTICAL_CARRIER_RE）
  - 测试素材：/tmp/opencode/test_round22.mjs（身份自由化 21 用例）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十四轮（v1.4.50）灵异载体词表扩充（用户实测：历史架空系统穿越仍生成阴差/风水/命格类创意）
- Category: Troubleshooting & Debugging
- Instructions:
  - 载体门禁黑名单词表永远列不全（模型会造新词），必须黑名单+白名单双轨：MYSTICAL_CARRIER_RE 扩到 60+ 词（含灵异/民俗形态：阴差/城隍/地府/出马仙/狐仙/邪祟/风水局/命格/业力等）+ prompt 层"世界观本底白名单"（世界是纯现实的，唯一超凡元素=系统本身）
  - "命格/八字"这类词在系统文里作为系统参数出现也算玄学越界（命格系统=把玄学引入世界观），词表已收；比喻性用法（"地府般的矿道"）会误报，属可接受代价（剔除+提示可重新生成）
  - 纯现实向题材（系统/穿越/都市等）统一走载体门禁（!isFantasy 条件）；勾了玄幻/灵异/修仙类则 fantasyOk 跳过
  - 测试素材：/tmp/opencode/test_round23.mjs（灵异词命中 8 + 合法系统不误报 4 + 边界 2 + 白名单断言 4 + 跳过回归 1）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十五轮（v1.4.51）梦境/预知载体词表扩充 + 系统+穿越组合注入穿越形态约束（用户实锤：勾穿越系统历史架空生成"三更判官"——梦中审案看命运走向的金手指 + 主角"清河县刑房书吏"根本没穿越）
- Category: Troubleshooting & Debugging
- Instructions:
  - 梦境/预知类是超凡载体的独立形态，词表已补：托梦/梦审/梦中(过堂|审|推演|摊开)/三更梦/预知(梦|未来|祸)/命运(走向|推演|改写)/推演(命运|死劫|祸福)；"丢记忆"作为代价不拦（可以是合法系统代价），拦梦境载体锚点
  - 重大缺口教训：transmigrationBlock 原条件是 isTransmigration（=!isSystem && !isFantasy && 穿越），勾"穿越+系统"走 isSystem 分支时穿越形态约束整块不注入 → 生成"本地人小吏被推上位"的没穿越故事；已扩展为 (isTransmigration || (isSystem && hasTrans))
  - 系统+穿越时身份槽位必须换"穿越者来历"措辞池（现代上班族/工程师/历史教师穿越者等），古代身份措辞槽位（基层小吏/市井游民）会被模型结合成"穿越成基层小吏"的魂穿语法
  - 玄幻+穿越保持豁免：transmigrationBlock 不注入（魂穿/夺舍在玄幻世界观是常见合法设定，由灵感自行声明）
  - 回归测试集按轮拆分：/tmp/opencode/test_round7.mjs ~ test_round24.mjs 逐个跑；round21/22 断言随代码演进更新过（条件表达式、池子结构）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十六轮（v1.4.52）系统题材白名单兜底+预演残影词+命名开局要求（用户实锤三条：一页万金手记具现/先知先饿脑内推演/签到见尸死者残影视角，且名字难听+开局无聊）
- Category: Troubleshooting & Debugging
- Instructions:
  - 黑名单追词永远追不全（模型造新词绕过），系统题材必须黑名单+白名单双轨：SYSTEM_FORM_TOKENS（面板/界面/任务/积分/签到/商城/兑换/弹窗/等级/属性/模拟器等）——isSystem 时金手指字段无任一形态词=载体偷换（"能力系统化"新形态④：超凡能力冠名"系统"）
  - detectIdeaCarrierDrift 加第三参 isSystem，isSystem=true 时跑白名单兜底；非系统题材（isSystem=false）不跑白名单（现代知识类金手指合法）
  - 词表收紧教训：'预演...走向'误报合法模拟器系统（"以面板预演政策走向"=系统功能），改为只匹配'预演(未来|祸|灾|死)'；"脑内推演"单独加词拦脑内形态
  - 系统奖励的超凡能力也算跑偏："签到得死者残影视角"=通灵，加'残影视角/亡者视角'词
  - 命名与开局是软质量问题：IDEAS_SYSTEM 加主角命名要求（禁土味谐音梗，实锤点名赵大勺/陆大有）+ 强事件开局要求（被迫立刻行动，禁迷茫/找吃食/安顿开场）
  - 测试素材：/tmp/opencode/test_round25.mjs（三实锤命中 3 + 合法系统不误报 4 + 非系统不跑白名单 1 + 词表/函数/调用断言 7 + 命名开局断言 4 + 回归 3）

[Project Knowledge Summary]
- Date: 2026-09-22
- Context: 第二十七轮（v1.4.53）风格库/知识库/灵感生成器三模块增强（用户要求"继续增强优化"三大核心模块）
- Category: Build Methods|Troubleshooting & Debugging
- Instructions:
  - 知识库拼写 bug 教训：offline_learn.js 的 `repliclicable_techniques`（多了 li）与 prompts.js 的 `replicable_techniques` 不一致——离线学习后"技法"维度在 formatKnowledgeBlock 注入时直接丢失（parsed.replicable_techniques 为 undefined）；同类 bug 要检查所有分析字段名在离线引擎/LLM提示词/注入函数三处是否一致
  - 分块分析与最终综合维度必须对齐：PER_CHUNK_ANALYSIS_SYSTEM 原有 6 维但 FINAL_SYNTHESIS_SYSTEM 要求 8 维，综合时 LLM 在"编"缺失维度而非"综合"已有信息——分块分析维度必须覆盖最终综合的全部字段
  - DNA 维度扩充定式：离线引擎 analyzeStyleStats 已算 19 维但 DNA_DIMS 只取了 10 维——感官词频/时间过渡词/认知词/省略号/句长方差这些直接影响文风感知的维度被浪费；DNA_DIMS 扩到 16 维后 compareDNA 偏差检测更精准
  - formatDNABlock 增强原则：从平铺数值改为分组指导（语感/对话/感官/节奏/标点），每维附带判断标准（如"感官词低于5/千字时文风偏抽象"），让模型不只看到数字还能理解含义
  - 灵感生成器联动定式：/ideas 路由已接受 styleIds 参数注入 analysis 文本——增强为同时注入 formatDNABlock(mergeDNA(dnas))；知识库用 getKnowledgeByGenres(genreList, 3) 按题材自动匹配（无需用户手动关联），只注入 plot_patterns/scene_patterns/character_craft/replicable_techniques 四维（非全量，避免 prompt 膨胀）
  - 测试素材：/tmp/opencode/test_round26.mjs（拼写修复 5 + 维度对齐 6 + DNA 扩充 6 + formatDNABlock 6 + 润色指令 5 + 灵感联动 8 + 回归 4 = 40 断言）
