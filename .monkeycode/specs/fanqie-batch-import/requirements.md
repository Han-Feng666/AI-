# Requirements Document

## Introduction

用户将番茄小说书架中的多部小说批量导入「AI 小说工坊」的风格库与知识学习库。系统支持一次粘贴多条番茄书籍链接（或书籍 ID），在后台队列中逐本抓取全书正文、去防爬混淆，并在每本抓取完成后自动进入既有的风格分析 / 知识学习管线，全程显示队列进度且可取消。

## Glossary

- **番茄书籍链接**: 形如 `https://fanqienovel.com/page/{bookId}` 的页面地址，或形如 `https://fanqienovel.com/reader/{itemId}` 的章节地址，以及不带协议域的变体
- **书籍 ID**: 番茄书籍在站内的数字标识 `bookId`
- **导入任务**: 一本书从抓取到分析完成的完整后台处理单元
- **导入队列**: 按顺序执行的导入任务集合，同一时刻只处理一个任务
- **目标库**: 导入去向，取值 `style`（风格库）或 `knowledge`（知识学习库）
- **风格分析**: 既有的 `POST /styles` 分析流程（含风格 DNA 画像与样本切片）
- **知识学习**: 既有的 `POST /knowledge/import` 学习流程（含全书切片与场景打标）
- **正文混淆**: 番茄对章节正文中高频字实施的私用区字符替换，需按映射表还原

## Requirements

### Requirement 1: 批量输入书籍来源

**User Story:** AS 使用番茄书架的用户, I want 一次粘贴多条书籍链接或书籍 ID 并解析出书籍信息, so that 不需要逐本手工下载导入

#### Acceptance Criteria

1. WHEN 用户在导入弹窗中粘贴一个或多个番茄书籍链接（每行一条，或含空格 / 逗号分隔），系统 SHALL 解析出每个 `bookId`，并 IF 解析失败 SHALL 报告该条目的解析错误
2. WHEN 用户输入的数字串无法匹配 `fanqienovel.com/page/{bookId}` 或 `fanqienovel.com/reader/{itemId}` 模式，系统 SHALL 将纯数字输入视为 `bookId`
3. WHEN 用户点击「解析预览」，系统 SHALL 从每个 `bookId` 的书页拉取书名、作者、简介、总字数与章节总数，并 WITH 网络失败 SHALL 在对应条目上标记失败原因
4. WHEN 解析预览完成后，用户 SHALL 能移除任一失败或不需要的条目

### Requirement 2: 统一选择导入目标

**User Story:** AS 用户, I want 为整个批次统一选择目标库, so that 减少重复操作

#### Acceptance Criteria

1. WHEN 用户在导入弹窗选择目标库（风格库或知识学习库），系统 SHALL 将该选择应用到批次内所有任务
2. WHEN 目标库为风格库，系统 SHALL 在任务完成后生成风格分析结果并写入风格库
3. WHEN 目标库为知识学习库，用户 SHALL 能选择题材（若未选择 SHALL 使用默认值「其他」）
4. WHILE 批次处理中，用户 SHALL 能看到每个任务的目标库标识

### Requirement 3: 后台队列逐本处理

**User Story:** AS 用户, I want 多本书在后台队列中逐本处理, so that 不需要等待或手工干预

#### Acceptance Criteria

1. WHEN 用户启动批次导入，系统 SHALL 创建导入队列并逐本执行任务，同一时刻最多处理一个任务
2. WHILE 任务执行中，系统 SHALL 持久化任务状态（待处理 / 抓取中 / 分析中 / 已完成 / 失败 / 已取消）与抓取进度，IF 服务重启 SHALL 恢复未完成任务
3. WHEN 单个任务因网络错误失败，系统 SHALL 自动重试最多 3 次并采用退避策略，IF 仍失败 SHALL 将任务标记为失败并继续处理队列中的下一本
4. WHEN 用户请求取消，系统 SHALL 停止当前任务与剩余队列，SHALL 将已抓取内容丢弃或保存为可复用草稿（以保留章节为上限）

### Requirement 4: 抓取与反混淆

**User Story:** AS 用户, I want 抓取到的正文是干净可读的中文, so that 风格分析结果准确

#### Acceptance Criteria

1. WHEN 系统抓取某书目录，系统 SHALL 仅抓取网页端可读章节（`isChapterLock = false`，实测各书网页端统一开放前 10 章试读），WHILE 遇到锁定章节 SHALL 跳过并记录数量。番茄全平台免费（`needPay` 恒为 0），锁定是网页端试读限制，锁定章节的阅读页仅返回几十字残片，不得进入语料
2. WHEN 系统抓取某章节正文，系统 SHALL 从阅读页提取章节内容，IF 内容含私用区混淆字符 SHALL 依据内置映射表还原
3. WHEN 内置映射表无法还原某字符（映射失效），系统 SHALL 保留原字符并在任务结果中统计无法还原数量
4. WHEN 映射表整体失效（无法还原比例超过阈值），系统 SHALL 标记任务失败并提示更新映射表，SHALL NOT 将乱码文本写入目标库

### Requirement 5: 自动进入既有分析管线

**User Story:** AS 用户, I want 抓取完成后自动完成风格分析或知识学习, so that 直接可选用

#### Acceptance Criteria

1. WHEN 一本书抓取完成且目标库为风格库，系统 SHALL 复用既有的风格分析流程（含风格 DNA 画像与样本切片打标）并保存分析结果
2. WHEN 一本书抓取完成且目标库为知识学习库，系统 SHALL 复用既有的知识学习流程（含全书切片与场景打标）并保存学习结果
3. WHEN 分析管线内部失败，系统 SHALL 将任务标记为失败并记录错误，SHALL 保留已抓取的正文供重试
4. WHEN 分析管线需要 LLM 而当前无可用模型，系统 SHALL 将任务标记为失败并明确提示配置模型

### Requirement 6: 进度展示与取消

**User Story:** AS 用户, I want 实时看到批量导入的进度并能随时停止, so that 掌握处理状态

#### Acceptance Criteria

1. WHILE 队列处理中，系统 SHALL 以轮询方式展示每个任务的当前状态、已抓章节数 / 总章节数、当前阶段消息与耗时
2. WHEN 批次全部完成，系统 SHALL 展示汇总（成功数、失败数与失败原因），IF 存在失败任务 SHALL 提供「重试失败任务」入口
3. WHEN 用户在导入弹窗之外（如风格库 / 知识库列表页）查看，系统 SHALL 在页面顶部展示进行中的批次条与快捷取消入口

## Requirement 7: 内容合规

**User Story:** AS 平台, I want 下载内容仅用于个人学习用途, so that 遵守版权约定

#### Acceptance Criteria

1. WHEN 用户首次使用批量导入，系统 SHALL 展示使用提示：仅用于个人风格学习、不对外分发、尊重原作者版权
2. WHEN 批量导入连续失败超过次数上限（如连续 50 次），系统 SHALL 暂停队列并提示检查网络，防止对目标站点造成压力
