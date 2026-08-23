<script setup>
import { ref, onMounted, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { formatDate, readTxtFile } from '../utils/format';

const skills = ref([]);
const loading = ref(false);
const dialogOpen = ref(false);
const detailOpen = ref(false);
const current = ref(null);
const editOpen = ref(false);
const form = ref({ name: '', type: 'technique', description: '', content: '', tags: '' });
const editForm = ref({ name: '', type: 'technique', description: '', content: '', tags: '' });
const filterType = ref('');
const importOpen = ref(false);
const importing = ref(false);
const importResult = ref(null);
const importFileInput = ref(null);

const filteredSkills = computed(() => {
  if (!filterType.value) return skills.value;
  return skills.value.filter((s) => s.type === filterType.value);
});

async function load() {
  loading.value = true;
  try {
    skills.value = await api.listSkills();
  } catch (e) {
    ElMessage.error('加载技能列表失败：' + e.message);
  } finally {
    loading.value = false;
  }
}

function openImport() {
  importOpen.value = true;
  importResult.value = null;
}

function pickImportFiles() {
  importFileInput.value?.click();
}

async function onImportFiles(e) {
  const input = e.target;
  const fileList = Array.from(input.files || []);
  input.value = '';
  if (!fileList.length) return;
  importing.value = true;
  importResult.value = null;
  try {
    const files = [];
    for (const file of fileList) {
      if (!/\.(md|markdown|txt|text)$/i.test(file.name) && file.type !== 'text/plain') {
        ElMessage.warning(`「${file.name}」不是 .md/.txt 文件，已跳过`);
        continue;
      }
      try {
        const content = await readTxtFile(file);
        files.push({ name: file.name, content });
      } catch (err) {
        ElMessage.error(`读取「${file.name}」失败：${err.message}`);
      }
    }
    if (!files.length) return;
    const data = await api.importSkills(files);
    const ok = data?.results || [];
    importResult.value = {
      total: files.length,
      ok: ok.filter((r) => r.ok).length,
      fail: ok.filter((r) => !r.ok).length,
      list: ok
    };
    ElMessage.success(`导入完成：成功 ${importResult.value.ok}，失败 ${importResult.value.fail}`);
    load();
  } catch (e) {
    ElMessage.error(`导入失败：${e.message}`);
  } finally {
    importing.value = false;
  }
}

function openCreate() {
  form.value = { name: '', type: 'technique', description: '', content: '', tags: '' };
  dialogOpen.value = true;
}

async function createSkill() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写技能名称');
  if (!form.value.content.trim()) return ElMessage.warning('请填写技能内容');
  try {
    const skill = await api.createSkill(form.value);
    skills.value.unshift(skill);
    dialogOpen.value = false;
    ElMessage.success('技能创建成功');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function showDetail(s) {
  current.value = s;
  detailOpen.value = true;
}

function openEdit(s) {
  editForm.value = { name: s.name, type: s.type, description: s.description, content: s.content, tags: s.tags };
  editOpen.value = true;
}

async function saveEdit() {
  if (!editForm.value.name.trim()) return ElMessage.warning('名称不能为空');
  if (!editForm.value.content.trim()) return ElMessage.warning('技能内容不能为空');
  try {
    const updated = await api.updateSkill(current.value.id, editForm.value);
    const idx = skills.value.findIndex((x) => x.id === current.value.id);
    if (idx > -1) skills.value[idx] = updated;
    if (current.value?.id === updated.id) current.value = updated;
    editOpen.value = false;
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeSkill(s) {
  try {
    await ElMessageBox.confirm(`确定删除技能「${s.name}」吗？已引用该技能的小说会失去此技能参考。`, '删除技能', { type: 'warning' });
  } catch { return; }
  try {
    await api.deleteSkill(s.id);
    skills.value = skills.value.filter((x) => x.id !== s.id);
    if (current.value?.id === s.id) detailOpen.value = false;
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">技能库</h2>
        <p class="page-sub">创建 AI 写作技能，在创作时让 AI 遵循特定的写作技法或创作流程</p>
      </div>
      <div style="display:flex; gap:10px">
        <el-button size="large" @click="openImport">
          <el-icon style="margin-right:6px"><FolderOpened /></el-icon>导入技能
        </el-button>
        <el-button type="primary" size="large" @click="openCreate">
          <el-icon style="margin-right:6px"><Plus /></el-icon>新建技能
        </el-button>
      </div>
    </div>

    <div class="filter-bar">
      <el-radio-group v-model="filterType" size="small">
        <el-radio-button value="">全部</el-radio-button>
        <el-radio-button value="technique">写作技法</el-radio-button>
        <el-radio-button value="workflow">创作流程</el-radio-button>
      </el-radio-group>
    </div>

    <div v-loading="loading" class="skill-grid" :style="{ minHeight: loading ? '200px' : 'auto' }">
      <el-empty v-if="!loading && !filteredSkills.length" description="技能库为空，创建一个试试">
        <el-button type="primary" @click="openCreate">新建技能</el-button>
      </el-empty>

      <div v-for="s in filteredSkills" :key="s.id" class="skill-card" @click="showDetail(s)">
        <div class="skill-head">
          <div class="skill-icon" :class="s.type">
            <el-icon :size="20"><Lightning v-if="s.type === 'technique'" /><List v-else /></el-icon>
          </div>
          <div class="skill-info">
            <div class="skill-name">{{ s.name }}</div>
            <el-tag :type="s.type === 'technique' ? 'primary' : 'success'" size="small" effect="plain">
              {{ s.type === 'technique' ? '写作技法' : '创作流程' }}
            </el-tag>
          </div>
        </div>
        <div class="skill-desc ellipsis">{{ s.description || '暂无描述' }}</div>
        <div class="skill-foot">
          <span class="skill-time">{{ formatDate(s.updated_at) }}</span>
          <span class="skill-ops" @click.stop>
            <el-icon class="op" @click="openEdit(s)"><Edit /></el-icon>
            <el-icon class="op danger" @click="removeSkill(s)"><Delete /></el-icon>
          </span>
        </div>
      </div>
    </div>

    <!-- 新建弹窗 -->
    <el-dialog v-model="dialogOpen" title="新建技能" width="620px" :close-on-click-modal="false">
      <el-form :model="form" label-width="80px">
        <el-form-item label="技能名称" required>
          <el-input v-model="form.name" maxlength="30" placeholder="如：悬念设置技巧、对话写作技法" />
        </el-form-item>
        <el-form-item label="技能类型">
          <el-radio-group v-model="form.type">
            <el-radio value="technique">写作技法</el-radio>
            <el-radio value="workflow">创作流程</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="简短说明">
          <el-input v-model="form.description" maxlength="200" placeholder="技能用途简要说明" />
        </el-form-item>
        <el-form-item label="技能内容" required>
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            placeholder="编写 AI 执行该技能时应遵循的具体指令，如：\n\n1. 章末必须设置悬念钩子，让读者想知道后续\n2. 悬念应自然融入情节，而非强行插入\n3. 每个悬念在 3 章内应有回应或推进"
          />
          <div class="text-hint">AI 在生成章节时将严格遵循此技能内容。建议用清晰、可执行的步骤描述。</div>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="form.tags" maxlength="100" placeholder="可选：用逗号分隔，如：悬念,剧情,节奏" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!form.name.trim() || !form.content.trim()" @click="createSkill">
          <el-icon style="margin-right:4px"><MagicStick /></el-icon>创建技能
        </el-button>
      </template>
    </el-dialog>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailOpen" size="560px" :title="current?.name">
      <div v-if="current" class="detail-body">
        <el-tag :type="current.type === 'technique' ? 'primary' : 'success'" effect="plain" size="small">
          {{ current.type === 'technique' ? '写作技法' : '创作流程' }}
        </el-tag>
        <el-tag v-if="current.tags" effect="plain" type="info" size="small" style="margin-left:8px">
          {{ current.tags }}
        </el-tag>
        <div v-if="current.description" class="field">
          <div class="field-label">说明</div>
          <div class="field-text">{{ current.description }}</div>
        </div>
        <div class="field">
          <div class="field-label">技能内容</div>
          <div class="field-text content-text">{{ current.content }}</div>
        </div>
        <div class="field">
          <div class="field-label">使用次数</div>
          <div class="field-text">{{ current.usage_count || 0 }} 次</div>
        </div>
        <div class="detail-ops">
          <el-button size="small" @click="openEdit(current)"><el-icon style="margin-right:4px"><Edit /></el-icon>编辑</el-button>
          <el-button size="small" type="danger" plain @click="removeSkill(current)"><el-icon style="margin-right:4px"><Delete /></el-icon>删除</el-button>
        </div>
      </div>
    </el-drawer>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editOpen" title="编辑技能" width="560px">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="editForm.name" maxlength="30" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="editForm.type">
            <el-radio value="technique">写作技法</el-radio>
            <el-radio value="workflow">创作流程</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="editForm.description" maxlength="200" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="editForm.content" type="textarea" :rows="6" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editForm.tags" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 导入技能弹窗 -->
    <el-dialog v-model="importOpen" title="导入技能" width="620px" :close-on-click-modal="false">
      <div class="import-tip">
        <p>支持导入 SKILL.md 格式的技能文件（YAML frontmatter 中 <code>name</code>/<code>description</code> + 正文），可一次选择多个 .md 文件。文件顶部带有 <code>---</code> 分隔的 frontmatter 时，会解析其中的名称与说明。</p>
      </div>
      <input
        ref="importFileInput"
        type="file"
        multiple
        accept=".md,.markdown,.txt,text/plain,text/markdown"
        style="display:none"
        @change="onImportFiles"
      />
      <div class="import-drop" @click="pickImportFiles" :class="{ disabled: importing }">
        <el-icon :size="34" color="#9ca3af"><UploadFilled /></el-icon>
        <div class="upload-text">点击选择 .md 技能文件（可多选）</div>
      </div>
      <div v-if="importing" class="text-hint" style="margin-top:10px">
        <el-icon class="is-loading"><Loading /></el-icon> 正在解析并导入…
      </div>
      <div v-if="importResult" class="import-result">
        <div class="import-summary">
          共 {{ importResult.total }} 个文件：导入成功 {{ importResult.ok }}，失败 {{ importResult.fail }}
        </div>
        <ul v-if="importResult.list.length" class="import-list">
          <li v-for="(r, i) in importResult.list" :key="i">
            <span class="ir-name">{{ r.name }}</span>
            <el-tag v-if="r.ok" :type="r.updated ? 'warning' : 'success'" size="small" effect="plain">
              {{ r.updated ? '已更新' : '已导入' }}
            </el-tag>
            <el-tag v-else type="danger" size="small" effect="plain">失败</el-tag>
            <span v-if="!r.ok && r.error" class="ir-err">{{ r.error }}</span>
          </li>
        </ul>
      </div>
      <template #footer>
        <el-button @click="importOpen = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.page-title { margin: 0; font-size: 24px; font-weight: 700; }
.page-sub { margin: 6px 0 0; color: #6b7280; font-size: 13px; }
.filter-bar { margin-bottom: 16px; }
.skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.skill-card {
  background: #fff;
  border-radius: 12px;
  padding: 18px;
  box-shadow: 0 1px 3px rgba(20,24,80,.08);
  cursor: pointer;
  transition: transform .15s, box-shadow .15s;
}
.skill-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(20,24,80,.1); }
.skill-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.skill-icon {
  width: 36px; height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.skill-icon.technique { background: linear-gradient(135deg, #eef0ff, #e0e7ff); color: #4f46e5; }
.skill-icon.workflow { background: linear-gradient(135deg, #ecfdf5, #d1fae5); color: #059669; }
.skill-info { display: flex; align-items: center; gap: 8px; min-width: 0; }
.skill-name { font-size: 15px; font-weight: 700; color: #1e1b4b; }
.skill-desc { font-size: 12.5px; color: #6b7280; line-height: 1.7; min-height: 40px; }
.skill-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f3f4f8; }
.skill-time { font-size: 11px; color: #9ca3af; }
.skill-ops { display: flex; gap: 10px; color: #9ca3af; }
.skill-ops .op:hover { color: #4f46e5; }
.skill-ops .op.danger:hover { color: #ef4444; }
.text-hint { font-size: 11px; color: #9ca3af; margin-top: 6px; }
.detail-body { padding: 4px 2px; }
.field { margin-bottom: 16px; }
.field-label { font-size: 12px; color: #4f46e5; font-weight: 700; margin-bottom: 4px; }
.field-text { font-size: 13.5px; color: #374151; line-height: 1.8; white-space: pre-wrap; }
.content-text { background: #fafbff; border-radius: 8px; padding: 12px; border: 1px solid #eef0f6; font-size: 13px; line-height: 1.8; }
.detail-ops { margin-top: 18px; display: flex; gap: 10px; }
.import-tip { font-size: 12.5px; color: #6b7280; line-height: 1.8; margin-bottom: 16px; }
.import-tip code { background: #f3f4f8; border-radius: 4px; padding: 1px 5px; font-size: 12px; color: #4f46e5; }
.import-drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; padding: 32px 16px; border: 1.5px dashed #c7cbe0; border-radius: 12px;
  cursor: pointer; transition: border-color .15s, background .15s;
}
.import-drop:hover { border-color: #4f46e5; background: #fafbff; }
.import-drop.disabled { opacity: .5; cursor: not-allowed; }
.import-result { margin-top: 16px; }
.import-summary { font-size: 13px; font-weight: 700; color: #1e1b4b; margin-bottom: 8px; }
.import-list { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; border: 1px solid #eef0f6; border-radius: 8px; }
.import-list li { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #f3f4f8; font-size: 13px; }
.import-list li:last-child { border-bottom: none; }
.ir-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ir-err { color: #ef4444; font-size: 12px; }
</style>