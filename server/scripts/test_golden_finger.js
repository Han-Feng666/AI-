// 系统文金手指延续性验证脚本
// 用法：node scripts/test_golden_finger.js
// 凭据从 server/.env 读取（TEST_LLM_BASE_URL / TEST_LLM_API_KEY / TEST_LLM_MODEL），.env 已被 .gitignore 排除
// 验证内容：
//   1. sysExempt 豁免逻辑（本地正则，不调 API）
//   2. 正文生成 A/B 对比：修复前（无灵感注入）vs 修复后（含【灵感设定】块）第 3 章正文里系统元素的出现情况

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 读取 .env ----------
function loadEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  const out = {};
  if (!fs.existsSync(envFile)) return out;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv();
const BASE_URL = env.TEST_LLM_BASE_URL;
const API_KEY = env.TEST_LLM_API_KEY;
const MODEL = env.TEST_LLM_MODEL;
if (!BASE_URL || !API_KEY) {
  console.error('缺少 TEST_LLM_BASE_URL / TEST_LLM_API_KEY，请先配置 server/.env');
  process.exit(1);
}

// ---------- 灵感（用户提供，与小说一致） ----------
const CONCEPT = '陈若辰穿到了古代，成了大夏朝最没存在感的太史令,刚穿越就绑定了爆款史书系统，完成系统的任务可以获得奖励，完不成就要毙命；为了不被系统惩罚又能活命,他只好把虎狼朝堂写成爆款连载,无心插柳办起了天下第一份官办小报《朝闻录》,从此权贵抢热搜、大臣买水军,而他成了皇帝离不开的"大夏第一写手"。（开篇钩子：第一次上朝系统逼他把"摄政王与太后争吵"写成《震惊！满朝文武竟因为一个女人大打出手》；他怕掉脑袋,改成《今日朝会暂无大事》,结果被皇帝御笔朱批"平淡无奇,隔日再报"。系统提示:不爆更,就爆毙。）';

// ---------- 测试 1：sysExempt 豁免逻辑（与 routes.js 修复后一致） ----------
function testExemptLogic() {
  console.log('=== 测试 1：AI 套路检测豁免逻辑（本地正则） ===');
  const pattern = /签到诸天|系统绑定|系统提示|叮[，~！]|发布.{0,3}任务|系统空间|属性面板|宿主：/;

  const cases = [
    { name: '灵感含"系统"，正文含系统提示 → 豁免', full: '叮！系统提示：任务完成', ctx: '灵感里有爆款史书系统', expect: false },
    { name: '灵感不含"系统"，正文含系统提示 → 修复前误判', full: '叮！系统提示：任务完成', ctx: '金手指是史书助手', expect: true },
    { name: '概要含"系统"，正文含系统提示 → 修复后豁免', full: '叮！系统提示：任务完成', ctx: '本章概要：系统发布新任务', expect: false },
  ];

  let pass = 0;
  for (const c of cases) {
    const flagged = pattern.test(c.full) && !/系统|签到/.test(c.ctx) ? true : false;
    const ok = flagged === c.expect;
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${c.name} (flagged=${flagged})`);
  }
  console.log(`  结果: ${pass}/${cases.length} 通过\n`);
  return pass === cases.length;
}

// ---------- 正文生成（A/B 对比） ----------
async function generateChapterBody(userPrompt, maxTokens) {
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: '你是职业中文小说作者，按给定的上下文与设定创作正文。只输出正文本身。' },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.9,
      stream: false
    })
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return String(data.choices?.[0]?.message?.content || '');
}

// 系统元素关键词统计
const SYSTEM_PATTERNS = [
  /系统提示/, /系统发布|发布.{0,3}任务/, /系统面板|属性面板/, /宿主/, /叮[，！~]/,
  /爆款史书系统/, /任务.{0,6}(奖励|惩罚|完成|失败)/, /不爆更.{0,3}就?爆毙/
];

function countSystemMentions(text) {
  const hits = [];
  for (const p of SYSTEM_PATTERNS) {
    const m = text.match(new RegExp(p.source, 'g'));
    if (m) hits.push(...m);
  }
  return hits.length;
}

const PREV_TAIL = `上一章结尾：
…陈若辰把刚誊抄完的《大夏起居注》放回架上，指尖还沾着墨渍。殿外传来内侍的通传声，说摄政王在御书房等他。他心头一紧，上次系统发布的任务期限，就在三日之内。`;

function buildUserPrompt(withConcept) {
  // 模拟修复前：上下文只有世界观/前情，无灵感
  // 模拟修复后：注入【灵感设定】块 + 延续指令（与本次 routes.js 修复一致）
  const conceptBlock = withConcept
    ? `【灵感设定（本书设定的真相来源，每章创作都必须遵守）】
${CONCEPT}
- 若灵感含系统/金手指设定，本章必须按其规则自然延续（任务/奖励/惩罚/面板等至少一处体现），不得让金手指本章消失
`
    : '';
  return `【作品名称】《朝闻录》
【类型】历史穿越+系统流
【世界观设定】
大夏朝，朝堂暗流涌动，摄政王与太后明争暗斗。主角陈若辰身穿至此，任太史令。

【前情摘要】
第1章 陈若辰穿越成为太史令，觉醒爆款史书系统，第一次上朝被系统逼迫写《震惊体》报道，他改成《今日朝会暂无大事》被皇帝朱批"平淡无奇，隔日再报"，系统提示不爆更就爆毙。
第2章 陈若辰为完成系统任务，冒险刊发第一期《朝闻录》，意外引起权贵注意。

${conceptBlock}${PREV_TAIL}

本章信息：
- 章节序号：第 3 章
- 本章剧情概要：摄政王召见陈若辰，试探《朝闻录》的背景；系统同时发布新任务，要求三日内写出爆更
- 目标字数：约 600 字

请开始创作本章正文。`;
}

async function testAB() {
  console.log('=== 测试 2：正文生成 A/B 对比（deepseek-v4-flash 实测） ===');
  console.log('  场景：第 3 章正文生成，检查系统元素是否延续\n');

  const maxTokens = 1600;
  const results = {};

  for (const [label, withConcept] of [['A-修复前(无灵感注入)', false], ['B-修复后(灵感注入+延续指令)', true]]) {
    process.stdout.write(`  生成 ${label} …`);
    try {
      const text = await generateChapterBody(buildUserPrompt(withConcept), maxTokens);
      const mentions = countSystemMentions(text);
      const hasSys = /系统/.test(text);
      results[label] = { text, mentions, hasSys };
      console.log(` 完成（正文字数≈${text.replace(/\s/g, '').length}，系统元素命中 ${mentions} 处，含"系统"字样=${hasSys}）`);
    } catch (e) {
      console.log(` 失败: ${e.message}`);
      results[label] = { error: e.message };
    }
  }

  console.log('\n  ---------- 关键结论 ----------');
  const a = results['A-修复前(无灵感注入)'];
  const b = results['B-修复后(灵感注入+延续指令)'];
  if (!a.error && !b.error) {
    console.log(`  修复前系统元素命中: ${a.mentions} 处`);
    console.log(`  修复后系统元素命中: ${b.mentions} 处`);
    console.log(`  结论: ${b.mentions > a.mentions || (b.mentions >= 1 && a.mentions === 0) ? '修复有效——灵感注入让系统元素在后续章节延续' : '需人工检查差异'}`);
  } else {
    console.log(`  A 错误: ${a.error || '无'} | B 错误: ${b.error || '无'}`);
  }

  // 输出正文样本供人工检查（各自截取 300 字）
  for (const [label, r] of Object.entries(results)) {
    if (r.text) console.log(`\n  【${label} 正文开头 300 字】\n  ${r.text.replace(/\n+/g, '\n  ').slice(0, 450)}`);
  }
  return !a.error && !b.error;
}

// 长程连载场景：前情摘要完全不提系统（模拟用户故障——概要断线后系统消失）
const PREV_TAIL_LONG = `上一章结尾：
…陈若辰把刚誊抄完的《大夏起居注》放回架上，指尖还沾着墨渍。殿外传来内侍的通传声，说摄政王在御书房等他。他心头一紧，握紧了袖中的手。`;

function buildUserPromptLong(withConcept) {
  const conceptBlock = withConcept
    ? `【灵感设定（本书设定的真相来源，每章创作都必须遵守）】
${CONCEPT}
- 若灵感含系统/金手指设定，本章必须按其规则自然延续（任务/奖励/惩罚/面板等至少一处体现），不得让金手指本章消失
`
    : '';
  return `【作品名称】《朝闻录》
【类型】历史穿越+系统流
【世界观设定】
大夏朝，朝堂暗流涌动，摄政王与太后明争暗斗。主角陈若辰身穿至此，任太史令。

【前情摘要】
第4章 陈若辰刊发第二期《朝闻录》，写摄政王府扩建一事，引来工部郎中登门威胁。
第5章 皇帝设宴试探群臣态度，陈若辰在席上应对得体，被太后身边掌事姑姑记住名字。
第6章 御史台参奏《朝闻录》妄议朝政，陈若辰被扣薪俸，报馆险些被查封。
第7章 摄政王幕僚匿名投书，提供太后一党贪墨漕银的线索，陈若辰犹豫是否刊发。

${conceptBlock}${PREV_TAIL_LONG}

本章信息：
- 章节序号：第 8 章
- 本章剧情概要：摄政王召见陈若辰，试探《朝闻录》的背景与立场
- 目标字数：约 600 字

请开始创作本章正文。`;
}

async function testLongRange() {
  console.log('\n=== 测试 3：长程连载场景（前情无系统信息，复现用户故障） ===');
  console.log('  场景：第 8 章正文，前情摘要 4-7 章全是朝堂戏、零系统字样\n');

  const maxTokens = 1600;
  const results = {};
  for (const [label, withConcept] of [['A-修复前', false], ['B-修复后', true]]) {
    process.stdout.write(`  生成 ${label} …`);
    try {
      const text = await generateChapterBody(buildUserPromptLong(withConcept), maxTokens);
      const mentions = countSystemMentions(text);
      results[label] = { text, mentions };
      console.log(` 完成（系统元素命中 ${mentions} 处）`);
    } catch (e) {
      console.log(` 失败: ${e.message}`);
      results[label] = { error: e.message };
    }
  }
  const a = results['A-修复前'];
  const b = results['B-修复后'];
  if (!a.error && !b.error) {
    console.log(`\n  ---------- 决定性结论 ----------`);
    console.log(`  修复前系统元素命中: ${a.mentions} 处（预期 0——系统随概要断线消失，即用户遇到的故障）`);
    console.log(`  修复后系统元素命中: ${b.mentions} 处（预期 >=1——灵感注入兜底）`);
    console.log(`  判定: ${a.mentions === 0 && b.mentions >= 1 ? 'PASS——修复有效，故障复现且被修复' : '需人工检查'}`);
    if (b.text) console.log(`\n  【B-修复后 正文全文】\n  ${b.text.replace(/\n+/g, '\n  ')}`);
  } else {
    console.log(`  A 错误: ${a.error || '无'} | B 错误: ${b.error || '无'}`);
  }
  return !a.error && !b.error;
}

// ---------- main ----------
const t1 = testExemptLogic();
const t2 = await testAB();
const t3 = await testLongRange();
console.log(`\n=== 总体: 豁免逻辑 ${t1 ? 'PASS' : 'FAIL'} | 短程A/B ${t2 ? '已执行' : '失败'} | 长程A/B ${t3 ? '已执行' : '失败'} ===`);
process.exit(t1 && t2 && t3 ? 0 : 1);
