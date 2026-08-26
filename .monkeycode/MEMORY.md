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
