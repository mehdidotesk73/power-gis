<script setup lang="ts">
// Every visualization on the map, from any dataset, in one ordered list.
// Top of the list draws on top (within its geometry kind). Drag the ≡ handle
// to reorder; swipe a row left to reveal Delete. Pointer events, not HTML5
// drag-and-drop, so both work on phones.
import { computed, ref } from 'vue'
import VisualizationEditor from './VisualizationEditor.vue'
import BindingEditor from './BindingEditor.vue'
import { useDragReorder } from './useDragReorder'
import { useBindingInfo } from './useBindingInfo'
import { AGGREGATIONS } from '../../lib/dataset/aggregate'
import { bindingColumns, guessBinding, type GeometryBinding } from '../../lib/dataset/binding'
import { columnLabel, dataColumns, ROWS, type VisualizationSpec } from '../../lib/dataset/visualization'
import type { DatasetRecord } from '../../shared/records'
import type { LayerData } from '../../lib/schema'

const props = defineProps<{
  visualizations: VisualizationSpec[]
  datasets: DatasetRecord[]
  dataFor: (v: VisualizationSpec) => LayerData | null
}>()
const emit = defineEmits<{
  (e: 'update', v: VisualizationSpec): void
  (e: 'remove', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'add', datasetId: string, binding: GeometryBinding, column: string): void
}>()

const editing = ref<string | null>(null)
const dsOf = (v: VisualizationSpec) => props.datasets.find((d) => d.id === v.datasetId)

function summary(v: VisualizationSpec): string {
  const what = v.column === ROWS ? 'row count' : `${columnLabel(v.column)} · ${AGGREGATIONS[v.aggregation].toLowerCase()}`
  return v.kind === 'vector' ? `arrows · ${what}` : what
}

// ── add ────────────────────────────────────────────────────────────────────

const adding = ref(false)
const addDataset = ref('')
const addColumn = ref(ROWS)
const addBinding = ref<GeometryBinding | null>(null)
const addRecord = computed(() => props.datasets.find((d) => d.id === addDataset.value))
const addColumns = computed(() => (addRecord.value && addBinding.value ? dataColumns(addRecord.value.columns, addBinding.value) : []))
const { info: addInfo, error: addError } = useBindingInfo(
  () => (adding.value ? addDataset.value : undefined),
  () => addBinding.value,
)

/** The binding a dataset's other visualizations use, else a guess from its columns. */
function bindingFor(d: DatasetRecord): GeometryBinding {
  const used = props.visualizations.find((v) => v.datasetId === d.id)?.binding
  return used ?? guessBinding(d.columns) ?? { kind: 'geometry', column: '' } // nothing to draw on: the editor says so
}
function pickDataset(id: string) {
  addDataset.value = id
  const d = props.datasets.find((x) => x.id === id)
  addBinding.value = d ? bindingFor(d) : null
  addColumn.value = ROWS
}
function setAddBinding(b: GeometryBinding) {
  addBinding.value = b
  if (bindingColumns(b).includes(addColumn.value)) addColumn.value = ROWS
}
function openAdd() {
  pickDataset(props.datasets[0]?.id ?? '')
  adding.value = true
}
function confirmAdd() {
  if (!addDataset.value || !addBinding.value) return
  emit('add', addDataset.value, addBinding.value, addColumn.value)
  adding.value = false
}

// ── drag to reorder ────────────────────────────────────────────────────────

const listEl = ref<HTMLElement>()
const { dragging, onHandleDown, onHandleMove, onHandleUp } = useDragReorder(
  listEl,
  () => props.visualizations.map((v) => v.id),
  (ids) => emit('reorder', ids),
  () => closeSwipe(),
)

// ── swipe to delete ────────────────────────────────────────────────────────

const REVEAL = 84
const swiped = ref<string | null>(null)
const offset = ref(0)
let swipe: { id: string; x: number; y: number; base: number; active: boolean } | null = null

// A swipe can start anywhere on the row (even on Edit or the name), so the
// click that would follow it is swallowed — it was a swipe, not a tap.
let suppressClick = false
function onRowClickCapture(e: MouseEvent) {
  if (!suppressClick) return
  suppressClick = false
  e.stopPropagation()
  e.preventDefault()
}

function onRowDown(e: PointerEvent, id: string) {
  if (dragging.value || (e.target as HTMLElement).closest('select, input[type=text], .no-swipe')) return
  swipe = { id, x: e.clientX, y: e.clientY, base: swiped.value === id ? -REVEAL : 0, active: false }
}
function onRowMove(e: PointerEvent) {
  if (!swipe) return
  const dx = e.clientX - swipe.x
  const dy = e.clientY - swipe.y
  if (!swipe.active) {
    if (Math.abs(dy) > 10) return void (swipe = null) // a vertical scroll, not a swipe
    if (Math.abs(dx) < 10) return
    swipe.active = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (swiped.value !== swipe.id) swiped.value = swipe.id
  }
  offset.value = Math.max(-REVEAL - 20, Math.min(0, swipe.base + dx))
}
function onRowUp() {
  if (swipe?.active) {
    suppressClick = true
    setTimeout(() => (suppressClick = false), 0)
    if (offset.value < -REVEAL / 2) offset.value = -REVEAL
    else closeSwipe()
  }
  swipe = null
}
function closeSwipe() {
  swiped.value = null
  offset.value = 0
}
const shiftFor = (id: string) => (swiped.value === id ? offset.value : 0)

defineExpose({ edit: (id: string) => (editing.value = id) })
</script>

<template>
  <div class="viz">
    <div v-if="adding" class="add-form">
      <label class="row">
        Dataset
        <select :value="addDataset" @change="pickDataset(($event.target as HTMLSelectElement).value)">
          <option v-for="d in datasets" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </label>
      <BindingEditor v-if="addRecord && addBinding" :columns="addRecord.columns" :model-value="addBinding" :info="addInfo" :error="addError" @update:model-value="setAddBinding" />
      <label class="row">
        Column
        <select v-model="addColumn">
          <option :value="ROWS">Number of rows</option>
          <option v-for="c in addColumns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
        </select>
      </label>
      <div class="row end">
        <button class="btn" @click="adding = false">Cancel</button>
        <button class="btn primary" :disabled="!addInfo?.features" @click="confirmAdd">Add</button>
      </div>
    </div>
    <button v-else class="add-btn" :disabled="!datasets.length" @click="openAdd">＋ Add visualization</button>

    <p v-if="!visualizations.length" class="muted">No visualizations yet.</p>
    <ul ref="listEl" class="list">
      <li v-for="v in visualizations" :key="v.id" :data-id="v.id" class="item" :class="{ dragging: dragging === v.id }">
        <div class="swipe-wrap">
          <button class="delete" tabindex="-1" @click="(emit('remove', v.id), closeSwipe())">Delete</button>
          <div
            class="row-content"
            :style="{ transform: `translateX(${shiftFor(v.id)}px)`, transition: swiped === v.id && offset !== -REVEAL && offset !== 0 ? 'none' : '' }"
            @pointerdown="onRowDown($event, v.id)"
            @pointermove="onRowMove"
            @pointerup="onRowUp"
            @pointercancel="onRowUp"
            @click.capture="onRowClickCapture"
          >
            <span
              class="handle no-swipe"
              aria-label="Drag to reorder"
              title="Drag to reorder"
              @pointerdown="onHandleDown($event, v.id)"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
              >≡</span
            >
            <label class="name">
              <input :checked="v.visible" type="checkbox" @change="emit('update', { ...v, visible: ($event.target as HTMLInputElement).checked })" />
              <span>
                {{ v.name }} <span v-if="v.kind === 'vector'" class="tag">➚</span>
                <span class="muted">{{ dsOf(v)?.name }} · {{ summary(v) }}</span>
              </span>
            </label>
            <button class="edit" :class="{ on: editing === v.id }" @click="editing = editing === v.id ? null : v.id">
              {{ editing === v.id ? 'Done' : 'Edit' }}
            </button>
          </div>
        </div>
        <VisualizationEditor
          v-if="editing === v.id && dsOf(v)"
          :dataset="dsOf(v)!"
          :layer="v"
          :data="dataFor(v)"
          @update="(n) => emit('update', n)"
          @remove="emit('remove', v.id)"
        />
      </li>
    </ul>
    <p v-if="visualizations.length > 1" class="muted hint">Drag ≡ to reorder (top draws on top) · swipe left to delete</p>
  </div>
</template>

<style scoped>
.viz {
  display: grid;
  gap: 0.45rem;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.35rem;
}
.item {
  display: grid;
  gap: 0.4rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px dashed var(--border);
}
.item.dragging {
  opacity: 0.7;
}
.item.dragging .row-content {
  outline: 1px solid var(--accent-blue);
  border-radius: 0.3rem;
}
.swipe-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 0.3rem;
}
.delete {
  position: absolute;
  inset: 0 0 0 auto;
  width: 84px;
  border: none;
  background: var(--danger);
  color: #fff;
  font-weight: 600;
  font-size: 0.8rem;
}
.row-content {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
  background: var(--bg);
  touch-action: pan-y; /* vertical scroll stays native; horizontal is our swipe */
  transition: transform 0.18s ease;
}
.handle {
  cursor: grab;
  touch-action: none;
  user-select: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  line-height: 1.2;
  padding: 0 0.3rem;
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
.tag {
  color: var(--accent-blue);
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
.hint {
  margin-top: 0.1rem;
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
.add-btn {
  width: 100%;
  padding: 0.45rem;
  border: 1px dashed var(--accent-blue);
  border-radius: 0.4rem;
  background: none;
  color: var(--accent-blue);
  font-size: 0.85rem;
}
.add-btn:disabled {
  opacity: 0.5;
}
.add-form {
  display: grid;
  gap: 0.4rem;
  padding: 0.45rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.4rem;
  font-size: 0.82rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row.end {
  justify-content: flex-end;
}
.row select {
  min-width: 0;
  flex: 1;
  max-width: 13rem;
  padding: 0.3rem;
  font-size: 0.85rem;
}
.btn {
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.8rem;
}
.btn.primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: #fff;
}
</style>
