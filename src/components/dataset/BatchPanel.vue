<script setup lang="ts">
// One action over one or several datasets, reviewed first: every line has the
// same choices (Push · Pull · Skip, or Link · Skip), the ones that don't apply
// disabled with the reason under the line. Nothing happens until the go-ahead
// button; then each line says how it went.
import { computed } from 'vue'
import UiButton from '../ui/UiButton.vue'

export interface BatchOption {
  id: string
  label: string
  /** Why it isn't available for this line (the button shows, disabled). */
  disabled?: string
}

export interface BatchItem {
  id: string
  name: string
  /** Where it stands / what the choices would do. */
  note: string
  /** Something to know before choosing (changed in both places): shown in amber. */
  warn?: string
  /** The same options on every line, in the same order; `skip` is one of them. */
  options: BatchOption[]
  /** The chosen option's id. */
  choice: string
  /** While running and after: how it went. */
  status?: 'running' | 'done' | 'failed' | 'skipped'
  result?: string
}

const props = defineProps<{
  title: string
  /** What the panel is for, in a sentence. */
  intro: string
  items: BatchItem[]
  running: boolean
}>()
const emit = defineEmits<{ (e: 'proceed'): void; (e: 'close'): void }>()

const chosen = computed(() => props.items.filter((i) => i.choice !== 'skip').length)
const finished = computed(() => props.items.some((i) => i.status) && !props.running)
/** The options every line shows (from the first line). */
const columns = computed(() => props.items[0]?.options ?? [])
/** Sets every line that can take an option to it. */
const setAll = (id: string) => props.items.forEach((i) => i.options.some((o) => o.id === id && !o.disabled) && (i.choice = id))
const reasons = (it: BatchItem) => it.options.filter((o) => o.disabled).map((o) => `${o.label}: ${o.disabled}`)
</script>

<template>
  <div class="backdrop" @click="!running && emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" :aria-label="title" @click.stop>
      <div class="head">
        <strong>{{ title }}</strong>
        <UiButton icon="✕" aria-label="Close" :disabled="running" @click="emit('close')" />
      </div>
      <p class="intro">{{ intro }}</p>
      <div v-if="!finished && !running && items.length > 1" class="all">
        <button v-for="o in columns" :key="o.id" class="link" @click="setAll(o.id)">{{ o.label }} all</button>
      </div>
      <ul class="items">
        <li v-for="it in items" :key="it.id" :class="{ off: it.choice === 'skip' }">
          <div class="line">
            <span class="name">{{ it.name }}</span>
            <span v-if="it.status" class="status" :class="it.status">
              {{ it.status === 'running' ? 'Working…' : it.status === 'done' ? 'Done' : it.status === 'failed' ? 'Not done' : 'Skipped' }}
            </span>
            <span v-else class="choice" role="group" :aria-label="`${it.name}: choose`">
              <button
                v-for="o in it.options"
                :key="o.id"
                :class="{ on: it.choice === o.id }"
                :disabled="!!o.disabled"
                :title="o.disabled"
                @click="it.choice = o.id"
              >
                {{ o.label }}
              </button>
            </span>
          </div>
          <!-- Before: where it stands, and why a choice is off. After: only how it went. -->
          <span v-if="it.result" class="result" :class="it.status">{{ it.result }}</span>
          <template v-else-if="it.status !== 'skipped'">
            <span class="note">{{ it.note }}</span>
            <span v-if="it.warn" class="warn">{{ it.warn }}</span>
            <span v-for="r in reasons(it)" :key="r" class="reason">{{ r }}</span>
          </template>
        </li>
      </ul>
      <div class="row">
        <template v-if="finished">
          <UiButton tone="primary" @click="emit('close')">Done</UiButton>
        </template>
        <template v-else>
          <UiButton :disabled="running" @click="emit('close')">Cancel</UiButton>
          <UiButton tone="primary" :disabled="running || !chosen" @click="emit('proceed')">
            {{ running ? 'Working…' : `Go ahead (${chosen})` }}
          </UiButton>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--backdrop);
}
.sheet {
  width: min(28rem, 100%);
  max-height: 90dvh;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem 1rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.8rem;
  box-shadow: var(--shadow);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 1.05rem;
}
.intro {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-muted);
  line-height: 1.45;
}
.all {
  display: flex;
  gap: 1rem;
}
.link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent-blue);
  font-size: 0.8rem;
  cursor: pointer;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.items li {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev-2);
}
.items li.off .name,
.items li.off .note {
  opacity: 0.55;
}
.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.choice {
  display: inline-flex;
  flex-shrink: 0;
  border: 1px solid var(--border-strong);
  border-radius: 0.4rem;
  overflow: hidden;
}
.choice button {
  padding: 0.3rem 0.6rem;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 0.78rem;
  cursor: pointer;
}
.choice button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.choice button.on {
  background: var(--accent-blue);
  color: var(--bg);
}
.reason {
  font-size: 0.72rem;
  color: var(--text-muted);
  opacity: 0.85;
}
.note,
.warn,
.blocked,
.result {
  font-size: 0.76rem;
  line-height: 1.4;
}
.note {
  color: var(--text-muted);
}
.warn {
  color: var(--warn);
}
.blocked,
.result.failed,
.status.failed {
  color: var(--danger);
}
.result.done,
.status.done {
  color: var(--ok);
}
.status {
  flex-shrink: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}
.row {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
