<script setup lang="ts">
import { computed } from 'vue'
import RichText from './RichText.vue'

/** 单选题 / 猜结果共用的答题反馈卡片，保证两种题的交互与视觉一致。 */
interface Answer { label: string; text: string }
const props = withDefaults(defineProps<{
  ok: boolean
  answers: Answer[]
  explain?: string
  output?: string
  mode?: 'quiz' | 'predict'
}>(), { mode: 'quiz' })

function pretty(s?: string) { return (s || '').replace(/\\n/g, '\n') }
const labels = () => props.answers.map((a) => a.label).join('、')
/** 有些 Predict 把 output 写成了正确选项文本，避免与答案区重复展示 */
const showOutput = computed(() => {
  const o = pretty(props.output).trim()
  return !!o && !props.answers.some((a) => a.text.trim() === o)
})
</script>

<template>
  <div class="wl-review" :class="ok ? 'ok' : 'no'">
    <div class="wl-review-head">
      <b>{{ ok ? '✓ 答对了！' : '✗ 再想想～' }}</b>
      <span v-if="!ok">{{ mode === 'predict' ? '结果是' : '正确选项' }}：{{ labels() }}</span>
    </div>

    <div class="wl-review-answer">
      <span class="wl-review-tag">答案</span>
      <div class="wl-review-answer-list">
        <div v-for="(a, i) in answers" :key="i" class="wl-review-answer-row">
          <b>{{ a.label }}</b><span>{{ a.text }}</span>
        </div>
      </div>
    </div>

    <div v-if="showOutput" class="wl-review-output">
      <span class="wl-review-tag muted">运行输出</span>
      <pre>{{ pretty(output) }}</pre>
    </div>

    <div v-if="explain" class="wl-review-explain">
      <span class="wl-review-tag muted">解析</span>
      <p><RichText :text="explain" /></p>
    </div>
  </div>
</template>
