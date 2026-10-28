<script setup lang="ts">
// One action over several datasets, reviewed first: each dataset with what will
// happen to it (and anything to know first, like a newer version in the cloud),
// Continue or Skip for each, then Proceed. While it runs, and after, each line
// says how it went. Nothing happens until Proceed.
import { computed } from 'vue'
import UiButton from '../ui/UiButton.vue'

export interface BatchItem {
  id: string
  name: string
  /** What will happen to it. */
  note: string
  /** Something to know before going ahead (a conflict): shown in amber. */
  warn?: string
  /** It can't be done (shown in red, always skipped). */
  blocked?: string
  /** Continue (true) or Skip (false). */
  go: boolean
  /** While running and after: how it went. */
  status?: 'running' | 'done' | 'failed' | 'skipped'
  result?: string
}

const props = defineProps<{
  title: string
  /** What the action does, in a sentence. */
  intro: string
  items: BatchItem[]
  /** Proceed's label (e.g. "Store 3 in the cloud"); {n} is the count. */
  verb: string
  running: boolean
}>()
const emit = defineEmits<{ (e: 'proceed'): void; (e: 'close'): void }>()

const chosen = computed(() => props.items.filter((i) => i.go && !i.blocked).length)
const finished = computed(() => props.items.some((i) => i.status) && !props.running)
const set = (go: boolean) => props.items.forEach((i) => !i.blocked && (i.go = go))
</script>

<template>
  <div class="backdrop" @click="!running && emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" :aria-label="title" @click.stop>
      <div class="head">
        <strong>{{ title }}</strong>
        <UiButton icon="✕" aria-label="Close" :disabled="running" @click="emit('close')" />
      </div>
      <p class="intro">{{ intro }}</p>
      <div v-if="!finished && !running" class="all">
        <button class="link" @click="set(true)">Continue all</button>
        <button class="link" @click="set(false)">Skip all</button>
      </div>
      <ul class="items">
        <li v-for="it in items" :key="it.id" :class="{ off: !it.go || it.blocked }">
          <div class="line">
            <span class="name">{{ it.name }}</span>
            <span v-if="it.status" class="status" :class="it.status">
              {{ it.status === 'running' ? '…' : it.status === 'done' ? '✓' : it.status === 'failed' ? '✗' : 'Skipped' }}
            </span>
            <span v-else-if="!it.blocked" class="choice" role="group" :aria-label="`${it.name}: continue or skip`">
              <button :class="{ on: it.go }" @click="it.go = true">Continue</button>
              <button :class="{ on: !it.go }" @click="it.go = false">Skip</button>
            </span>
          </div>
          <span class="note">{{ it.note }}</span>
          <span v-if="it.warn" class="warn">⚠ {{ it.warn }}</span>
          <span v-if="it.blocked" class="blocked">{{ it.blocked }}</span>
          <span v-if="it.result" class="result" :class="it.status">{{ it.result }}</span>
        </li>
      </ul>
      <div class="row">
        <template v-if="finished">
          <UiButton tone="primary" @click="emit('close')">Done</UiButton>
        </template>
        <template v-else>
          <UiButton :disabled="running" @click="emit('close')">Cancel</UiButton>
          <UiButton tone="primary" :disabled="running || !chosen" @click="emit('proceed')">
            {{ running ? 'Working…' : verb.replace('{n}', String(chosen)) }}
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
.choice button.on {
  background: var(--accent-blue);
  color: var(--bg);
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
