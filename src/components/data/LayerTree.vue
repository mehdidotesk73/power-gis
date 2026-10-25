<script setup lang="ts">
// The layer list: each source layer with its sublayers. Toggles, edit,
// add/remove sublayers, remove a source layer. Edits the specs in place.
import { ref } from 'vue'
import SublayerEditor from './SublayerEditor.vue'
import type { LoadedSource } from './types'
import { AGGREGATIONS } from '../../lib/layers/aggregate'
import { columnLabel, makeScalarSublayer, ROWS, type SublayerSpec } from '../../lib/layers/sourceLayer'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{ sources: LoadedSource[]; dataFor: (src: LoadedSource, sub: SublayerSpec) => LayerData }>()
const emit = defineEmits<{ (e: 'remove-source', id: string): void; (e: 'zoom', id: string): void }>()

const editing = ref<string | null>(null)
const collapsed = ref(new Set<string>())

function toggleCollapsed(id: string) {
  const s = new Set(collapsed.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  collapsed.value = s
}

function summary(sub: SublayerSpec): string {
  if (sub.kind === 'vector') return `arrows · ${sub.u} / ${sub.v}`
  if (sub.column === ROWS) return 'row count'
  return `${columnLabel(sub.column)} · ${AGGREGATIONS[sub.aggregation].toLowerCase()}`
}

function addSublayer(src: LoadedSource) {
  const used = new Set(src.spec.sublayers.map((s) => (s.kind === 'scalar' ? s.column : '')))
  const next = src.built.columns.find((c) => !used.has(c.name))?.name ?? ROWS
  const sub = makeScalarSublayer(src.built, next)
  src.spec.sublayers.push(sub)
  editing.value = sub.id
}

function updateSub(src: LoadedSource, sub: SublayerSpec) {
  const i = src.spec.sublayers.findIndex((s) => s.id === sub.id)
  if (i >= 0) src.spec.sublayers[i] = sub
}

function removeSub(src: LoadedSource, id: string) {
  src.spec.sublayers = src.spec.sublayers.filter((s) => s.id !== id)
  if (editing.value === id) editing.value = null
}

function stats(src: LoadedSource) {
  const n = src.built.base.features.length
  const rows = [...src.built.rowsByKey.values()].reduce((a, r) => a + r.length, 0)
  return `${n.toLocaleString()} ${src.built.geometryKind === 'point' ? 'points' : src.built.geometryKind === 'polyline' ? 'lines' : 'regions'} · ${rows.toLocaleString()} rows`
}
defineExpose({ edit: (id: string) => (editing.value = id) })
void props
</script>

<template>
  <ul class="tree">
    <li v-for="src in sources" :key="src.spec.id" class="src">
      <div class="src-head">
        <button class="caret" :aria-label="collapsed.has(src.spec.id) ? 'Expand' : 'Collapse'" @click="toggleCollapsed(src.spec.id)">
          {{ collapsed.has(src.spec.id) ? '▸' : '▾' }}
        </button>
        <label class="name">
          <input v-model="src.spec.visible" type="checkbox" />
          <span>
            <strong>{{ src.spec.name }}</strong>
            <span class="muted">{{ stats(src) }}</span>
          </span>
        </label>
        <button class="icon" title="Zoom to layer" @click="emit('zoom', src.spec.id)">⤢</button>
        <button class="icon" title="Remove layer" @click="emit('remove-source', src.spec.id)">✕</button>
      </div>
      <p v-if="src.built.unmatched && !collapsed.has(src.spec.id)" class="warn">
        {{ src.built.unmatched.toLocaleString() }} rows had no matching feature (e.g. {{ src.built.unmatchedSamples.slice(0, 3).join(', ') }})
      </p>

      <ul v-if="!collapsed.has(src.spec.id)" class="subs" :class="{ dim: !src.spec.visible }">
        <li v-for="sub in src.spec.sublayers" :key="sub.id" class="sub">
          <div class="sub-head">
            <label class="name">
              <input v-model="sub.visible" type="checkbox" />
              <span>
                {{ sub.name }}
                <span class="muted">{{ summary(sub) }}</span>
              </span>
            </label>
            <button class="edit" :class="{ on: editing === sub.id }" @click="editing = editing === sub.id ? null : sub.id">
              {{ editing === sub.id ? 'Done' : 'Edit' }}
            </button>
          </div>
          <SublayerEditor
            v-if="editing === sub.id"
            :built="src.built"
            :sub="sub"
            :data="dataFor(src, sub)"
            @update="(s) => updateSub(src, s)"
            @remove="removeSub(src, sub.id)"
          />
        </li>
        <li><button class="add-sub" @click="addSublayer(src)">＋ Add sublayer</button></li>
      </ul>
      <p class="origin muted">{{ src.origin }}</p>
    </li>
  </ul>
</template>

<style scoped>
.tree,
.subs {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tree {
  display: grid;
  gap: 0.6rem;
}
.src {
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.4rem 0.5rem;
}
.src-head,
.sub-head {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
}
.name {
  flex: 1;
  display: flex;
  gap: 0.4rem;
  align-items: flex-start;
  min-width: 0;
}
.name > span {
  display: grid;
  min-width: 0;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.caret,
.icon {
  background: none;
  border: none;
  color: var(--text-muted);
  padding: 0 0.2rem;
  font-size: 0.9rem;
}
.subs {
  margin: 0.35rem 0 0 1.3rem;
  display: grid;
  gap: 0.35rem;
}
.subs.dim {
  opacity: 0.55;
}
.sub {
  display: grid;
  gap: 0.4rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px dashed var(--border);
}
.edit {
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.74rem;
}
.edit.on {
  border-color: var(--accent-blue);
}
.add-sub {
  background: none;
  border: none;
  color: var(--accent-blue);
  font-size: 0.8rem;
  padding: 0.1rem 0;
}
.warn {
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  color: #b26a00;
}
.origin {
  margin: 0.3rem 0 0;
}
</style>
