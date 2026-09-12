<template>
  <el-dialog
    title="批量生成章节"
    :model-value="props.visible"
    @update:modelValue="emit('update:visible', $event)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    destroy-on-close
    width="420px"
  >
    <div v-if="!busy" class="batch-form">
      <el-radio-group v-model="mode">
        <el-radio value="count">生成指定章节数</el-radio>
        <el-radio value="all"
          >生成全本（剩余 {{ target - written }} 章）</el-radio
        >
      </el-radio-group>
      <el-input-number
        v-if="mode === 'count'"
        v-model="count"
        :min="1"
        :max="999"
        :step="1"
        precision="0"
        placeholder="章节数"
        class="count-input"
      />
    </div>

    <div v-else class="batch-running">
      <el-progress
        :percentage="(done / total) * 100"
        :stroke-width="18"
        color="#7c3aed"
      >
        <template #default>
          <span>
            第 {{ done + (stopped ? 0 : 1) }}/{{ total }} 章{{
              done ? `（已完成 ${done} 章）` : '……'
            }}
          </span>
        </template>
      </el-progress>
      <div v-if="errors.length" class="err-tips">
        停止于第 {{ errors[0].chapter }} 章：{{ errors[0].msg }}
      </div>
    </div>

    <template #footer>
      <el-button :disabled="busy" @click="emit('update:visible', false)"
        >取 消</el-button
      >
      <el-button
        v-if="!busy"
        type="primary"
        :disabled="!canStart"
        @click="doBatch"
        >开 始</el-button
      >
      <el-button v-if="busy" type="danger" @click="abortAll"
        >停 止</el-button
      >
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';

const props = defineProps({
  visible: { type: Boolean, default: false },
});
const emit = defineEmits(['update:visible']);
const store = useEditorStore();

const mode = ref('count');
const count = ref(5);
const busy = ref(false);
const total = ref(0);
const done = ref(0);
const errors = ref([]);
const stopped = ref(false);

const target = computed(() => Number(store.novel?.target_chapters) || 0);
const written = computed(() =>
  store.chapters.filter((c) => c.word_count > 0).length
);
const canStart = computed(() =>
  mode.value === 'all' ? target.value > written.value : count.value > 0
);

function doBatch() {
  errors.value = [];
  const n = mode.value === 'all' ? target.value - written.value : count.value;
  if (!n || n <= 0) {
    ElMessage.warning('没有需要生成的章节');
    return;
  }
  total.value = n;
  done.value = 0;
  busy.value = true;
  stopped.value = false;

  (async () => {
    for (let i = 0; i < n; i++) {
      if (stopped.value) break;
      try {
        await store.generateChapter({ mode: 'next' });
        done.value++;
      } catch (e) {
        errors.value.push({
          chapter: done.value + 1,
          msg: e.message || '生成失败',
        });
        ElMessage.error(
          `第 ${done.value + 1} 章失败，已停止：${e.message || ''}`
        );
        break;
      }
    }
    busy.value = false;
    if (!errors.value.length && !stopped.value) {
      ElMessage.success(`批量生成完成，共生成 ${done.value} 章`);
      emit('update:visible', false);
    }
    if (stopped.value && !errors.value.length) {
      ElMessage.info('批量生成已停止');
    }
  })();
}

function abortAll() {
  stopped.value = true;
  try {
    store.stop();
  } catch {}
}
</script>

<style scoped>
.batch-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.count-input {
  width: 100%;
}
.batch-running {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: stretch;
}
.err-tips {
  color: #ef4444;
  font-size: 13px;
}
</style>
