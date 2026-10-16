import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// 隔离数据目录：必须在 db.js 首次加载前设置（db.js 单例在首次 import 时建库）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideas-lock-test-'));
process.env.NOVEL_DATA_DIR = dataDir;

// 用 mock.module 替换 llm.js：routes.js/prompts.js/model_router.js 从同一模块取 chat，
// 其余导出保持真实实现（live binding 不感知 mock.method，必须整模块替换）。
// chat 行为通过 __ideaChatImpl 可变闭包驱动，测试内可随时切换返回内容。
const realLLM = await import('../src/llm.js');
const LLM_EXPORTS = Object.keys(realLLM);

globalThis.__ideaChatImpl = async () => ({ content: '' });
globalThis.__ideaChatCalls = [];
const mockChat = async (opts) => {
  const impl = globalThis.__ideaChatImpl;
  const r = impl(opts);
  const out = await r;
  globalThis.__ideaChatCalls.push({ opts, out });
  return out;
};

mock.module('../src/llm.js', {
  namedExports: {
    ...Object.fromEntries(LLM_EXPORTS.map((k) => [k, realLLM[k]])),
    chat: mockChat
  }
});

// mock.module 替换后，再动态导入 routes.js 及其依赖链，它们拿到的 chat 已是 stub
const { db, setSetting } = await import('../src/db.js');
const { default: routes } = await import('../src/routes.js');
const { chat } = await import('../src/llm.js');

// 准备 LLM 配置：requireLLM 需要 model + apiKey（非 ollama）
setSetting('llm_config', JSON.stringify({
  provider: 'openai',
  model: 'gpt-test',
  apiKey: 'test-key',
  forceNonStreaming: true,
  temperature: 0.9
}));
setSetting('llm_models', '[]');

let baseUrl;
let server;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', routes);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  mock.reset();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const rawFetch = globalThis.fetch;

async function api(method, url, body) {
  const res = await rawFetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { status: res.status, data };
}

// 收集 SSE 事件流：data: {...} 行 → 对象数组
async function collectSSE(url, body) {
  const res = await rawFetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((chunk) => {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }).filter(Boolean);
  return { status: res.status, events };
}

const SUGGEST_JSON = {
  protagonistName: ['林晚', '沈星河', '顾念安', '云慕白'],
  protagonistIdentity: ['外门杂役弟子', '废弃丹房的药童', '藏书阁抄书人', '掌刑堂见习执事'],
  protagonistPersonality: ['谨慎盘算', '沉默隐忍', '张扬锋锐', '温和周全'],
  goldenFinger: ['残缺功法补全', '丹方记忆传承', '器物通晓之能', '气运吞纳'],
  plotDirection: ['宗门大比登顶之路', '夺回被占祖地的抗争', '经营一方势力扩张', '破解师门旧案沉冤'],
  coreConflict: ['守约与背约', '身份冒充', '被公开的秘密', '旧案重启'],
  openingForm: ['当场利害', '意外卷入', '野心求取', '契约交易']
};

describe('POST /ideas/suggestions', () => {
  test('正常解析：7 字段各返回 3-4 个候选', async () => {
    globalThis.__ideaChatImpl = async () => ({ content: JSON.stringify(SUGGEST_JSON) });
    const res = await api('POST', '/ideas/suggestions', { genres: ['玄幻'], channel: '男频' });
    assert.equal(res.status, 200);
    const s = res.data?.suggestions || {};
    for (const k of Object.keys(SUGGEST_JSON)) {
      assert.ok(Array.isArray(s[k]), `${k} 应为数组`);
      assert.ok(s[k].length >= 3 && s[k].length <= 4, `${k} 候选数应为 3-4，实际 ${s[k].length}`);
    }
  });

  test('解析失败 → 返回空 suggestions 且不报错', async () => {
    globalThis.__ideaChatImpl = async () => ({ content: '抱歉，我无法生成建议。' });
    const res = await api('POST', '/ideas/suggestions', { genres: ['都市'], channel: '男频' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { suggestions: {} });
  });

  test('chat 抛错 → 返回空 suggestions 且不报错', async () => {
    globalThis.__ideaChatImpl = async () => { throw new Error('upstream down'); };
    const res = await api('POST', '/ideas/suggestions', { genres: ['都市'], channel: '男频' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { suggestions: {} });
  });

  test('缺题材 → 400', async () => {
    const res = await api('POST', '/ideas/suggestions', { genres: [] });
    assert.equal(res.status, 400);
  });
});

describe('POST /ideas 锁定字段硬约束', () => {
  test('lockedFields 注入 userPrompt 硬约束块', async () => {
    const ideasJSON = [
      {
        title: '守约之人', genre: '玄幻', hook: '大殿上当众立誓，三年之约钉进命纹。',
        logline: '外门杂役弟子林晚，以残缺功法补全为基，踏宗门大比登顶之路。',
        core_contrast: '守约 vs 背约',
        protagonist: { name: '林晚', identity: '外门杂役弟子', personality: '谨慎盘算', golden_finger: '残缺功法补全' },
        outline_H5: ['第一段', '第二段', '第三段', '第四段', '第五段']
      }
    ];
    globalThis.__ideaChatImpl = async () => ({ content: JSON.stringify(ideasJSON) });
    const { events } = await collectSSE('/ideas', {
      genres: ['玄幻'],
      count: 2,
      lockedFields: {
        protagonistName: '林晚',
        goldenFinger: '残缺功法补全',
        plotDirection: '宗门大比登顶之路'
      }
    });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, '应有 done 事件');
    assert.ok(done.data?.ideas?.length >= 1, '应有合规创意保留');

    // 校验发给模型的 userPrompt 包含硬约束块
    const ideaCall = globalThis.__ideaChatCalls.find((c) => c.opts?.messages?.some((m) => m.role === 'user' && String(m.content).includes('请一次构思')));
    assert.ok(ideaCall, '应有 /ideas 的 chat 调用');
    const userText = String(ideaCall.opts.messages.find((m) => m.role === 'user').content);
    assert.ok(userText.includes('主角与剧情硬约束'), 'userPrompt 应含硬约束块标题');
    assert.ok(userText.includes('主角姓名必须为：林晚'), '应锁定主角姓名');
    assert.ok(userText.includes('金手指/最大优势必须为：残缺功法补全'), '应锁定金手指');
  });

  test('偏离锁定值（金手指/主角名不同）的创意被剔除', async () => {
    const ideasJSON = [
      {
        title: '守约之人', genre: '玄幻', hook: '大殿上当众立誓，三年之约钉进命纹。',
        logline: '外门杂役弟子林晚，以残缺功法补全为基，踏宗门大比登顶之路。',
        core_contrast: '守约 vs 背约',
        protagonist: { name: '林晚', identity: '外门杂役弟子', personality: '谨慎盘算', golden_finger: '残缺功法补全' },
        outline_H5: ['第一段', '第二段', '第三段', '第四段', '第五段']
      },
      {
        title: '夺运魔尊', genre: '玄幻', hook: '魔宗血池边，他一掌拍碎十年仇敌的命牌。',
        logline: '散修张楚，以血炼功法为基，踏上夺运之路。',
        core_contrast: '夺运 vs 守心',
        protagonist: { name: '张楚', identity: '散修', personality: '狠戾', golden_finger: '血炼功法' },
        outline_H5: ['A', 'B', 'C', 'D', 'E']
      }
    ];
    globalThis.__ideaChatImpl = async () => ({ content: JSON.stringify(ideasJSON) });
    const { events } = await collectSSE('/ideas', {
      genres: ['玄幻'],
      count: 2,
      lockedFields: {
        protagonistName: '林晚',
        goldenFinger: '残缺功法补全'
      }
    });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, '应有 done 事件');
    const titles = (done.data?.ideas || []).map((it) => it.title);
    assert.ok(titles.includes('守约之人'), '合规创意应保留');
    assert.ok(!titles.includes('夺运魔尊'), '偏离锁定的创意应被剔除');
    // 剔除时应有状态提示
    const rejected = events.find((e) => e.type === 'status' && e.message && e.message.includes('未遵循你锁定设定'));
    assert.ok(rejected, '应推送剔除状态提示');
  });

  test('lockedFields 全空 → 与旧版一致（无硬约束块）', async () => {
    globalThis.__ideaChatCalls = [];
    const ideasJSON = [
      {
        title: '灵根觉醒', genre: '玄幻', hook: '测灵台上，废弃灵根一朝异变。',
        logline: '外门杂役弟子以残缺功法补全为基，踏上宗门大比登顶之路。',
        core_contrast: '平凡 vs 超凡',
        protagonist: { name: '任意名', identity: '外门弟子', personality: '坚韧', golden_finger: '残缺功法补全' },
        outline_H5: ['A', 'B', 'C', 'D', 'E']
      }
    ];
    globalThis.__ideaChatImpl = async () => ({ content: JSON.stringify(ideasJSON) });
    const { events } = await collectSSE('/ideas', {
      genres: ['玄幻'],
      count: 2
    });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, '应有 done 事件');
    assert.ok(done.data?.ideas?.length >= 1, '应有创意保留');
    const ideaCall = globalThis.__ideaChatCalls.find((c) => c.opts?.messages?.some((m) => m.role === 'user' && String(m.content).includes('请一次构思')));
    assert.ok(ideaCall, '应有 /ideas 的 chat 调用');
    const userText = String(ideaCall.opts.messages.find((m) => m.role === 'user').content);
    assert.ok(!userText.includes('主角与剧情硬约束'), '全空时不应注入硬约束块');
  });
});

describe('IDEAS_SUGGESTIONS_SYSTEM prompt 结构', () => {
  test('包含 7 字段输出结构说明', async () => {
    const { IDEAS_SUGGESTIONS_SYSTEM } = await import('../src/prompts.js');
    for (const k of ['protagonistName', 'protagonistIdentity', 'protagonistPersonality', 'goldenFinger', 'plotDirection', 'coreConflict', 'openingForm']) {
      assert.ok(IDEAS_SUGGESTIONS_SYSTEM.includes(k), `应包含 ${k}`);
    }
    assert.ok(IDEAS_SUGGESTIONS_SYSTEM.includes('输出 JSON 对象'), '应要求输出 JSON');
  });
});
