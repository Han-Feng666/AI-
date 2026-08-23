<script setup>
import { computed, ref, onMounted } from 'vue';
import { useEditorStore } from '../stores/editor';
import { api } from '../api';
import { formatWords, splitGenres } from '../utils/format';

const store = useEditorStore();

const written = computed(() => store.chapters.filter((c) => c.word_count > 0));
const writtenCount = computed(() => written.value.length);
const plannedCount = computed(() => store.chapters.length);
const target = computed(() => Number(store.novel?.target_chapters) || 0);
const totalWords = computed(() => store.totalWords);
const avgWords = computed(() => (writtenCount.value ? Math.round(totalWords.value / writtenCount.value) : 0));
const completionRate = computed(() => {
  if (!target.value) return plannedCount.value ? Math.round((writtenCount.value / plannedCount.value) * 100) : 0;
  return Math.min(100, Math.round((writtenCount.value / target.value) * 100));
});
const longest = computed(() => written.value.reduce((m, c) => (c.word_count > (m?.word_count || 0) ? c : m), null));
const shortest = computed(() => written.value.reduce((m, c) => (!m || c.word_count < m.word_count ? c : m), null));
const maxWords = computed(() => written.value.reduce((m, c) => Math.max(m, c.word_count || 0), 0) || 1);
const nextUnwritten = computed(() => store.chapters.find((c) => !c.word_count));
const avgAiScore = computed(() => {
  const scored = written.value.filter((c) => c.ai_score != null);
  if (!scored.length) return null;
  return Math.round(scored.reduce((s, c) => s + c.ai_score, 0) / scored.length);
});
const openFores = computed(() => store.foreshadowings.filter((f) => f.status === 'open'));
const resolvedFores = computed(() => store.foreshadowings.filter((f) => f.status === 'resolved'));
const factions = computed(() => store.factions || []);
const charByType = computed(() => {
  const map = {};
  for (const c of store.characters) {
    const t = c.role_type || '配角';
    map[t] = (map[t] || 0) + 1;
  }
  return map;
});
const wordsPerDay = computed(() => {
  if (!written.value.length) return 0;
  const dates = [...new Set(written.value.map((c) => c.updated_at?.slice(0, 10)))].filter(Boolean);
  if (!dates.length) return 0;
  return Math.round(totalWords.value / dates.length);
});
const estimatedWords = computed(() => {
  if (!target.value) return 0;
  return target.value * avgWords.value;
});
const updated = computed(() => {
  const t = store.novel?.updated_at;
  if (!t) return '';
  try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
});

const genStats = ref(null);
const detectStats = ref(null);
const loadingGen = ref(false);

async function loadGenStats() {
  loadingGen.value = true;
  try {
    const [g, d] = await Promise.all([api.getGenerationStats(), api.getAiDetectStats()]);
    genStats.value = g;
    detectStats.value = d;
  } catch { genStats.value = null; detectStats.value = null; }
  finally { loadingGen.value = false; }
}

const passRate = computed(() => detectStats.value?.passRate ?? null);
const detectBuckets = computed(() => detectStats.value?.buckets || []);
const genTotal = computed(() => genStats.value?.total?.n || 0);
const genAvgRounds = computed(() => genStats.value?.total?.avg_rounds ?? null);
const genTotalMs = computed(() => genStats.value?.total?.duration_ms || 0);
const genRecent = computed(() => genStats.value?.recent || []);
const passBucket = computed(() => {
  if (!detectStats.value?.total) return null;
  return (detectStats.value.buckets[0]?.n || 0) + (detectStats.value.buckets[1]?.n || 0);
});
const roundLabel = (r) => ['生成', '1 轮润色', '2 轮润色', '3 轮润色'][r] || `${r} 轮润色`;

const PIPE_LABELS = {
  generate_chapter: '章节生成',
  plan: '方案生成',
  plan_revise: '方案修订',
  chapter_revise: '章节修订',
  polish: '润色',
  manager: 'AI总管'
};

onMounted(loadGenStats);
</script>

<template>
  <div class="stats-panel">
    <div class="stats-title">创作统计</div>

    <div v-if="!plannedCount" class="stats-empty">
      <el-empty description="尚未生成创作方案，暂无统计数据" :image-size="80">
        <el-button type="primary" @click="store.setWorkspace('setup')">去生成方案</el-button>
      </el-empty>
    </div>

    <template v-else>
      <div class="stats-hero">
        <div class="hero-item">
          <div class="hero-num">{{ formatWords(totalWords) }}</div>
          <div class="hero-label">全书总字数</div>
        </div>
        <div class="hero-item">
          <div class="hero-num">{{ writtenCount }}<span class="hero-sub"> / {{ target || plannedCount }}</span></div>
          <div class="hero-label">已写章节</div>
        </div>
        <div class="hero-item">
          <div class="hero-num">{{ avgWords }}</div>
          <div class="hero-label">平均每章字数</div>
        </div>
      </div>

      <div class="stats-block">
        <div class="block-head">
          <span class="block-label">完成进度</span>
          <span class="block-value">{{ completionRate }}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: completionRate + '%' }"></div>
        </div>
        <div class="block-foot">已写 {{ writtenCount }} 章 / 共 {{ target || plannedCount }} 章<span v-if="target && target > plannedCount">（其中 {{ plannedCount - writtenCount }} 章待生成正文）</span></div>
      </div>

      <div v-if="plannedCount > writtenCount" class="stats-tip">
        <el-icon><InfoFilled /></el-icon>
        <span>下一章待创作：第 {{ nextUnwritten?.chapter_index || (writtenCount + 1) }} 章{{ nextUnwritten?.title ? '·' + nextUnwritten.title : '' }}。可前往「章节」面板点「生成下一章」继续。</span>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="card-label">已规划大纲</div>
          <div class="card-num">{{ plannedCount }} 章</div>
        </div>
        <div class="stat-card">
          <div class="card-label">角色数量</div>
          <div class="card-num">{{ store.characters.length }} 人</div>
        </div>
        <div class="stat-card">
          <div class="card-label">势力数量</div>
          <div class="card-num">{{ factions.length }} 个</div>
        </div>
        <div class="stat-card">
          <div class="card-label">待回收伏笔</div>
          <div class="card-num">{{ openFores.length }} 条</div>
        </div>
        <div class="stat-card">
          <div class="card-label">已回收伏笔</div>
          <div class="card-num">{{ resolvedFores.length }} 条</div>
        </div>
        <div class="stat-card">
          <div class="card-label">AI 味均分</div>
          <div class="card-num">{{ avgAiScore != null ? avgAiScore + ' 分' : '未检测' }}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">日均产出</div>
          <div class="card-num">{{ wordsPerDay ? formatWords(wordsPerDay) + ' 字' : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">全书预估</div>
          <div class="card-num">{{ estimatedWords ? formatWords(estimatedWords) + ' 字' : '—' }}</div>
        </div>
      </div>

      <div v-if="Object.keys(charByType).length" class="stats-block">
        <div class="block-label">角色类型分布</div>
        <div class="type-dist">
          <div v-for="(count, type) in charByType" :key="type" class="type-item">
            <el-tag size="small" :type="type === '主角' || type === '大反派' ? 'danger' : type === '主角团' || type === '红颜' ? 'warning' : 'info'">{{ type }}</el-tag>
            <span class="type-count">{{ count }} 人</span>
          </div>
        </div>
      </div>

      <div v-if="factions.length" class="stats-block">
        <div class="block-label">势力一览</div>
        <div class="faction-dist">
          <div v-for="f in factions" :key="f.id" class="faction-item">
            <span class="fac-dist-name">{{ f.name }}</span>
            <el-tag size="small" effect="plain">{{ f.type }}</el-tag>
            <el-tag v-if="f.stance" size="small" :type="f.stance === '正派' ? 'success' : f.stance === '邪派' ? 'danger' : 'info'">{{ f.stance }}</el-tag>
          </div>
        </div>
      </div>

      <div v-if="longest" class="stats-block">
        <div class="block-label">章节字数分布</div>
        <div class="dist-list">
          <div v-for="c in store.chapters" :key="c.chapter_index" class="dist-row" :class="{ unwritten: !c.word_count }">
            <span class="dist-no">{{ c.chapter_index }}</span>
            <div class="dist-track">
              <div class="dist-bar" :style="{ width: (c.word_count ? Math.max(3, Math.round((c.word_count / maxWords) * 100)) : 0) + '%' }"></div>
            </div>
            <span class="dist-words">{{ c.word_count ? formatWords(c.word_count) + ' 字' : '待创作' }}</span>
          </div>
        </div>
      </div>

      <div v-if="longest && shortest && longest.chapter_index !== shortest.chapter_index" class="stats-grid">
        <div class="stat-card">
          <div class="card-label">最长章节</div>
          <div class="card-num">{{ longest.word_count }} 字</div>
          <div class="card-sub">第 {{ longest.chapter_index }} 章</div>
        </div>
        <div class="stat-card">
          <div class="card-label">最短章节</div>
          <div class="card-num">{{ shortest.word_count }} 字</div>
          <div class="card-sub">第 {{ shortest.chapter_index }} 章</div>
        </div>
      </div>

      <div class="stats-block">
        <div class="block-head">
          <span class="block-label">生成质量观测</span>
          <span class="block-value" v-if="detectStats?.total">{{ passRate }}% 达标</span>
        </div>
        <div v-if="loadingGen" class="loading-hint">加载中…</div>
        <div v-else-if="!genTotal && !detectStats?.total" class="empty-hint">尚无生成记录，写完一章后此处会展示 AI 味达标率、润色轮次与耗时。</div>
        <template v-else>
          <div class="q-grid">
            <div class="q-item">
              <div class="q-num">{{ genTotal }}<span class="q-unit"> 次</span></div>
              <div class="q-label">累计生成</div>
            </div>
            <div class="q-item">
              <div class="q-num">{{ genAvgRounds ?? '—' }}</div>
              <div class="q-label">平均润色轮次</div>
            </div>
            <div class="q-item">
              <div class="q-num">{{ genTotalMs ? Math.round(genTotalMs / 1000) + 's' : '—' }}</div>
              <div class="q-label">累计耗时</div>
            </div>
            <div class="q-item">
              <div class="q-num">{{ passBucket ?? '—' }}<span v-if="passBucket != null" class="q-unit"> 次</span></div>
              <div class="q-label">达标次数</div>
            </div>
          </div>

          <div v-if="detectBuckets.length && detectStats?.total" class="q-block">
            <div class="q-sub">AI 味分数分布（≤20 达标）</div>
            <div class="bucket-list">
              <div v-for="b in detectBuckets" :key="b.label" class="bucket-row">
                <span class="bucket-label">{{ b.label }}</span>
                <div class="bucket-track">
                  <div class="bucket-bar" :class="{ ok: b.label === '0-10' || b.label === '11-20' }"
                       :style="{ width: Math.max(b.n ? 4 : 0, Math.round((b.n / detectStats.total) * 100)) + '%' }"></div>
                </div>
                <span class="bucket-n">{{ b.n }}</span>
              </div>
            </div>
          </div>

          <div v-if="genRecent.length" class="q-block">
            <div class="q-sub">最近生成</div>
            <div class="recent-list">
              <div v-for="r in genRecent" :key="r.id" class="recent-row">
                <span class="recent-pipe">{{ PIPE_LABELS[r.pipe_reason] || r.pipe_reason }}</span>
                <span class="recent-mid">第 {{ r.chapter_index ?? '—' }} 章{{ r.rounds ? ' · ' + roundLabel(r.rounds) : '' }}</span>
                <span class="recent-time">{{ (r.created_at || '').slice(5, 16).replace('T', ' ') }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="stats-meta">
        <div class="meta-row" v-if="store.novel?.genre"><span class="meta-k">类型</span><span class="meta-v">{{ splitGenres(store.novel.genre).join('、') }}</span></div>
        <div class="meta-row" v-if="store.novel?.style_presets?.length"><span class="meta-k">风格</span><span class="meta-v">{{ store.novel.style_presets.join('、') }}</span></div>
        <div class="meta-row"><span class="meta-k">上下文</span><span class="meta-v">{{ store.novel?.context_compressed ? '已压缩' : '完整' }}</span></div>
        <div class="meta-row" v-if="updated"><span class="meta-k">最近更新</span><span class="meta-v">{{ updated }}</span></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stats-panel {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(20,24,80,.06);
}
.stats-title {
  font-weight: 700;
  font-size: 17px;
  margin-bottom: 18px;
  color: #1e1b4b;
}
.stats-empty { padding: 40px 0; }
.stats-hero {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 22px;
}
.hero-item {
  background: linear-gradient(135deg, #f5f3ff, #eef2ff);
  border-radius: 12px;
  padding: 16px 12px;
  text-align: center;
}
.hero-num {
  font-size: 24px;
  font-weight: 700;
  color: #4f46e5;
  line-height: 1.2;
}
.hero-sub { font-size: 14px; color: #9ca3af; font-weight: 500; }
.hero-label { font-size: 12px; color: #6b7280; margin-top: 6px; }
.stats-block {
  margin-bottom: 20px;
  padding: 14px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 10px;
}
.block-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.block-label { font-weight: 700; font-size: 13px; color: #1e1b4b; }
.block-value { font-weight: 700; font-size: 15px; color: #4f46e5; }
.progress-track {
  height: 8px;
  background: #eef0f6;
  border-radius: 4px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #6366f1, #8b5cf6);
  transition: width .4s;
}
.block-foot { font-size: 12px; color: #9ca3af; margin-top: 8px; }
.stats-tip {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12.5px;
  color: #6366f1;
  background: #eef2ff;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 18px;
  line-height: 1.7;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}
.stat-card {
  background: #f9fafb;
  border-radius: 10px;
  padding: 12px 14px;
}
.card-label { font-size: 11.5px; color: #9ca3af; }
.card-num { font-size: 18px; font-weight: 700; color: #1f2937; margin-top: 4px; }
.card-sub { font-size: 11.5px; color: #9ca3af; margin-top: 2px; }
.dist-list { max-height: 280px; overflow-y: auto; margin-top: 10px; }
.dist-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.dist-row.unwritten .dist-bar { background: #e5e7eb; }
.dist-no { width: 24px; flex-shrink: 0; font-size: 11.5px; color: #9ca3af; text-align: right; }
.dist-track {
  flex: 1;
  height: 8px;
  background: #f1f3f9;
  border-radius: 4px;
  overflow: hidden;
}
.dist-bar {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #818cf8, #6366f1);
  transition: width .3s;
}
.dist-words { width: 56px; flex-shrink: 0; font-size: 11.5px; color: #6b7280; text-align: right; }
.q-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.q-item {
  background: #f9fafb;
  border-radius: 8px;
  padding: 10px 8px;
  text-align: center;
}
.q-num { font-size: 17px; font-weight: 700; color: #1f2937; }
.q-unit { font-size: 11px; color: #9ca3af; font-weight: 500; }
.q-label { font-size: 11px; color: #9ca3af; margin-top: 3px; }
.q-block { margin-top: 12px; }
.q-sub { font-size: 12px; font-weight: 700; color: #1e1b4b; margin-bottom: 8px; }
.bucket-list { display: flex; flex-direction: column; gap: 5px; }
.bucket-row { display: flex; align-items: center; gap: 8px; }
.bucket-label { width: 42px; flex-shrink: 0; font-size: 11.5px; color: #9ca3af; text-align: right; }
.bucket-track { flex: 1; height: 8px; background: #f1f3f9; border-radius: 4px; overflow: hidden; }
.bucket-bar { height: 100%; border-radius: 4px; background: #f87171; transition: width .3s; }
.bucket-bar.ok { background: #34d399; }
.bucket-n { width: 22px; flex-shrink: 0; font-size: 11.5px; color: #6b7280; }
.recent-list { max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.recent-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; border-bottom: 1px dashed #f1f3f9; }
.recent-pipe {
  flex-shrink: 0;
  font-size: 11px;
  background: #eef2ff;
  color: #4f46e5;
  border-radius: 4px;
  padding: 1px 6px;
}
.recent-mid { flex: 1; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recent-time { flex-shrink: 0; font-size: 11px; color: #9ca3af; }
.loading-hint, .empty-hint { font-size: 12.5px; color: #9ca3af; padding: 6px 0; line-height: 1.7; }
.stats-meta {
  margin-top: 20px;
  padding: 14px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 10px;
}
.type-dist {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.type-item { display: flex; align-items: center; gap: 4px; }
.type-count { font-size: 12px; color: #6b7280; font-weight: 600; }
.faction-dist { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.faction-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.fac-dist-name { font-weight: 600; color: #1e1b4b; min-width: 80px; }
.stats-meta {
  margin-top: 20px;
  padding: 14px;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 10px;
  border-top: 1px solid #eef0f6;
  padding-top: 14px;
}
.meta-row { display: flex; gap: 10px; font-size: 12.5px; margin-bottom: 6px; }
.meta-k { color: #9ca3af; flex-shrink: 0; width: 64px; }
.meta-v { color: #4b5563; }
</style>
