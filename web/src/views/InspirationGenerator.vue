<script setup>
import { ref, computed, reactive, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { GENRES, PRESET_STYLES, formatIdeaAsConcept } from '../utils/format';

defineOptions({ name: 'InspirationGenerator' });

const router = useRouter();

const genres = ref(['玄幻']);
const channel = ref('');
const stylePresets = ref([]);
const styleIds = ref([]);
const styleLibrary = ref([]);
const styleLibsLoading = ref(false);
const generating = ref(false);
const statusText = ref('');
const ideas = ref([]);
// 用户种子想法：给 AI 一个出发点（可空——空则纯按题材自由发挥）
const seedIdea = ref('');
const marketList = ref('');
// 每批创意数量：2-6 个（数量越多单个创意细节越薄，默认 3 平衡质量与选择面）
const ideaCount = ref(3);
// 跨批次去重：累积所有已生成创意的签名（标题/梗概/金手指），下次生成时传给后端排除
const historyIdeas = ref([]);
const selectedId = ref(null);
const creating = ref(false);
const askOpen = ref(false);
const askAction = ref(null); // null | 'direct' | 'adjust'
const adjustOpen = ref(false);
const adjustForm = ref({ title: '', genre: '', logline: '', hook: '', concept: '', protagonistName: '', goldenFinger: '' });
const adjustSaving = ref(false);

// 「定制主角与剧情」面板（v1.4.100）：AI 按题材/风格为各字段生成候选，用户可采纳或自定义，
// 值作为硬约束注入 /ideas 批量生成，治"主角信息错乱/剧情雷同/结果不符预期"
const lockedFields = reactive({
  protagonistName: '',
  protagonistIdentity: '',
  protagonistPersonality: '',
  goldenFinger: '',
  plotDirection: '',
  coreConflict: '',
  openingForm: ''
});
const suggestions = reactive({
  protagonistName: [], protagonistIdentity: [], protagonistPersonality: [],
  goldenFinger: [], plotDirection: [], coreConflict: [], openingForm: []
});
const suggestLoading = ref(false);
const suggestReady = ref(false);
const LOCK_FIELD_DEFS = [
  { key: 'protagonistName', label: '主角姓名', placeholder: '如：林晚（可留空由 AI 定）' },
  { key: 'protagonistIdentity', label: '主角身份', placeholder: '如：外门杂役弟子' },
  { key: 'protagonistPersonality', label: '主角性格', placeholder: '如：谨慎盘算、苟住发育' },
  { key: 'goldenFinger', label: '金手指 / 最大优势', placeholder: '如：残缺功法补全' },
  { key: 'plotDirection', label: '主线剧情走向', placeholder: '如：宗门大比登顶之路' },
  { key: 'coreConflict', label: '核心冲突', placeholder: '如：守约与背约' },
  { key: 'openingForm', label: '开局形态', placeholder: '如：当场利害、意外卷入' }
];
const lockedCount = computed(() => LOCK_FIELD_DEFS.filter((f) => String(lockedFields[f.key] || '').trim()).length);
const anyLocked = computed(() => lockedCount.value > 0);

// 生成候选建议：一次调用产出 7 个字段的候选；失败保留现有内容，不阻塞批量生成
async function fetchSuggestions() {
  if (suggestLoading.value) return;
  if (!genres.value.length) return ElMessage.warning('请先选择至少一个小说题材，AI 才能按题材生成建议');
  suggestLoading.value = true;
  try {
    const data = await api.getIdeaSuggestions({
      genres: genres.value,
      channel: channel.value,
      stylePresets: stylePresets.value,
      styleIds: styleIds.value,
      marketList: marketList.value.trim()
    });
    const s = data?.suggestions || {};
    let filled = 0;
    for (const f of LOCK_FIELD_DEFS) {
      const cands = Array.isArray(s[f.key]) ? s[f.key].filter((x) => String(x || '').trim()) : [];
      suggestions[f.key] = cands.slice(0, 4);
      if (cands.length) filled += 1;
    }
    suggestReady.value = filled > 0;
    if (filled) ElMessage.success('已生成候选建议，点击选项即可采纳，也可自行输入');
    else ElMessage.warning('AI 未能生成建议，请稍后重试或直接自行输入');
  } catch (e) {
    ElMessage.error(e.message || '生成建议失败，请稍后重试');
  } finally {
    suggestLoading.value = false;
  }
}

function applySuggestion(key, val) {
  lockedFields[key] = String(val || '').trim();
}
function clearLockedField(key) { lockedFields[key] = ''; }
function clearAllLocked() {
  for (const f of LOCK_FIELD_DEFS) lockedFields[f.key] = '';
}
const lockedKeys = computed(() => new Set(LOCK_FIELD_DEFS.filter((f) => String(lockedFields[f.key] || '').trim()).map((f) => f.key)));

// 卡片上展示该创意遵循了哪些锁定字段（用于确认硬约束已生效）
function honoredLocks(it = {}) {
  const p = it.protagonist || {};
  const out = [];
  const lName = String(lockedFields.protagonistName || '').trim();
  if (lName && (String(p.name || '').includes(lName) || lName.includes(String(p.name || '')))) out.push('主角名');
  const lGf = String(lockedFields.goldenFinger || '').trim();
  if (lGf && (String(p.golden_finger || '').includes(lGf) || lGf.includes(String(p.golden_finger || '')))) out.push('金手指');
  const lId = String(lockedFields.protagonistIdentity || '').trim();
  if (lId && (String(p.identity || '').includes(lId) || lId.includes(String(p.identity || '')))) out.push('身份');
  const lPs = String(lockedFields.protagonistPersonality || '').trim();
  if (lPs && (String(p.personality || '').includes(lPs) || lPs.includes(String(p.personality || '')))) out.push('性格');
  const lPlot = String(lockedFields.plotDirection || '').trim();
  const plotText = [it.logline, ...(Array.isArray(it.outline_H5) ? it.outline_H5 : [])].filter(Boolean).join('\n');
  if (lPlot && (plotText.includes(lPlot) || lPlot.includes(String(it.logline || '')))) out.push('剧情走向');
  const lConf = String(lockedFields.coreConflict || '').trim();
  const confText = [it.logline, it.hook, it.core_contrast].filter(Boolean).join('\n');
  if (lConf && (confText.includes(lConf) || lConf.includes(String(it.logline || '')))) out.push('核心冲突');
  const lOpen = String(lockedFields.openingForm || '').trim();
  const openText = [it.hook, it.logline].filter(Boolean).join('\n');
  if (lOpen && (openText.includes(lOpen) || lOpen.includes(String(it.hook || '')))) out.push('开局形态');
  return out;
}

// 断线续跑：本次生成的 requestId 持久化到 localStorage。
// 生成中断网/刷新后重新进入页面，凭它向后端轮询取回结果，正在生成的整批创意不再丢失。
const IDEA_RUN_KEY = 'idea_run_request_id';
let activeRequestId = '';
try { activeRequestId = localStorage.getItem(IDEA_RUN_KEY) || ''; } catch { activeRequestId = ''; }
let recoveryTimer = null;

function newRequestId() {
  const id = `idea-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try { localStorage.setItem(IDEA_RUN_KEY, id); } catch { /* ignore */ }
  return id;
}

// 轮询取回断线前那次生成的结果：running 继续等，done/error/aborted 落回界面
function pollIdeaRun(requestId) {
  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
  api.getIdeaRun(requestId).then((run) => {
    if (!run || run.status === 'running') {
      recoveryTimer = setTimeout(() => pollIdeaRun(requestId), 4000);
      return;
    }
    try { localStorage.removeItem(IDEA_RUN_KEY); } catch { /* ignore */ }
    activeRequestId = '';
    if (run.status === 'done' && Array.isArray(run.ideas) && run.ideas.length) {
      applyIdeas(run.ideas);
      statusText.value = '';
      ElMessage.success('已恢复断线前生成的创意');
    } else if (run.status === 'error') {
      statusText.value = '';
      ElMessage.error(run.error || '上次灵感生成失败，请重新生成');
    } else if (run.status === 'aborted') {
      statusText.value = '';
      ElMessage.info('上次灵感生成已停止，可重新生成');
    }
    generating.value = false;
  }).catch(() => {
    // 404：记录已过期或从未生成，清掉本地标记即可
    try { localStorage.removeItem(IDEA_RUN_KEY); } catch { /* ignore */ }
    activeRequestId = '';
    generating.value = false;
  });
}

function applyIdeas(list) {
  ideas.value = (list || []).map((it) => ({ ...it, expanded: false }));
  // 累积本轮创意签名，供下一批生成时去重
  for (const it of ideas.value) {
    historyIdeas.value.push({
      title: it.title || '',
      logline: it.logline || '',
      golden_finger: it.protagonist?.golden_finger || ''
    });
  }
}

const selectedIdea = computed(() => ideas.value.find((it) => it.id === selectedId.value) || null);

function toggleGenre(g) {
  const cur = genres.value;
  genres.value = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
}
function togglePreset(s) {
  const cur = stylePresets.value;
  stylePresets.value = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
}
function toggleStyleLib(id) {
  const cur = styleIds.value;
  styleIds.value = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

function regenEnabled() {
  return !generating.value && !!styleLibsLoading === false && (ideas.value.length || selectedId.value);
}

async function loadStyleLibrary() {
  styleLibsLoading.value = true;
  try {
    styleLibrary.value = await api.listStyles();
  } catch {
    styleLibrary.value = [];
  } finally {
    styleLibsLoading.value = false;
  }
}

async function generate() {
  if (!genres.value.length) return ElMessage.warning('请至少选择一个小说题材');
  if (generating.value) return;
  generating.value = true;
  statusText.value = '';
  // 失败保留旧创意：生成失败/断线时旧结果仍在界面上，用户可直接重试
  const requestId = newRequestId();
  activeRequestId = requestId;
  try {
    const data = await api.generateIdeas({
      genres: genres.value,
      channel: channel.value,
      stylePresets: stylePresets.value,
      styleIds: styleIds.value,
      count: ideaCount.value,
      seed: seedIdea.value.trim(),
      marketList: marketList.value.trim(),
      excludeIdeas: historyIdeas.value,
      lockedFields: lockedFields,
      requestId
    }, {
      onStatus: (m) => { statusText.value = m; },
      onError: (m) => { if (m) ElMessage.error(m); }
    });
    applyIdeas(data?.ideas || []);
    if (!ideas.value.length) ElMessage.info('本次没有生成到创意，请换个题材组合再试');
    statusText.value = '';
    try { localStorage.removeItem(IDEA_RUN_KEY); } catch { /* ignore */ }
    activeRequestId = '';
  } catch (e) {
    // 连接中断（断网/刷新）：后端 detachOnClose 模式下任务继续跑，启动轮询取回结果
    const isDisconnect = /网络请求失败|连接中断|请求超时/.test(e.message || '');
    if (isDisconnect && activeRequestId) {
      statusText.value = '连接中断，正在后台恢复本次生成结果…';
      pollIdeaRun(activeRequestId);
      return;
    }
    ElMessage.error(e.message);
  } finally {
    generating.value = false;
  }
}

// 选中创意后：询问是否需要调整，再决定直接生成方案还是先进调整
function onPickIdea(it) {
  selectedId.value = it.id;
  askOpen.value = true;
  askAction.value = null;
}

function cancelAsk() { askOpen.value = false; askAction.value = null; }

function chooseDirect() {
  askAction.value = 'direct';
  cancelAsk();
  createFromIdea(selectedId.value);
}

function chooseAdjust() {
  askAction.value = 'adjust';
  const it = selectedIdea.value;
  if (!it) { cancelAsk(); return; }
  adjustForm.value = {
    title: it.title || '',
    genre: it.genre || genres.value[0] || '玄幻',
    logline: it.logline || '',
    hook: it.hook || '',
    concept: formatIdeaAsConcept(it),
    protagonistName: String(lockedFields.protagonistName || '').trim() || it.protagonist?.name || '',
    goldenFinger: String(lockedFields.goldenFinger || '').trim() || it.protagonist?.golden_finger || ''
  };
  cancelAsk();
  adjustOpen.value = true;
}

async function confirmAdjust() {
  if (!adjustForm.value.title.trim()) return ElMessage.warning('请填写作品标题');
  if (adjustSaving.value) return;
  adjustSaving.value = true;
  try {
    const orig = selectedIdea.value || {};
    const idea = {
      title: adjustForm.value.title,
      genre: adjustForm.value.genre,
      logline: adjustForm.value.logline,
      hook: adjustForm.value.hook,
      protagonist: {
        ...(orig.protagonist || {}),
        name: adjustForm.value.protagonistName,
        golden_finger: adjustForm.value.goldenFinger
      },
      protagonist2: orig.protagonist2 || null,
      selling_point: orig.selling_point,
      outline_H5: orig.outline_H5,
      potential_risk: orig.potential_risk
    };
    const concept = (adjustForm.value.concept.trim() || formatIdeaAsConcept(idea)) + lockedConceptSuffix(idea);
    adjustOpen.value = false;
    await buildNovelFromIdea(idea, concept);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    adjustSaving.value = false;
  }
}

async function createFromIdea(id) {
  const it = ideas.value.find((x) => x.id === id);
  if (!it) return;
  await buildNovelFromIdea(it, formatIdeaAsConcept(it) + lockedConceptSuffix(it));
}

// 定制锁定字段并入 concept：让方案层在生成世界/大纲/角色时尊重这些硬约束
function lockedConceptSuffix(idea = {}) {
  const lines = [];
  const lockedName = String(lockedFields.protagonistName || '').trim();
  if (lockedName && String(idea.protagonist?.name || '') !== lockedName) {
    lines.push(`主角名锁定为：${lockedName}`);
  }
  for (const key of ['protagonistIdentity', 'protagonistPersonality', 'goldenFinger', 'plotDirection', 'coreConflict', 'openingForm']) {
    const val = String(lockedFields[key] || '').trim();
    if (!val) continue;
    const label = LOCK_FIELD_DEFS.find((f) => f.key === key)?.label || key;
    lines.push(`${label}：${val}`);
  }
  return lines.length ? `\n\n【用户定制的硬约束】\n${lines.join('\n')}` : '';
}

async function buildNovelFromIdea(idea, concept) {
  if (creating.value) return;
  creating.value = true;
  try {
    // 定制锁定的主角名优先于创意卡片自产名——避免锁定后被卡片名覆盖导致信息错乱
    const lockedName = String(lockedFields.protagonistName || '').trim();
    const finalName = lockedName || idea.protagonist?.name || '';
    const novel = await api.createNovel({
      title: idea.title,
      genre: idea.genre || genres.value[0] || '玄幻',
      // 勾选题材全集随建书落库：方案生成的题材边界校验依赖它，只传卡片题材会让其余勾选题材丢失
      checkedGenres: [...genres.value],
      concept: concept || formatIdeaAsConcept(idea),
      idea,
      protagonistName: finalName,
      chapterWordCount: 2000,
      targetChapters: 20,
      stylePresets: stylePresets.value,
      styleIds: styleIds.value
    });
    ElMessage.success(`已创建《${idea.title}》，进入创作方案生成…`);
    router.push(`/novel/${novel.id}`);
  } catch (e) {
    ElMessage.error(e.message);
    creating.value = false;
  }
}

onMounted(() => {
  loadStyleLibrary();
  // 断线续跑：进入页面时若存在未完成的那次生成（localStorage 残留 requestId），轮询取回结果
  if (activeRequestId) {
    generating.value = true;
    statusText.value = '正在恢复上次未完成的灵感生成…';
    pollIdeaRun(activeRequestId);
  }
});

onBeforeUnmount(() => {
  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
});
</script>

<template>
  <div class="idea-page">
    <div class="page-head">
      <div>
        <h2 class="page-title">灵感生成器</h2>
        <p class="page-sub">还没有灵感？选好题材与风格，AI 会批量产出数个可直接开写的小说创意，挑一个顺眼的就开写</p>
      </div>
      <el-button size="large" text @click="router.push('/')">← 返回书架</el-button>
    </div>

    <div class="card idea-config">
      <el-form label-width="110px" label-position="top">
        <el-form-item label="我的想法（可选）">
          <el-input
            v-model="seedIdea"
            type="textarea"
            :rows="2"
            maxlength="500"
            show-word-limit
            placeholder="想让故事围绕什么展开？一句话即可，如：'一个能听见物品最后一句话的旧货店老板'。留空则由 AI 自由发挥"
          />
        </el-form-item>
        <el-form-item label="市场风向参考（可选）">
          <el-input
            v-model="marketList"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            placeholder="从起点/番茄等平台热门榜复制书单粘贴到这里（每行一本），生成时参考当前热门题材方向与看点形态。仅本地参考，不会抓取平台数据，也不会抄袭任何书名情节"
          />
        </el-form-item>
        <el-form-item label="目标频道">
          <el-radio-group v-model="channel">
            <el-radio-button value="">通用</el-radio-button>
            <el-radio-button value="男频">男频</el-radio-button>
            <el-radio-button value="女频">女频</el-radio-button>
          </el-radio-group>
          <span class="channel-hint">男频侧重成长逆袭主线，女频侧重情感线与女性视角</span>
        </el-form-item>
        <el-form-item label="选择题材（可多选）">
          <el-checkbox-group v-model="genres" class="check-grid">
            <el-checkbox v-for="g in GENRES" :key="g" :value="g" class="check-item">{{ g }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="期望风格基调（可多选）">
          <div class="style-source">
            <span
              v-for="s in PRESET_STYLES"
              :key="s"
              class="style-tag"
              :class="{ active: stylePresets.includes(s) }"
              @click="togglePreset(s)"
            >{{ s }}</span>
          </div>
        </el-form-item>
        <el-form-item v-if="!styleLibsLoading && styleLibrary.length" label="风格库作者文风（可多选）">
          <div class="style-source">
            <span
              v-for="s in styleLibrary"
              :key="s.id"
              class="style-tag"
              :class="{ active: styleIds.includes(s.id) }"
              @click="toggleStyleLib(s.id)"
            >{{ s.name }}</span>
          </div>
        </el-form-item>
        <el-form-item label="定制主角与剧情（可选）">
          <div class="locked-panel">
            <div class="locked-panel-head">
              <span class="locked-panel-title">先定下主角与剧情，AI 就照这个思路出创意；不填则完全自由发挥</span>
              <el-button size="small" text :loading="suggestLoading" @click="fetchSuggestions">
                <el-icon style="margin-right: 4px"><MagicStick /></el-icon>
                {{ suggestReady ? '换一批建议' : 'AI 帮我生成建议' }}
              </el-button>
              <el-button v-if="anyLocked" size="small" text type="danger" @click="clearAllLocked" :disabled="suggestLoading">
                清空全部锁定（{{ lockedCount }}）
              </el-button>
            </div>
            <div class="locked-fields">
              <div v-for="f in LOCK_FIELD_DEFS" :key="f.key" class="locked-field" :class="{ locked: lockedKeys.has(f.key) }">
                <div class="lf-label">
                  <span>{{ f.label }}</span>
                  <span v-if="lockedKeys.has(f.key)" class="lf-lock-tag">已锁定</span>
                  <el-button v-if="lockedKeys.has(f.key)" size="small" text type="danger" class="lf-clear" @click="clearLockedField(f.key)">清除</el-button>
                </div>
                <div v-if="suggestions[f.key]?.length" class="lf-suggest">
                  <span
                    v-for="(s, i) in suggestions[f.key]"
                    :key="i"
                    class="suggest-tag"
                    :class="{ chosen: lockedFields[f.key] === s }"
                    @click="applySuggestion(f.key, s)"
                  >{{ s }}</span>
                </div>
                <el-input
                  v-model="lockedFields[f.key]"
                  :placeholder="f.placeholder"
                  clearable
                  :maxlength="120"
                  :disabled="generating"
                />
              </div>
            </div>
          </div>
        </el-form-item>
         <el-form-item>
           <div class="gen-actions">
             <el-button type="primary" size="large" :loading="generating" @click="generate">
               <el-icon style="margin-right: 6px"><MagicStick /></el-icon>
               {{ generating ? '构思中…' : (ideas.length ? '重新生成（换一批创意）' : '批量生成创意') }}
             </el-button>
             <el-button v-if="historyIdeas.length" size="large" text @click="historyIdeas = []" :disabled="generating">
               清空去重记录（{{ historyIdeas.length }}）
             </el-button>
             <span class="gen-hint">已生成过的会自动避开，直到你满意为止</span>
           </div>
          <div class="count-row">
            <span class="count-label">每批数量</span>
            <el-radio-group v-model="ideaCount" size="small" :disabled="generating">
              <el-radio-button :value="2">2 个</el-radio-button>
              <el-radio-button :value="3">3 个</el-radio-button>
              <el-radio-button :value="4">4 个</el-radio-button>
              <el-radio-button :value="5">5 个</el-radio-button>
              <el-radio-button :value="6">6 个</el-radio-button>
            </el-radio-group>
            <span class="count-hint">数量越多，单个创意的细节越薄</span>
          </div>
          <div v-if="generating" class="idea-progress">
            <el-progress :percentage="99" :stroke-width="6" :show-text="false" :indeterminate="true" :duration="3" />
            <span class="idea-progress-text">{{ statusText || 'AI 正在构思创意…' }}</span>
          </div>
          <div v-else-if="statusText" class="idea-status">{{ statusText }}</div>
        </el-form-item>
      </el-form>
    </div>

    <div v-if="ideas.length" class="idea-list">
      <div class="idea-section-title">为你生成的 {{ ideas.length }} 个创意（点击卡片预览详情）</div>
      <div
        v-for="it in ideas"
        :key="it.id"
        class="idea-card"
        :class="{ selected: selectedId === it.id, expanded: it.expanded }"
        @click="onPickIdea(it)"
      >
        <div class="idea-card-top">
          <span class="idea-genre">{{ it.genre }}</span>
          <span class="idea-title">{{ it.title }}</span>
          <span v-if="it.hook" class="idea-hook-label">钩子</span>
        </div>
        <div class="idea-logline">{{ it.logline }}</div>
        <div class="idea-hook">开篇钩子：{{ it.hook }}</div>
        <div v-if="it.protagonist && (it.protagonist.identity || it.protagonist.golden_finger)" class="idea-meta">
          <span v-if="it.protagonist.identity">{{ it.protagonist.identity }}</span>
          <span v-if="it.protagonist.golden_finger">金手指：{{ it.protagonist.golden_finger }}</span>
        </div>
        <div v-if="honoredLocks(it).length" class="honored-locks">
          <span class="honored-lock-tag" v-for="h in honoredLocks(it)" :key="h">遵循锁定：{{ h }}</span>
        </div>
        <el-button
          text type="primary" size="small"
          class="idea-toggle"
          @click.stop="it.expanded = !it.expanded"
        >{{ it.expanded ? '收起详情' : '查看详情' }}</el-button>
        <div v-if="it.expanded" class="idea-detail">
          <template v-if="it.protagonist">
            <div class="idea-detail-block">
              <div class="idea-detail-title">主角</div>
              <div>{{ it.protagonist.name || '' }}<span v-if="it.protagonist.identity" class="muted">　{{ it.protagonist.identity }}</span></div>
              <div v-if="it.protagonist.golden_finger">金手指：{{ it.protagonist.golden_finger }}</div>
              <div v-if="it.protagonist.personality">性格：{{ it.protagonist.personality }}</div>
            </div>
            <div v-if="it.protagonist2 && it.protagonist2.name" class="idea-detail-block">
              <div class="idea-detail-title">第二主角</div>
              <div>{{ it.protagonist2.name || '' }}<span v-if="it.protagonist2.identity" class="muted">　{{ it.protagonist2.identity }}</span></div>
              <div v-if="it.protagonist2.golden_finger">能力/优势：{{ it.protagonist2.golden_finger }}</div>
              <div v-if="it.protagonist2.personality">性格：{{ it.protagonist2.personality }}</div>
              <div v-if="it.protagonist2.relation">与主角关系：{{ it.protagonist2.relation }}</div>
            </div>
          </template>
          <div v-if="it.selling_point && it.selling_point.length" class="idea-detail-block">
            <div class="idea-detail-title">核心卖点</div>
            <div v-for="(sp, i) in it.selling_point" :key="i">{{ sp }}</div>
          </div>
          <div v-if="it.outline_H5 && it.outline_H5.length" class="idea-detail-block">
            <div class="idea-detail-title">前五章大方向</div>
            <div v-for="(o, i) in it.outline_H5" :key="i" class="outline-line">{{ i + 1 }}. {{ o }}</div>
          </div>
          <div v-if="it.potential_risk" class="idea-detail-block">
            <div class="idea-detail-title">市场风险</div>
            <div class="risk-text">{{ it.potential_risk }}</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="selectedId && ideas.some((it) => it.id === selectedId)" class="fix-bottom-bar">
      <div class="fix-bar-inner">
        <el-button size="large" :loading="creating" type="primary" @click="chooseDirect">
          <el-icon style="margin-right: 6px"><MagicStick /></el-icon>
          就用这个创意，生成创作方案
        </el-button>
        <el-button size="large" plain :loading="creating" @click="chooseAdjust">
          <el-icon style="margin-right: 6px"><EditPen /></el-icon>
          先调整一下再生成
        </el-button>
        <span class="fix-bar-tip">可直接生成，也可先微调标题/剧情再生成创作方案</span>
      </div>
    </div>

    <el-dialog v-model="askOpen" title="开始创作" width="520px" :close-on-click-modal="false">
      <div class="ask-body">
        <div class="ask-title">《{{ selectedIdea?.title || '' }}》</div>
        <div class="ask-desc">{{ selectedIdea?.logline || '' }}</div>
        <div class="ask-hint">确定要基于这个创意生成创作方案吗？生成后 AI 会先规划全本大纲（创作方案），再逐章生成正文。</div>
      </div>
      <template #footer>
        <el-button @click="cancelAsk">再想想</el-button>
        <el-button @click="chooseAdjust">先调整一下</el-button>
        <el-button type="primary" :loading="creating" @click="chooseDirect">直接生成创作方案</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="adjustOpen" title="调整你的创意" width="600px" :close-on-click-modal="false" @close="() => { if (!creating) adjustSaving = false; }">
      <el-form :model="adjustForm" label-width="90px">
        <el-form-item label="作品标题" required>
          <el-input v-model="adjustForm.title" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="题材">
          <el-input v-model="adjustForm.genre" maxlength="10" />
        </el-form-item>
        <el-form-item v-if="adjustForm.protagonistName" label="主角名">
          <el-input v-model="adjustForm.protagonistName" maxlength="20" />
        </el-form-item>
        <el-form-item v-if="adjustForm.goldenFinger" label="金手指">
          <el-input v-model="adjustForm.goldenFinger" maxlength="80" />
        </el-form-item>
        <el-form-item label="剧情设定">
          <el-input
            v-model="adjustForm.concept"
            type="textarea"
            :rows="6"
            placeholder="一句话或一段话描述你的故事设定，生成方案时会以此为基础"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustOpen = false">取消</el-button>
        <el-button type="primary" :loading="adjustSaving" @click="confirmAdjust">
          确认调整并生成创作方案
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.idea-page {
  padding: 28px 32px;
  min-height: 100vh;
  background: #f7f8fc;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  max-width: 1080px;
  margin: 0 auto 20px;
}
.page-title {
  font-size: 24px;
  font-weight: 800;
  color: #1e1b4b;
  margin: 0 0 6px;
}
.page-sub {
  font-size: 13.5px;
  color: #6b7280;
  margin: 0;
}
.card {
  max-width: 1080px;
  margin: 0 auto 20px;
  background: #fff;
  border: 1px solid #eef0f6;
  border-radius: 12px;
  padding: 20px 24px;
}
.idea-config :deep(.el-form-item) {
  margin-bottom: 16px;
}
.check-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 2px;
}
.check-item {
  margin-right: 14px;
  margin-bottom: 4px;
}
.style-source {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.style-tag {
  padding: 4px 12px;
  border: 1px solid #e0e3ef;
  border-radius: 16px;
  font-size: 12.5px;
  color: #4b5563;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}
.style-tag.active {
  background: #4f46e5;
  color: #fff;
  border-color: #4f46e5;
}
.idea-status {
  margin-top: 10px;
  font-size: 13px;
  color: #6b7280;
}
.idea-list {
  max-width: 1080px;
  margin: 0 auto;
}
.idea-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 12px;
}
.idea-card {
  background: #fff;
  border: 1px solid #eef0f6;
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.idea-card:hover {
  border-color: #c7d2fe;
  box-shadow: 0 2px 12px rgba(79, 70, 229, 0.08);
}
.idea-card.selected {
  border-color: #4f46e5;
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
}
.idea-card.selected .idea-title::after {
  content: ' ✓';
  color: #4f46e5;
}
.idea-card-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.idea-genre {
  font-size: 12px;
  color: #4f46e5;
  background: #eef0ff;
  border-radius: 6px;
  padding: 2px 8px;
  font-weight: 600;
}
.idea-title {
  font-size: 17px;
  font-weight: 700;
  color: #1e1b4b;
}
.idea-hook-label {
  font-size: 11px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 6px;
  padding: 2px 6px;
}
.idea-logline {
  font-size: 13.5px;
  color: #374151;
  line-height: 1.7;
  margin-bottom: 6px;
}
.idea-hook {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.6;
  margin-bottom: 6px;
}
.idea-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 12.5px;
  color: #4b5563;
  line-height: 1.5;
  margin-bottom: 6px;
}
.idea-toggle {
  margin-top: 4px;
}
.idea-detail {
  border-top: 1px solid #f1f2f8;
  margin-top: 10px;
  padding-top: 12px;
}
.idea-detail-block {
  margin-bottom: 10px;
}
.idea-detail-title {
  font-size: 13px;
  font-weight: 700;
  color: #1e1b4b;
  margin-bottom: 4px;
}
.muted { color: #6b7280; }
.outline-line { font-size: 13px; color: #4b5563; line-height: 1.6; }
.risk-text { font-size: 13px; color: #b45309; }
.fix-bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  border-top: 1px solid #eef0f6;
  padding: 12px 24px;
  z-index: 20;
  backdrop-filter: blur(6px);
}
.fix-bar-inner {
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
}
.fix-bar-tip { font-size: 13px; color: #6b7280; }
.gen-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}
.gen-hint {
  font-size: 12.5px;
  color: #9ca3af;
}
.count-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.count-label {
  font-size: 13px;
  color: #374151;
}
.count-hint {
  font-size: 12.5px;
  color: #9ca3af;
}
.channel-hint {
  margin-left: 12px;
  font-size: 12.5px;
  color: #9ca3af;
}
.ask-body {
  padding: 4px 6px;
}
.ask-title {
  font-size: 18px;
  font-weight: 700;
  color: #1e1b4b;
  margin-bottom: 8px;
}
.ask-desc {
  font-size: 14px;
  color: #374151;
  line-height: 1.7;
  margin-bottom: 10px;
}
.ask-hint {
  font-size: 13px;
  color: #6b7280;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  padding: 10px 12px;
}
.idea-progress {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 12px;
  width: 100%;
}
.idea-progress-text {
  font-size: 13px;
  color: #6b7280;
}
.locked-panel {
  width: 100%;
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 10px;
  padding: 14px 16px;
}
.locked-panel-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.locked-panel-title {
  font-size: 13px;
  color: #6b7280;
  flex: 1;
  min-width: 220px;
}
.locked-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.locked-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid #eef0f6;
  border-radius: 8px;
  background: #fff;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.locked-field.locked {
  border-color: #6366f1;
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.12);
}
.lf-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
}
.lf-lock-tag {
  font-size: 11px;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.1);
  border-radius: 4px;
  padding: 1px 6px;
}
.lf-clear {
  margin-left: auto;
  padding: 0 4px;
  height: 20px;
}
.lf-suggest {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.suggest-tag {
  padding: 3px 10px;
  border: 1px solid #dbe1f5;
  border-radius: 14px;
  font-size: 12px;
  color: #4b5563;
  cursor: pointer;
  background: #f7f8ff;
  transition: all 0.15s;
}
.suggest-tag:hover {
  border-color: #6366f1;
  color: #6366f1;
}
.suggest-tag.chosen {
  border-color: #6366f1;
  background: #6366f1;
  color: #fff;
}
.honored-locks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.honored-lock-tag {
  font-size: 11px;
  color: #059669;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>