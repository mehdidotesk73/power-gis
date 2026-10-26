<script setup lang="ts">
// The workspace as a graph: datasets → transforms → output datasets →
// visualizations, laid out automatically (lib/workspace/dag.ts). Tap a node
// to select it (the page opens it below the graph). ＋ Dataset: the page opens
// the add form below. ＋ Transform: tap the input datasets, then Next.
// ＋ Visualization: tap the dataset to draw. ↓ / → flips the flow (top to
// bottom, left to right), remembered per device.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { vReveal } from '../reveal'
import { edgePath, layoutDag, NODE_H, NODE_W, type Dag, type DagDirection, type DagNode } from '../../lib/workspace/dag'

const props = defineProps<{ dag: Dag; selected: string | null }>()
const emit = defineEmits<{
  (e: 'select', node: DagNode | null): void
  (e: 'new-transform', datasetIds: string[]): void
  (e: 'new-viz', datasetId: string): void
  (e: 'new-dataset'): void
}>()

const DIRECTION = 'powergis.dagDirection'
function readDirection(): DagDirection {
  try {
    return localStorage.getItem(DIRECTION) === 'horizontal' ? 'horizontal' : 'vertical'
  } catch {
    return 'vertical'
  }
}
const direction = ref<DagDirection>(readDirection())
function flip() {
  direction.value = direction.value === 'vertical' ? 'horizontal' : 'vertical'
  try {
    localStorage.setItem(DIRECTION, direction.value)
  } catch {
    /* per-device convenience only */
  }
}

const layout = computed(() => layoutDag(props.dag, direction.value))

// Wider than the screen: open scrolled to the middle of the cross axis (the inputs of most graphs sit there).
const scroller = ref<HTMLElement>()
function center() {
  const el = scroller.value
  if (!el) return
  if (direction.value === 'vertical') el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  else el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
}
onMounted(center)
watch(() => [layout.value.width, layout.value.height, direction.value], () => nextTick(center))

/** One curve per edge, through the points its layout gave it (lib/workspace/dag.ts edgePath). */
const paths = computed(() =>
  props.dag.edges.flatMap((e) => {
    const d = edgePath(layout.value, e)
    if (!d) return []
    const lit = props.selected !== null && (e.from === props.selected || e.to === props.selected)
    return [{ key: `${e.from}>${e.to}`, d, lit }]
  }),
)

// ── picking ────────────────────────────────────────────────────────────────

const mode = ref<'transform' | 'viz' | null>(null)
const picked = ref<string[]>([])
function start(m: 'transform' | 'viz') {
  mode.value = m
  picked.value = []
  emit('select', null)
}
function cancel() {
  mode.value = null
  picked.value = []
}
function next() {
  if (!picked.value.length) return
  emit('new-transform', [...picked.value])
  cancel()
}
const pickNo = (n: DagNode) => picked.value.indexOf(n.id) + 1

function tap(n: DagNode) {
  if (!mode.value) return emit('select', props.selected === n.key ? null : n)
  if (n.kind !== 'dataset') return
  if (mode.value === 'viz') {
    emit('new-viz', n.id)
    return cancel()
  }
  picked.value = pickNo(n) ? picked.value.filter((id) => id !== n.id) : [...picked.value, n.id]
}

const kindLabel = (n: DagNode) => (n.kind === 'dataset' ? 'Dataset' : n.kind === 'transform' ? 'Transform' : 'Viz')
function tag(n: DagNode): string {
  if (mode.value === 'transform' && pickNo(n)) return `✓ Input ${pickNo(n)}`
  if (n.kind === 'transform' && n.state === 'stale') return 'Transform ↻'
  return kindLabel(n)
}
const dimmed = (n: DagNode) => mode.value !== null && n.kind !== 'dataset'
</script>

<template>
  <div v-reveal="mode" class="dag">
    <div v-if="!mode" class="bar">
      <button class="pill dataset" @click="emit('new-dataset')">＋ Dataset</button>
      <button class="pill transform" :disabled="!dag.nodes.some((n) => n.kind === 'dataset')" @click="start('transform')">＋ Transform</button>
      <button class="pill viz" :disabled="!dag.nodes.some((n) => n.kind === 'dataset')" @click="start('viz')">＋ Visualization</button>
      <button
        class="flip"
        :title="direction === 'vertical' ? 'Flowing down — switch to left to right' : 'Flowing right — switch to top to bottom'"
        :aria-label="direction === 'vertical' ? 'Lay out left to right' : 'Lay out top to bottom'"
        @click="flip"
      >
        {{ direction === 'vertical' ? '↓' : '→' }}
      </button>
    </div>
    <div v-else class="banner">
      <span v-if="mode === 'transform'">Tap the datasets this transform reads{{ picked.length ? ` · ${picked.length} picked` : '' }}.</span>
      <span v-else>Tap the dataset to visualize.</span>
      <span class="actions">
        <button class="btn" @click="cancel">Cancel</button>
        <button v-if="mode === 'transform'" class="btn primary" :disabled="!picked.length" @click="next">Next</button>
      </span>
    </div>

    <p v-if="!dag.nodes.length" class="muted">Nothing here yet — start with ＋ Dataset.</p>
    <div v-else ref="scroller" class="scroll">
      <div class="canvas" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }">
        <svg class="edges" :width="layout.width" :height="layout.height" aria-hidden="true">
          <defs>
            <marker id="dag-head" orient="auto" markerWidth="6" markerHeight="6" refX="3" refY="3"><path d="M0 0 L6 3 L0 6 Z" fill="currentColor" /></marker>
          </defs>
          <path v-for="p in paths" :key="p.key" :d="p.d" :class="{ lit: p.lit }" marker-end="url(#dag-head)" />
        </svg>
        <button
          v-for="n in dag.nodes"
          :key="n.key"
          class="node"
          :class="[n.kind, n.state, { selected: selected === n.key, picked: pickNo(n) > 0, dimmed: dimmed(n), muted: n.muted }]"
          :style="{ left: `${layout.at.get(n.key)!.x}px`, top: `${layout.at.get(n.key)!.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
          :aria-pressed="selected === n.key || pickNo(n) > 0"
          :title="`${kindLabel(n)}: ${n.label} — ${n.detail}`"
          @click="tap(n)"
        >
          <span class="tag">{{ tag(n) }}</span>
          <span class="label">{{ n.label }}</span>
          <span class="detail">{{ n.detail }}</span>
        </button>
      </div>
    </div>
    <p v-if="dag.nodes.length && !mode" class="muted hint">Tap a node to open it. Arrows run from inputs to what they make.</p>
  </div>
</template>

<style scoped>
.dag {
  display: grid;
  gap: 0.45rem;
}
.bar,
.banner {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.bar {
  flex-wrap: wrap;
}
.pill {
  min-height: 2rem;
  padding: 0.25rem 0.8rem;
  border: 1px solid var(--pill);
  border-radius: 999px;
  background: color-mix(in srgb, var(--pill) 14%, var(--bg-elev));
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
}
.pill:disabled {
  opacity: 0.45;
}
.pill.dataset {
  --pill: #4c8dff;
}
.pill.transform {
  --pill: #e0962a;
}
.pill.viz {
  --pill: #3faf62;
}
.flip {
  margin-left: auto;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 1rem;
  line-height: 1;
}
.banner {
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.4rem;
  font-size: 0.8rem;
}
.banner .actions {
  display: flex;
  gap: 0.35rem;
  margin-left: auto;
}
.btn {
  min-height: 2.2rem;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.82rem;
}
.btn.primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: #fff;
}
.btn:disabled {
  opacity: 0.5;
}
.scroll {
  overflow: auto;
  max-height: 70vh;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  -webkit-overflow-scrolling: touch;
}
.canvas {
  position: relative;
  margin: 0 auto;
}
.edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  color: var(--text-muted);
}
.edges path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  opacity: 0.6;
}
.edges path.lit {
  stroke: var(--accent-blue);
  opacity: 1;
  stroke-width: 2;
}
.node {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid;
  text-align: center;
  font: inherit;
  color: var(--text);
  overflow: hidden;
  cursor: pointer;
}
/* Kinds differ in label as well as color. */
.node.dataset {
  border-color: #4c8dff;
  background: color-mix(in srgb, #4c8dff 14%, var(--bg));
}
.node.transform {
  border-color: #e0962a;
  background: color-mix(in srgb, #e0962a 16%, var(--bg));
}
.node.transform.not-run {
  border-style: dashed;
}
.node.viz {
  border-color: #3faf62;
  background: color-mix(in srgb, #3faf62 14%, var(--bg));
}
.node.viz.muted {
  opacity: 0.6;
}
.node.selected {
  outline: 2px solid var(--text);
  outline-offset: 1px;
}
.node.picked {
  border-width: 2px;
  border-color: var(--text);
}
.node.dimmed {
  opacity: 0.3;
}
.tag {
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.label {
  font-size: 0.7rem;
  line-height: 1.15;
  font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail {
  font-size: 0.6rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.node.stale .detail,
.node.stale .tag {
  color: #e0962a;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
</style>
