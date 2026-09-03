import fs from 'node:fs';
import { parseSourceBatch, searchBook } from '../src/booksource.js';

/**
 * 批量实测书源：逐源真实搜索验证规则可用性
 * 用法: node scripts/test_book_sources.js <书源json> [关键词] [输出报告]
 */

const [, , input, keyword = '剑', outReport = '/tmp/opencode/bs_test_report.json'] = process.argv;
if (!input) {
  console.error('用法: node scripts/test_book_sources.js <书源json> [关键词] [输出报告]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(input, 'utf-8'));
const { items, errors } = parseSourceBatch(JSON.stringify(raw));
console.log(`共 ${raw.length} 条源：可解析 ${items.length}，缺字段 ${errors.length}`);

const CONCURRENCY = 6;
const results = [];
let idx = 0;

async function worker(id) {
  while (idx < items.length) {
    const i = idx++;
    const src = items[i];
    const host = (() => { try { return new URL(src.sourceUrl).host; } catch { return src.sourceUrl; } })();
    const t0 = Date.now();
    let rec = { name: src.name, sourceUrl: src.sourceUrl, host, partial: src.partial, ok: false, count: 0, ms: 0, error: '' };
    try {
      const { results: found } = await searchBook(src, keyword);
      rec.ok = found.length > 0;
      rec.count = found.length;
      rec.error = found.length ? '' : '搜索无结果';
    } catch (e) {
      rec.error = `${e.code || ''} ${e.message}`.trim().slice(0, 120);
    }
    rec.ms = Date.now() - t0;
    results.push(rec);
    const done = results.length;
    if (done % 10 === 0 || done === items.length) {
      const okN = results.filter((r) => r.ok).length;
      console.log(`[进度 ${done}/${items.length}] 可用 ${okN} · 最近: ${host} ${rec.ok ? 'OK' : rec.error.slice(0, 50)} (${rec.ms}ms)`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

results.sort((a, b) => (b.ok - a.ok) || a.ms - b.ms);
const okList = results.filter((r) => r.ok);
const summary = {
  total: results.length,
  ok: okList.length,
  fail: results.length - okList.length,
  partialOk: okList.filter((r) => r.partial?.length).length
};
console.log('\n===== 汇总 =====');
console.log(`可用: ${summary.ok}/${summary.total}（其中部分支持 ${summary.partialOk}）`);
const byErr = {};
for (const r of results.filter((x) => !x.ok)) {
  const k = (r.error.match(/HTTP \d+|超时|请求失败|解析为空|ENOTFOUND|ECONNREFUSED|证书|unsupported/) || [r.error.slice(0, 40) || '未知'])[0];
  byErr[k] = (byErr[k] || 0) + 1;
}
console.log('失败分布:', JSON.stringify(byErr, null, 2));

fs.writeFileSync(outReport, JSON.stringify({ summary, keyword, results }, null, 2));
const builtin = items.filter((s) => okList.some((r) => r.sourceUrl === s.sourceUrl));
fs.writeFileSync('/tmp/opencode/bs_builtin_ok.json', JSON.stringify(builtin, null, 2));
console.log(`\n报告: ${outReport}\n可用源快照: /tmp/opencode/bs_builtin_ok.json (${builtin.length} 条)`);
