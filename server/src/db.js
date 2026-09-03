import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 桌面模式通过 NOVEL_DATA_DIR 把数据库放到用户数据目录（安装目录不可写）
const dataDir = process.env.NOVEL_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'novel-studio.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS novels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  genre TEXT DEFAULT '',
  concept TEXT DEFAULT '',
  world_view TEXT DEFAULT '',
  outline TEXT DEFAULT '',
  chapter_word_count INTEGER DEFAULT 2000,
  target_chapters INTEGER DEFAULT 20,
  status TEXT DEFAULT 'draft',
  cover_color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  word_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role_type TEXT DEFAULT '配角',
  personality TEXT DEFAULT '',
  background TEXT DEFAULT '',
  description TEXT DEFAULT '',
  avatar_color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  relation_type TEXT DEFAULT '朋友',
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT DEFAULT '',
  analysis TEXT DEFAULT '',
  source_text TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS foreshadowings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  chapter_index INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id, chapter_index);
CREATE INDEX IF NOT EXISTS idx_chat_novel ON chat_messages(novel_id);
CREATE INDEX IF NOT EXISTS idx_characters_novel ON characters(novel_id);
CREATE INDEX IF NOT EXISTS idx_relationships_novel ON relationships(novel_id);
CREATE INDEX IF NOT EXISTS idx_foreshadow_novel ON foreshadowings(novel_id);

CREATE TABLE IF NOT EXISTS world_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  category TEXT DEFAULT '其他',
  name TEXT NOT NULL,
  content TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_world_settings_novel ON world_settings(novel_id);

CREATE TABLE IF NOT EXISTS novel_key_moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT '事件',
  chapter_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_key_moments_novel ON novel_key_moments(novel_id);

CREATE TABLE IF NOT EXISTS novel_stage_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  stage_no INTEGER NOT NULL,
  stage_start INTEGER NOT NULL,
  stage_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_stage_memories_novel ON novel_stage_memories(novel_id, stage_no);

CREATE TABLE IF NOT EXISTS novel_character_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  char_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  chapter_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_character_profiles_novel ON novel_character_profiles(novel_id, char_name);

CREATE TABLE IF NOT EXISTS chapter_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  chapter_index INTEGER NOT NULL,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_backups_chapter ON chapter_backups(novel_id, chapter_index, id);

CREATE TABLE IF NOT EXISTS ai_detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL,
  chapter_index INTEGER NOT NULL,
  score INTEGER DEFAULT 0,
  issues TEXT DEFAULT '[]',
  blacklist TEXT DEFAULT '[]',
  source TEXT DEFAULT 'detect',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_ai_detections_novel ON ai_detections(novel_id, chapter_index, id);

CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  kind TEXT DEFAULT 'revise',
  feedback TEXT DEFAULT '',
  accepted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_plan_versions_novel ON plan_versions(novel_id, version_no);

CREATE TABLE IF NOT EXISTS plan_drafts (
  novel_id INTEGER PRIMARY KEY REFERENCES novels(id) ON DELETE CASCADE,
  form TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS plan_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  prev_version_no INTEGER,
  next_version_no INTEGER,
  feedback TEXT,
  summary TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_plan_change_log_novel ON plan_change_log(novel_id);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  progress INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  stream_cursor TEXT DEFAULT '',
  error TEXT DEFAULT '',
  params TEXT DEFAULT '',
  result_ref TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_novel ON generation_jobs(novel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);

-- 生成资源观测：每次章节生成记录续写轮数与触发分布，用于调阈值/成本观测
CREATE TABLE IF NOT EXISTS generation_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER,
  chapter_index INTEGER,
  stage TEXT DEFAULT '',
  rounds INTEGER DEFAULT 0,
  state TEXT DEFAULT '',
  pipe_reason TEXT DEFAULT '',
  rs_model TEXT DEFAULT '',
  start_words INTEGER DEFAULT 0,
  target_words INTEGER DEFAULT 0,
  seamless_words INTEGER DEFAULT 0,
  ms_connecting INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_gen_stats_time ON generation_stats(created_at);
CREATE INDEX IF NOT EXISTS idx_gen_stats_novel ON generation_stats(novel_id);

CREATE TABLE IF NOT EXISTS manager_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER,
  role TEXT NOT NULL,
  content TEXT DEFAULT '',
  tool_call_id TEXT DEFAULT '',
  tool_name TEXT DEFAULT '',
  tool_args TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_manager_msgs ON manager_messages(novel_id, id);

CREATE TABLE IF NOT EXISTS manager_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pending_tool_calls (
  id TEXT PRIMARY KEY,
  novel_id INTEGER,
  message_id INTEGER,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  result TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pending_tool_status ON pending_tool_calls(status);

CREATE TABLE IF NOT EXISTS relationship_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  UNIQUE(novel_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_nodes_novel ON relationship_nodes(novel_id);

CREATE TABLE IF NOT EXISTS shared_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role_type TEXT DEFAULT '配角',
  personality TEXT DEFAULT '',
  background TEXT DEFAULT '',
  description TEXT DEFAULT '',
  avatar_color TEXT DEFAULT '#6366f1',
  source_novel_id INTEGER REFERENCES novels(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// ===== P0-P3 长篇记忆基础设施 =====
// P0-1: 分层摘要树 — level 0=单章, 1=节(5章), 2=卷(25章), 3=部(100章)
db.exec(`
CREATE TABLE IF NOT EXISTS chapter_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  start_chapter INTEGER NOT NULL,
  end_chapter INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(novel_id, level, start_chapter)
);
CREATE INDEX IF NOT EXISTS idx_chap_sum ON chapter_summaries(novel_id, level, start_chapter);

-- P0-2: 向量检索 RAG — 每章分块存储 + embedding BLOB
CREATE TABLE IF NOT EXISTS chapter_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  keywords TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chunks ON chapter_chunks(novel_id, chapter_index);

-- P1-1: 结构化事实库 — 角色属性/能力/关系/世界状态，带 superseded_by 版本链
CREATE TABLE IF NOT EXISTS novel_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  superseded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_facts ON novel_facts(novel_id, subject_type, subject_name);

-- P1-2: 角色时间线 — 每章角色变化 diff
CREATE TABLE IF NOT EXISTS character_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_char_tl ON character_timeline(novel_id, chapter_index);

-- P2-2: 文笔漂移日志
CREATE TABLE IF NOT EXISTS style_drift_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  drift_score REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- P3: 时间线管理 — 故事内时间流逝 + 事件
CREATE TABLE IF NOT EXISTS novel_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  story_time TEXT,
  event_description TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_timeline ON novel_timeline(novel_id, chapter_index);
`);

// 角色语音档案 — 每个角色的说话方式/惯用词/口头禅
db.exec(`
CREATE TABLE IF NOT EXISTS character_voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
  character_name TEXT NOT NULL,
  speech_pattern TEXT,
  vocabulary TEXT,
  catchphrases TEXT,
  tone TEXT,
  updated_chapter INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(novel_id, character_name)
);
`);
// 兼容旧库：确保列存在
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('chapters', 'summary', 'summary TEXT DEFAULT \'\'');
ensureColumn('chapters', 'emotion', "emotion TEXT DEFAULT ''");
ensureColumn('chapters', 'arc_hint', "arc_hint TEXT DEFAULT ''");
ensureColumn('chapters', 'hook', "hook TEXT DEFAULT ''");
ensureColumn('novels', 'style_ids', "style_ids TEXT DEFAULT '[]'");
ensureColumn('novels', 'compressed_context', "compressed_context TEXT DEFAULT ''");
ensureColumn('novels', 'context_compressed', "context_compressed INTEGER DEFAULT 0");
ensureColumn('novels', 'style_baseline', "style_baseline TEXT DEFAULT ''");
ensureColumn('novels', 'compressed_upto_chapter', "compressed_upto_chapter INTEGER DEFAULT 0");
ensureColumn('manager_memory', 'novel_id', "novel_id INTEGER");
ensureColumn('manager_memory', 'created_at', "created_at TEXT DEFAULT (datetime('now','localtime'))");
ensureColumn('novels', 'style_samples', "style_samples TEXT DEFAULT ''");
ensureColumn('novels', 'style_presets', "style_presets TEXT DEFAULT ''");
ensureColumn('chapters', 'ai_score', 'ai_score INTEGER DEFAULT NULL');
ensureColumn('chapters', 'beats', "beats TEXT DEFAULT ''");
ensureColumn('styles', 'style_samples', "style_samples TEXT DEFAULT ''");
ensureColumn('novels', 'length_class', "length_class TEXT DEFAULT 'long'");
ensureColumn('novels', 'constitution', "constitution TEXT DEFAULT ''");
ensureColumn('characters', 'shared_id', 'shared_id INTEGER DEFAULT NULL');
ensureColumn('foreshadowings', 'expected_recall_chapter', "expected_recall_chapter INTEGER");

// ===== 知识学习库（导入小说学习文笔/剧情/逻辑） =====
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_corpora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  author TEXT DEFAULT '',
  source_filename TEXT DEFAULT '',
  total_words INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  analysis TEXT DEFAULT '',
  learned_at TEXT DEFAULT (datetime('now','localtime')),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_genre ON knowledge_corpora(genre);

CREATE TABLE IF NOT EXISTS knowledge_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_id INTEGER NOT NULL REFERENCES knowledge_corpora(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_samples ON knowledge_samples(corpus_id, chunk_index);
`);
ensureColumn('novels', 'knowledge_corpus_ids', "knowledge_corpus_ids TEXT DEFAULT ''");
ensureColumn('novels', 'skill_ids', "skill_ids TEXT DEFAULT '[]'");

// ===== 风格 DNA 与样本切片（风格库引擎升级） =====
ensureColumn('styles', 'style_dna', "style_dna TEXT DEFAULT ''");
ensureColumn('knowledge_samples', 'scene_tags', "scene_tags TEXT DEFAULT ''");
ensureColumn('knowledge_samples', 'keywords', "keywords TEXT DEFAULT ''");
ensureColumn('knowledge_corpora', 'tag_status', "tag_status TEXT DEFAULT ''");
ensureColumn('chapters', 'style_deviation', 'style_deviation INTEGER DEFAULT NULL');

db.exec(`
CREATE TABLE IF NOT EXISTS style_slices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  slice_index INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  scene_tags TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_style_slices ON style_slices(style_id, slice_index);
`);

// ===== 技能库 =====
db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'technique',
  description TEXT DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags TEXT DEFAULT '',
  usage_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// 预设技能种子数据
const skillCount = db.prepare('SELECT COUNT(*) as c FROM skills').get().c;
if (skillCount === 0) {
  const seedSkills = [
    {
      name: '悬念设置技巧',
      type: 'technique',
      description: '章末钩子、信息揭露节奏、伏笔回收，让读者欲罢不能',
      content: '每章结尾必须留一个具体的悬念钩子——不是"他发现了真相"，而是"他拆开包裹，里面躺着一枚刻着他名字的铜牌"。信息揭露遵循"先露一角→逐步展开→反转"的节奏，每个悬念在 3-5 章内要有推进或回应。钩子可以是危机降临、新谜团出现、关键人物登场或一个惊人发现，但不能为制造悬念而违背逻辑。',
      tags: '悬念,剧情,节奏,钩子'
    },
    {
      name: '对话写作技法',
      type: 'technique',
      description: '让角色对话自然生动、符合人物性格，告别工具化对白',
      content: '每个角色的说话方式由其性格、身份和情绪决定，不能千人一面。对话有潜台词——角色真正想说的往往不是字面意思。紧张场景对话短促有力，舒缓场景允许长句慢节奏。对话必须有冲突或目的，纯寒暄的对话应该删掉。通过动作描写来标识说话者，不要每句都加"他说""她道"。',
      tags: '对话,人物,台词'
    },
    {
      name: '环境描写技法',
      type: 'technique',
      description: '五感描写、氛围渲染、环境叙事，让场景立体鲜活',
      content: '场景切换时用 2-3 个感官细节快速建立氛围，视觉加听觉加嗅觉或触觉就够了。环境描写反映角色心理——焦虑时看到的是墙上的裂缝，平静时注意到的是窗外的光线。战斗场景的环境描写简洁有力，用短句切换焦点。每个环境细节最好有叙事功能，不要为描写而描写。',
      tags: '环境,描写,氛围,感官'
    },
    {
      name: '节奏控制技巧',
      type: 'technique',
      description: '张弛有度的叙事节奏，让读者在紧张与舒缓间获得最佳阅读体验',
      content: '高潮之后必须有舒缓段落让读者消化，舒缓段落不宜超过一章。紧张时短句短段，舒缓时长句细腻。每 3-5 章设一个小转折，每 10-15 章一个重大转折。战斗追逐中插入瞬间的"时间膨胀"描写增强张力。多线叙事时在每条线的悬念处切换，保持读者对所有线的关注。',
      tags: '节奏,张弛,结构,高潮'
    },
    {
      name: '人物塑造技法',
      type: 'technique',
      description: '通过行动、选择、细节塑造立体人物，而非贴标签',
      content: '人物的性格通过行动和选择展示，不用旁白贴标签。每个主要角色应有至少一个矛盾特质，比如勇敢但怕高，聪明但不自信。配角要有自己的动机，不能只为推动剧情而存在。人物成长要有触发事件和渐进过程，不能突变。反派的行为逻辑在其自身视角下应该是合理的。用小细节——习惯、口头禅、随身物品——让角色鲜活。',
      tags: '人物,角色,塑造,成长'
    },
    {
      name: '打斗场面写作',
      type: 'technique',
      description: '紧张刺激、画面感强的打斗场面，让读者身临其境',
      content: '打斗前要有心理铺垫，让读者期待冲突。打斗时用短句短段，节奏越快句子越短。聚焦两三个关键感官——动作加声音加触感，不用面面俱到。每个动作有明确的目的和后果，不是"你来我往"的回合制。打斗中插入角色心理活动，让读者了解策略和情绪变化。打斗结果要推动剧情或人物成长，打完了就完了等于白写。',
      tags: '打斗,动作,战斗,场面'
    }
  ];
  const insertSkill = db.prepare('INSERT INTO skills (name, type, description, content, tags) VALUES (?,?,?,?,?)');
  for (const s of seedSkills) {
    insertSkill.run(s.name, s.type, s.description, s.content, s.tags);
  }
}

// ===== 势力/组织系统 =====
db.exec(`
CREATE TABLE IF NOT EXISTS factions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT DEFAULT '帮派',
  description TEXT DEFAULT '',
  power_level TEXT DEFAULT '',
  territory TEXT DEFAULT '',
  leader TEXT DEFAULT '',
  stance TEXT DEFAULT '中立',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_factions_novel ON factions(novel_id);
`);
ensureColumn('characters', 'faction', "faction TEXT DEFAULT ''");
ensureColumn('characters', 'age', "age TEXT DEFAULT ''");
ensureColumn('characters', 'goal', "goal TEXT DEFAULT ''");
ensureColumn('characters', 'ability', "ability TEXT DEFAULT ''");
ensureColumn('novels', 'story_arcs', "story_arcs TEXT DEFAULT ''");
ensureColumn('novels', 'expanded_world', "expanded_world TEXT DEFAULT ''");
ensureColumn('novels', 'protagonist_name', "protagonist_name TEXT DEFAULT ''");
ensureColumn('novels', 'heroine_name', "heroine_name TEXT DEFAULT ''");

// ===== 整本改编（TXT 导入底稿 + 逐章候选） =====
db.exec(`
CREATE TABLE IF NOT EXISTS adaptation_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  intent TEXT DEFAULT '',
  plan TEXT DEFAULT '',
  plans TEXT DEFAULT '',
  status TEXT DEFAULT 'drafting_plan',
  current_index INTEGER DEFAULT 0,
  total_chapters INTEGER DEFAULT 0,
  accepted_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_adapt_jobs_novel ON adaptation_jobs(novel_id, id DESC);

CREATE TABLE IF NOT EXISTS adaptation_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES adaptation_jobs(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  original_title TEXT DEFAULT '',
  original_content TEXT DEFAULT '',
  candidate_title TEXT DEFAULT '',
  candidate_content TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_adapt_cand_job ON adaptation_candidates(job_id, chapter_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adapt_cand_unique ON adaptation_candidates(job_id, chapter_index);

CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  author TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  target TEXT NOT NULL DEFAULT 'style',
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  total_chapters INTEGER DEFAULT 0,
  fetched_chapters INTEGER DEFAULT 0,
  skipped_chapters INTEGER DEFAULT 0,
  deobf_unknown INTEGER DEFAULT 0,
  content TEXT DEFAULT '',
  result_ref TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_book ON import_jobs(book_id, target);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status, id);

CREATE TABLE IF NOT EXISTS book_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  search_url TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  partial_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'enabled',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);
ensureColumn('adaptation_jobs', 'plans', "plans TEXT DEFAULT ''");
ensureColumn('import_jobs', 'source_type', "source_type TEXT DEFAULT 'fanqie'");
ensureColumn('import_jobs', 'book_url', "book_url TEXT DEFAULT ''");
ensureColumn('import_jobs', 'source_site', "source_site TEXT DEFAULT ''");

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function now() {
  return new Date().toISOString();
}

function touchNovel(id) {
  db.prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(now(), id);
}

export { getSetting, setSetting, touchNovel };
