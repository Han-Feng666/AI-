# 需求文档：风格库与知识学习库引擎升级（style-knowledge-engine-v2）

Updated: 2026-08-29

## Introduction

现有风格库与知识学习库采用「大块文本 → LLM 总结报告 → 静态注入 prompt」的模式。一部数十万字的参考小说被压缩成几百字的描述性报告，创作时注入的样本片段固定取自小说开头，与当前创作场景无关联，导致导入的作品"学了但没学到"，生成质量提升有限。

本需求将两个库从「报告式学习」升级为「结构化样本库 + 按场景动态召回」体系：
- 风格库：建立量化风格画像（风格 DNA）+ 全书样本切片库，生成时按场景类型动态召回范文片段，并对生成结果做风格匹配度校验
- 知识库：学习时对样本片段逐块打标（场景类型/叙事手法），建立可检索的结构化场景样本库，章节生成时根据本章内容动态召回相关参考片段

## Glossary

- **风格 DNA**：对一部作品文本的量化统计画像，含句长分布、标点频率、对话占比、段落节奏、词频特征等数值特征，来自 offline_learn.js 已有统计引擎
- **场景标签**：样本片段所属的叙事场景类型，如「打斗」「对话」「心理」「环境描写」「开篇」「悬念」「日常」「高潮」等
- **样本切片**：从导入小说文本切出的可独立检索的片段单元（数百至两千字）
- **动态召回**：根据当前章节的场景/beat/人物等信息，从样本库中检索 Top-K 最相关片段注入 prompt
- **知识库语料（corpus）**：用户导入知识学习库的一部参考小说
- **风格（style）**：用户导入风格库的一位作者作品分析

## Requirements

### Requirement 1：风格库量化画像（风格 DNA）

**User Story:** AS 小说作者，I want 系统对我导入的作品建立量化风格画像，so that 生成时有精确可校验的文风标准，而非模糊的文字描述。

#### Acceptance Criteria

1. WHEN 用户完成风格分析（POST /api/styles），THE system SHALL 对全文运行统计分析引擎，生成风格 DNA（句长分布、标点频率、对话占比、段落节奏、高频词、感官词密度等数值特征）并与 LLM 分析结果一同存储
2. WHEN 风格 DNA 生成完成，THE system SHALL 在风格详情中同时展示 LLM 文字分析与量化特征（图表或数值列表）
3. IF 风格文本长度超过 10 万字，THE system SHALL 依据抽样策略（开头/中间/结尾）计算风格 DNA 以控制计算耗时

### Requirement 2：风格样本切片库

**User Story:** AS 小说作者，I want 导入作品的优秀片段被完整保存并按场景打标，so that 创作时能按需取用最相关的范文章段。

#### Acceptance Criteria

1. WHEN 用户完成风格分析，THE system SHALL 将全文切分为样本切片（每片 500-2000 字）并存储，样本量覆盖全书（允许上限控制，如单作品最多 2000 片）
2. WHEN 样本切片入库，THE system SHALL 对每片提取场景标签与叙事特征（可用 LLM 批量打标或规则预分类），标签集至少含：对话、打斗/动作、心理、环境、开篇、悬念/转折、日常、情绪高潮
3. WHEN 用户查看风格详情，THE system SHALL 支持按场景标签浏览样本切片

### Requirement 3：章节生成时动态风格召回

**User Story:** AS 小说作者，I want 每章生成时自动召回与本章场景匹配的范文片段，so that 文风参照与当前正在写的内容强相关。

#### Acceptance Criteria

1. WHEN 章节生成请求包含本章场景信息（beat 类型/场景名/概要），THE system SHALL 从已启用风格的样本切片库中召回 Top-K（默认 3-6 片，总量 ≤3000 字）与本章场景标签匹配的范文片段
2. WHEN 召回完成，THE system SHALL 将召回片段替换现有固定「真人文风参照」注入位置，并标注片段的场景类型与来源风格
3. IF 已启用风格存在风格 DNA，THE system SHALL 在 prompt 中以紧凑数值形式注入风格 DNA 摘要（目标句长、对话占比等）
4. IF 样本库为空或召回结果不足，THE system SHALL 回退到现有固定样本注入方式，保证生成流程可用

### Requirement 4：生成结果风格匹配度校验

**User Story:** AS 小说作者，I want 每章生成后自动校验成品与目标风格 DNA 的匹配度，so that 文风偏差被量化发现并可自动修复。

#### Acceptance Criteria

1. WHEN 章节正文生成完成且启用风格含风格 DNA，THE system SHALL 对成章运行同一统计引擎，计算与目标风格 DNA 的偏差分（0-100，数值越小越匹配）
2. WHEN 偏差分超过阈值（默认 40），THE system SHALL 在检测报告中列出偏差最大的维度（如"平均句长偏长 35%""对话占比偏低"）并支持一键按目标 DNA 重润
3. WHEN 风格匹配度校验完成，THE system SHALL 将偏差分写入 AI 味走势数据，供趋势查看

### Requirement 5：知识库结构化场景样本库

**User Story:** AS 小说作者，I want 知识库学习时对参考小说片段逐块打标入库，so that 参考作品的经验可被按场景检索复用。

#### Acceptance Criteria

1. WHEN 用户导入知识库语料并开始学习（POST /api/knowledge/import），THE system SHALL 在现有分块分析流程中为每块样本提取结构化标签（场景类型、叙事视角、情绪走向、信息密度），存入样本标签表
2. WHEN 学习完成，THE system SHALL 保留现有 7 维度综合报告，并新增场景样本标签统计（各类场景的分布概况）在详情页展示
3. IF 学习过程中打标失败，THE system SHALL 将该块标记为未分类，学习流程继续

### Requirement 6：章节生成时知识库动态召回

**User Story:** AS 小说作者，I want 章节生成时根据本章内容从知识库召回相关参考片段，so that 参考信息与当前剧情/场景相关，替代固定取开头片段的方式。

#### Acceptance Criteria

1. WHEN 章节生成且小说关联了知识库语料，THE system SHALL 以本章概要、beat 场景描述、出场人物为查询，从关联语料的样本切片库中检索 Top-K（默认 3-5 片，总量 ≤4000 字）相关片段
2. WHEN 召回完成，THE system SHALL 将动态召回片段用于「参考文笔与剧情样本」注入位置，并保留现有防抄袭约束文案
3. IF 召回无结果，THE system SHALL 回退到现有固定取样逻辑
4. WHEN 知识库语料被打标，THE system SHALL 支持按场景类型过滤召回（如本章为打斗场景则优先打斗类参考片段）

### Requirement 7：学习过程可视化与可配

**User Story:** AS 小说作者，I want 学习过程更细的进度展示与参数可选，so that 大文本学习可控、可预估。

#### Acceptance Criteria

1. WHEN 风格分析或知识库学习进行中，THE system SHALL 按阶段（分块→逐块打标→DNA 统计→综合合成）展示进度与当前阶段说明
2. WHEN 用户发起学习，THE system SHALL 允许选择分析深度档位（快速：抽样块分析；标准：全部分块；默认标准），档位影响块大小与块数
3. IF 分析块数超过 50，THE system SHALL 按 5 万字/块换算并提示用户预计耗时

## Non-Functional Requirements

1. 样本切片检索复用 rag.js 的纯 JS TF-IDF 方案，单次检索耗时在万级切片下 ≤200ms
2. 新增表结构向后兼容：已有 styles / knowledge_corpora 数据在升级后仍可用（缺失 DNA/切片时走回退路径）
3. 全部新功能在无云端 LLM 配置时降级可用（DNA 统计与规则预分类为纯本地计算）

## Out of Scope

- 自定义大模型微调（用户已明确暂缓）
- 修改生成主链路（章节生成流程结构保持不变，仅替换注入源）
- 风格库多作品融合冲突检测（可作为后续迭代）
