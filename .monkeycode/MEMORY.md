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
  - Windows 打包：本环境 Linux 无法跑 electron-builder——打包必须由用户在 Windows 本机执行（F:\小说\workspace\desktop）。步骤：(1) 同步代码到本机 (pull repo 然后把 web/dist 拷到 electron resources/app 或直接 `pnpm install && pnpm build && pnpm run dist:win`)；(2) `cd desktop && yarn install`；(3) `cd ../web && npm install && npm run build`；(4) `cd ../desktop && yarn electron:build`。(3) 必须先做完，否则 desktop packager 拿不到 dist。e2e mock-ac 在 /tmp/opencode/mock-ac.js 永久可用。


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
