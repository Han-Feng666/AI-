# 灵感生成器「填入信息」定制功能 — 需求文档

## Introduction

在现有「灵感生成器」中新增一个**前置定制面板**：AI 根据用户已勾选的题材与风格，为「主角个人信息」「剧情走向」等关键要素生成若干候选选项（下拉/多选/填空形式）。用户可直接采纳 AI 生成的建议，也可自行输入自定义内容。采纳或填写的值作为**硬约束**注入后续批量创意的生成，从而解决三个已知痛点：批量创意剧情/金手指雷同、主角信息错乱（名字/身份/性别与题材不符）、生成结果与用户预期不符。

## Glossary

- **System（灵感生成器）**: 现有页面 `/inspiration`，根据用户题材/风格批量产出小说创意（`POST /ideas`）。
- **定制面板**: 本功能新增的字段填写区，位于题材/风格选择之后、批量生成按钮之前。
- **候选选项**: AI 按需生成的可选建议值（每字段一批 3-4 个）。
- **硬约束**: 用户填写/采纳的值必须被后续批量生成的创意严格采用。

## Requirements

### Requirement 1: 定制面板字段区

**User Story:** AS 用户，I want 在生成创意前能定制主角与剧情关键要素，so that 批量产出符合预期、不雷同。

#### Acceptance Criteria

1. WHEN 用户进入灵感生成器页面，THE System SHALL 在题材/风格选择后显示「定制主角与剧情」面板。
2. WHEN 面板展开，THE System SHALL 提供以下字段区：主角姓名、主角身份、主角性格、金手指/最大优势、主线剧情走向、核心冲突、开局形态。
3. WHEN 任一字段已填写，THE System SHALL 在字段上显示「已锁定」标记并支持清除。
4. WHEN 用户未填写任何字段，THE System SHALL 保持现有自由生成行为，不影响兼容旧流程。

### Requirement 2: AI 候选建议生成

**User Story:** AS 用户，I want 基于已选题材/风格一键获取候选选项，so that 不用自己想也能填出高质量定制。

#### Acceptance Criteria

1. WHEN 用户在面板点击「AI 帮我生成建议」，THE System SHALL 根据当前勾选的题材、风格基调、目标频道生成一批候选选项填充各字段。
2. WHEN 建议已生成，THE System SHALL 允许用户再次点击以换一批候选。
3. WHEN 建议生成中，THE System SHALL 显示加载状态且不可重复触发。
4. IF 建议生成失败，THE System SHALL 保留字段现有内容并提示可重试，不阻塞后续批量生成。

### Requirement 3: 候选采纳与自定义输入

**User Story:** AS 用户，I want 可采纳 AI 候选或自行输入，so that 定制完全可控。

#### Acceptance Criteria

1. WHEN 字段存在 AI 候选选项，THE System SHALL 以可选择形式（tag/下拉）展示，点击即采纳该值填入字段。
2. WHEN 用户选择自定义输入，THE System SHALL 允许直接编辑该字段，并覆盖当前候选。
3. WHEN 字段值为空，THE System SHALL 允许用户直接输入自定义内容。

### Requirement 4: 硬约束注入批量生成

**User Story:** AS 用户，I want 填写的值被后续创意严格采用，so that 结果符合我的预期。

#### Acceptance Criteria

1. WHEN 用户填写或采纳主角姓名，THE System SHALL 在批量生成的每个创意中沿用该姓名（或按此主角展开）。
2. WHEN 用户填写或采纳金手指/最大优势，THE System SHALL 使每个创意的金手指必须以此为根基，禁止替换为其他金手指。
3. WHEN 用户填写或采纳剧情走向/核心冲突/开局形态，THE System SHALL 使每个创意的对应字段贴合该约束，同时保持创意间差异化。
4. WHEN 字段已锁定，THE System SHALL 在批量生成的提示词中声明这些值为最高优先级硬约束。

### Requirement 5: 跨批次去重兼容

**User Story:** AS 用户，I want 定制约束不破坏现有跨批次去重，so that 不会因锁定而重复。

#### Acceptance Criteria

1. WHEN 用户锁定了主角姓名/金手指等字段，THE System SHALL 仍保留「已生成过的创意自动避开」行为。
2. WHEN 硬约束与去重要求冲突，THE System SHALL 优先保证锁定字段一致，同时在可差异化维度（冲突机制/开局形态/世界观切入）保持创意间差异。

### Requirement 6: 方案生成承接

**User Story:** AS 用户，I want 定制的主角信息贯穿到创作方案，so that 全流程角色设定一致。

#### Acceptance Criteria

1. WHEN 用户基于定制后的创意进入方案生成，THE System SHALL 将锁定字段随创意 concept 与建书参数一并传递。
2. WHEN 方案生成时存在主角名，THE System SHALL 沿用现有 `protagonistName` 通道（`novels.protagonist_name`）。
3. WHEN 用户锁定了剧情走向相关字段，THE System SHALL 将其并入 concept，使方案层尊重该走向。
