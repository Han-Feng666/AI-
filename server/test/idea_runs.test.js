import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startIdeaRun, finishIdeaRun, getIdeaRun, pruneIdeaRuns } from '../src/ideaRuns.js';

test('ideaRuns: start -> done 全链路落盘与取回', () => {
  const rid = `test-${Date.now()}-a`;
  const run = startIdeaRun(rid, { genres: ['玄幻'], count: 3 });
  assert.equal(run.status, 'running');
  assert.deepEqual(run.ideas, []);

  finishIdeaRun(rid, { type: 'done', data: { ideas: [{ id: 'idea-1', title: '测试创意' }] } });
  const done = getIdeaRun(rid);
  assert.equal(done.status, 'done');
  assert.equal(done.ideas.length, 1);
  assert.equal(done.ideas[0].title, '测试创意');
});

test('ideaRuns: error 与 aborted 终态落盘', () => {
  const ridE = `test-${Date.now()}-e`;
  startIdeaRun(ridE, {});
  finishIdeaRun(ridE, { type: 'error', message: '额度用尽' });
  assert.equal(getIdeaRun(ridE).status, 'error');
  assert.equal(getIdeaRun(ridE).error, '额度用尽');

  const ridA = `test-${Date.now()}-ab`;
  startIdeaRun(ridA, {});
  finishIdeaRun(ridA, { type: 'aborted', message: '已取消' });
  assert.equal(getIdeaRun(ridA).status, 'aborted');
});

test('ideaRuns: 同 requestId 重启覆盖旧状态（重新生成语义）', () => {
  const rid = `test-${Date.now()}-r`;
  startIdeaRun(rid, {});
  finishIdeaRun(rid, { type: 'done', data: { ideas: [{ id: 1 }] } });
  startIdeaRun(rid, {});
  const run = getIdeaRun(rid);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.ideas, []);
});

test('ideaRuns: 空 requestId 不落盘、未知 id 返回 null', () => {
  assert.equal(startIdeaRun('', {}), null);
  assert.equal(getIdeaRun('nonexistent-xyz'), null);
});

test('ideaRuns: pruneIdeaRuns 不抛错', () => {
  assert.doesNotThrow(() => pruneIdeaRuns());
});
