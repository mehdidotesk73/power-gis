<script setup lang="ts">
// Every visualization on the map, from any dataset, in one ordered list (an
// ObjectList). Top of the list draws on top (within its geometry kind). The
// checkbox shows / hides; hold a card (right-click with a mouse) for Edit,
// Zoom to data, Reorder and Delete.
import { computed, ref } from 'vue'
import VisualizationEditor from './VisualizationEditor.vue'
import BindingEditor from './BindingEditor.vue'
import ObjectList, { type ObjectAction } from '../list/ObjectList.vue'
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
  /** Shown under the graph: no add button, hint or empty message. */
  compact?: boolean
}>()
const emit = defineEmits<{
  (e: 'update', v: VisualizationSpec): void
  (e: 'remove', id: string): void
  (e: 'reorder', ids: string[]): void
  (e: 'zoom', id: string): void
  (e: 'cancel-add'): void
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

// ── the hold menu ──────────────────────────────────────────────────────────

const actions = (v: VisualizationSpec): ObjectAction[] => [
  { id: 'edit', icon: '✎', label: editing.value === v.id ? 'Close edit' : 'Edit' },
  { id: 'zoom', icon: '⤢', label: 'Zoom to data', disabled: !props.dataFor(v)?.features.length },
  { id: 'delete', icon: '✕', label: 'Delete', danger: true },
]
function onAction(id: string, v: VisualizationSpec) {
  if (id === 'edit') editing.value = editing.value === v.id ? null : v.id
  else if (id === 'zoom') emit('zoom', v.id)
  else if (id === 'delete') emit('remove', v.id)
}

defineExpose({
  edit: (id: string) => (editing.value = id),
  /** Opens the add form on a dataset (the graph's ＋ Visualization). */
  addFor: (datasetId: string) => {
    pickDataset(datasetId)
    adding.value = true
  },
})
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
        <button class="btn" @click="(adding = false), emit('cancel-add')">Cancel</button>
        <button class="btn primary" :disabled="!addInfo?.features" @click="confirmAdd">Add</button>
      </div>
    </div>
    <button v-else-if="!compact" class="add-btn" :disabled="!datasets.length" @click="openAdd">＋ Add visualization</button>

    <p v-if="!visualizations.length && !compact" class="muted">No visualizations yet.</p>
    <ObjectList
      :items="visualizations"
      :item-key="(v) => v.id"
      :item-label="(v) => v.name"
      :actions="actions"
      reorderable
      reorder-hint="Drag ≡ to reorder · top draws on top"
      :hint="compact ? '' : 'Tap and hold a visualization for options · top draws on top.'"
      @action="onAction"
      @reorder="(ids) => emit('reorder', ids)"
    >
      <template #default="{ item: v }">
        <label class="name">
          <input :checked="v.visible" type="checkbox" @change="emit('update', { ...v, visible: ($event.target as HTMLInputElement).checked })" />
          <span>
            {{ v.name }} <span v-if="v.kind === 'vector'" class="tag">➚</span>
            <span class="muted">{{ dsOf(v)?.name }} · {{ summary(v) }}</span>
          </span>
        </label>
        <template v-if="editing === v.id && dsOf(v)">
          <VisualizationEditor :dataset="dsOf(v)!" :layer="v" :data="dataFor(v)" @update="(n) => emit('update', n)" @remove="emit('remove', v.id)" />
          <button class="close" @click="editing = null">Done</button>
        </template>
      </template>
    </ObjectList>
  </div>
</template>

<style scoped>
.viz {
  display: grid;
  gap: 0.45rem;
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
.close {
  display: block;
  margin: 0.4rem 0 0 auto;
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.78rem;
}
.tag {
  color: var(--accent-blue);
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
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
