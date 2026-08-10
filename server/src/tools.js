import { db } from './db.js';
import { getNovel, getCharacters, getRelationships, getChapters } from './lib.js';
import { getActiveJobByNovel } from './jobs.js';
import { webSearch, formatSearchResults } from './web_search.js';

// Phase 5：Manager 工具注册器。
// schema 用于透传给 LLM 的 OpenAI function-calling 协议。
// 每项含 { name, description, parameters(openai schema), needsAuth, executor }
export const toolRegistry = {
  get_novel_progress: {
    needsAuth: false,
    schema: {
      type: 'function',
      function: {
        name: 'get_novel_progress',
        description: '查询任意小说当前的生成进度、章节数与世界状态。用于作者询问"现在 A 书写得怎样了"。',
        parameters: {
          type: 'object',
          properties: { novel_id: { type: 'integer', description: '小说 ID' } },
          required: ['novel_id']
        }
      }
    },
    executor: async ({ novel_id }) => {
      const novel = getNovel(novel_id);
      if (!novel) return { error: '小说不存在' };
      const chapters = getChapters(novel_id);
      const active = getActiveJobByNovel(novel_id);
      return {
        title: novel.title,
        status: novel.status,
        chapterCount: chapters.length,
        wordsWritten: chapters.reduce((s, c) => s + (c.word_count || 0), 0),
        targetChapters: novel.target_chapters,
        lastActivity: novel.updated_at,
        activeJob: active ? { stage: active.stage, status: active.status, progress: active.progress } : null
      };
    }
  },

  list_shared_characters: {
    needsAuth: false,
    schema: {
      type: 'function',
      function: {
        name: 'list_shared_characters',
        description: '列出跨书可联动的共享角色池，供作者在新书引入联动。',
        parameters: { type: 'object', properties: {} }
      }
    },
    executor: async () => db.prepare('SELECT * FROM shared_characters ORDER BY id').all()
  },

  introduce_shared_character: {
    needsAuth: true,
    schema: {
      type: 'function',
      function: {
        name: 'introduce_shared_character',
        description: '把共享池中的一个角色引入到指定小说，形成跨书联动。',
        parameters: {
          type: 'object',
          properties: {
            novel_id: { type: 'integer', description: '目标小说 ID' },
            shared_id: { type: 'integer', description: '共享角色 ID' }
          },
          required: ['novel_id', 'shared_id']
        }
      }
    },
    executor: async ({ novel_id, shared_id }) => {
      const s = db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(shared_id);
      if (!s) return { error: '共享角色不存在' };
      const info = db.prepare(
        'INSERT INTO characters (novel_id, name, role_type, personality, background, description, avatar_color, shared_id) VALUES (?,?,?,?,?,?,?,?)'
      ).run(novel_id, s.name, s.role_type, s.personality, s.background, s.description, s.avatar_color, s.id);
      return { characterId: info.lastInsertRowid, name: s.name, fromShared: s.id };
    }
  },

  update_outline: {
    needsAuth: true,
    schema: {
      type: 'function',
      function: {
        name: 'update_outline',
        description: '修改指定小说的剧情大纲，不动其他字段。仅当作者明确要求改大纲时调用。',
        parameters: {
          type: 'object',
          properties: {
            novel_id: { type: 'integer', description: '小说 ID' },
            new_outline: { type: 'string', description: '新剧情大纲全文' }
          },
          required: ['novel_id', 'new_outline']
        }
      }
    },
    executor: async ({ novel_id, new_outline }) => {
      const novel = getNovel(novel_id);
      if (!novel) return { error: '小说不存在' };
      db.prepare("UPDATE novels SET outline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(String(new_outline), novel_id);
      return { ok: true, title: novel.title };
    }
  },

  update_character: {
    needsAuth: true,
    schema: {
      type: 'function',
      function: {
        name: 'update_character',
        description: '按角色名修改指定小说中某角色的字段（personality/background/description/role_type），不动名字。',
        parameters: {
          type: 'object',
          properties: {
            novel_id: { type: 'integer' },
            name: { type: 'string', description: '现有角色名（须精确匹配）' },
            patch: {
              type: 'object',
              description: '要更新的字段（只传要修改的）',
              properties: {
                personality: { type: 'string' },
                background: { type: 'string' },
                description: { type: 'string' },
                role_type: { type: 'string' }
              }
            }
          },
          required: ['novel_id', 'name', 'patch']
        }
      }
    },
    executor: async ({ novel_id, name, patch }) => {
      const c = db.prepare('SELECT * FROM characters WHERE novel_id = ? AND name = ?').get(novel_id, String(name));
      if (!c) return { error: `小说 ${novel_id} 中无名为「${name}」的角色` };
      const sets = [];
      const vals = [];
      for (const f of ['personality', 'background', 'description', 'role_type']) {
        if (patch[f] !== undefined) { sets.push(`${f} = ?`); vals.push(String(patch[f])); }
      }
      if (!sets.length) return { error: 'patch 为空' };
      vals.push(c.id);
      db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      // 同步到 shared_characters 池（防止分叉）
      if (c.shared_id) {
        db.prepare(`UPDATE shared_characters SET ${sets.join(', ')} WHERE id = ?`).run(...vals.slice(0, sets.length), c.shared_id);
      }
      return { ok: true, characterId: c.id };
    }
  },

  request_revise: {
    needsAuth: true,
    schema: {
      type: 'function',
      function: {
        name: 'request_revise',
        description: '触发某小说的方案修订任务（与作者在前端点"提交意见"等价），后端会创建 revise Job。',
        parameters: {
          type: 'object',
          properties: {
            novel_id: { type: 'integer' },
            feedback: { type: 'string', description: '给 AI 的修改意见（作者口头转达的）' }
          },
          required: ['novel_id', 'feedback']
        }
      }
    },
    // executor 仅插入 pending_tool_calls 行供前端授权后通过既有 /plan/revise 路由真正触发；
    // 真正发起 Job 由前端授权通过既有的 SSE 通道完成（避免双重 Job 创建）
    executor: async ({ novel_id, feedback }) => ({ ok: true, hint: '须由前端经 /novels/:id/plan/revise 触发', novel_id, feedback })
  },

  request_generate_chapter: {
    needsAuth: true,
    schema: {
      type: 'function',
      function: {
        name: 'request_generate_chapter',
        description: '触发某小说的下一章生成（与作者在前端点"生成下一章"等价）。',
        parameters: {
          type: 'object',
          properties: {
            novel_id: { type: 'integer' }
          },
          required: ['novel_id']
        }
      }
    },
    executor: async ({ novel_id }) => ({ ok: true, hint: '须由前端经 /novels/:id/chapters/generate 触发', novel_id })
  },

  web_search: {
    needsAuth: false,
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '搜索互联网获取实时信息、最新资讯、技术文档或具体事实。适用于用户询问你不确定的知识、需要查证的信息或需要参考真实素材的场景。不适用于小说创意构思类问题。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，用核心词而非整句' }
          },
          required: ['query']
        }
      }
    },
    executor: async ({ query }) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('search_engine');
      const engine = row ? row.value : 'duckduckgo';
      const searxRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('searx_url');
      const searxUrl = searxRow ? searxRow.value : '';
      const bingKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('bing_api_key');
      const bingApiKey = bingKeyRow ? bingKeyRow.value : '';
      const bingEpRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('bing_endpoint');
      const bingEndpoint = bingEpRow ? bingEpRow.value : '';
      const data = await webSearch(query, { engine, searxUrl, bingApiKey, bingEndpoint, count: 8, fetchContent: true });
      return { query: data.query, engine: data.engine, resultCount: data.results.length, results: data.results.slice(0, 5), formatted: formatSearchResults(data) };
    }
  }
};

export function getToolSchemas() {
  return Object.values(toolRegistry).map((t) => t.schema);
}

export function schemasFor(names) {
  return names.map((n) => toolRegistry[n]?.schema).filter(Boolean);
}
