<script setup lang="ts">
// The workspace as a graph: datasets → transforms → output datasets →
// visualizations, laid out automatically (lib/workspace/dag.ts). Tap a node
// to select it (the page opens it below the graph). ＋ Dataset: the page opens
// the add form below. ＋ Transform: tap the input datasets, then Next.
// ＋ Visualization: tap the dataset to draw. ↓ / → flips the flow (top to
// bottom, left to right), remembered per device. The graph pans and zooms
// (usePanZoom): drag / Shift + wheel / pinch; on phones hold, then drag.
import UiButton from '../ui/UiButton.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { vReveal } from '../reveal'
import { usePanZoom } from './usePanZoom'
import { edgePath, layoutDag, NODE_H, NODE_W, type Dag, type DagDirection, type DagNode } from '../../lib/workspace/dag'

const props = defineProps<{
  dag: Dag
  selected: string | null
  /** How many transforms "Run all stale" would run (0 hides it). */
  staleCount?: number
  /** While running, "Running 2 of 3 · …"; then the outcome. */
  staleProgress?: { running: boolean; text: string } | null
}>()
const emit = defineEmits<{
  (e: 'select', node: DagNode | null): void
  (e: 'new-transform', datasetIds: string[]): void
  (e: 'new-viz', datasetId: string): void
  (e: 'new-dataset'): void
  (e: 'run-stale'): void
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

// The graph sits in a fixed viewport and pans / zooms; it opens fitted (never
// enlarged), and refits when its size or direction changes.
const viewport = ref<HTMLElement>()
const { view, panning, fit, zoomBy } = usePanZoom(viewport, () => ({ w: layout.value.width, h: layout.value.height }))
/** Viewport height: the graph's height at the zoom that fits its width (the CSS max-height caps it). */
const viewportH = ref(240)
function refit() {
  const el = viewport.value
  if (!el) return
  const kw = Math.min(1, (el.clientWidth - 16) / (layout.value.width || 1))
  viewportH.value = Math.max(160, Math.round(layout.value.height * kw + 16))
  nextTick(fit)
}
onMounted(() => {
  refit()
  // The box changes width without the graph changing (splitter, pop-out window): refit to use it.
  let lastW = viewport.value?.clientWidth ?? 0
  resizer = new ResizeObserver(() => {
    const w = viewport.value?.clientWidth ?? 0
    if (w && Math.abs(w - lastW) > 1) refit()
    lastW = w
  })
  if (viewport.value) resizer.observe(viewport.value)
})
let resizer: ResizeObserver | null = null
onBeforeUnmount(() => resizer?.disconnect())
watch(() => [layout.value.width, layout.value.height, direction.value, props.dag.nodes.length > 0], () => nextTick(refit))
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

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
  return kindLabel(n)
}
const dimmed = (n: DagNode) => mode.value !== null && n.kind !== 'dataset'
</script>

<template>
  <div v-reveal="mode" class="dag">
    <div v-if="!mode" class="bar">
      <UiButton data-testid="graph.add-dataset" size="tag" tone="dataset" icon="＋" @click="emit('new-dataset')">Dataset</UiButton>
      <UiButton data-testid="graph.add-transform" size="tag" tone="transform" icon="＋" :disabled="!dag.nodes.some((n) => n.kind === 'dataset')" @click="start('transform')">Transform</UiButton>
      <UiButton size="tag" tone="viz" icon="＋" :disabled="!dag.nodes.some((n) => n.kind === 'dataset')" @click="start('viz')">Visualization</UiButton>
      <UiButton
        v-if="staleCount && !staleProgress?.running"
        data-testid="run-all-stale"
        size="tag"
        tone="attention"
        icon="↻"
        title="Re-run every transform marked ↻, and what depends on them, in order"
        @click="emit('run-stale')"
      >
        Run all stale ({{ staleCount }})
      </UiButton>
      <button
        class="flip"
        :title="direction === 'vertical' ? 'Flowing down — switch to left to right' : 'Flowing right — switch to top to bottom'"
        :aria-label="direction === 'vertical' ? 'Lay out left to right' : 'Lay out top to bottom'"
        @click="flip"
      >
        {{ direction === 'vertical' ? '↓' : '→' }}
      </button>
    </div>
    <p v-if="!mode && staleProgress" class="stale-msg" role="status">{{ staleProgress.text }}</p>
    <div v-else-if="mode" class="banner">
      <span v-if="mode === 'transform'">Tap the datasets this transform reads{{ picked.length ? ` · ${picked.length} picked` : '' }}.</span>
      <span v-else>Tap the dataset to visualize.</span>
      <span class="actions">
        <button class="btn" @click="cancel">Cancel</button>
        <button v-if="mode === 'transform'" data-testid="graph.next" class="btn primary" :disabled="!picked.length" @click="next">Next</button>
      </span>
    </div>

    <p v-if="!dag.nodes.length" class="muted">Nothing here yet — start with ＋ Dataset.</p>
    <div v-show="dag.nodes.length" ref="viewport" class="scroll" :class="{ panning }" :style="{ height: `${viewportH}px` }">
      <div
        class="canvas"
        :style="{ width: `${layout.width}px`, height: `${layout.height}px`, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }"
      >
        <svg class="edges" :width="layout.width" :height="layout.height" aria-hidden="true">
          <defs>
            <marker id="dag-head" orient="auto" markerWidth="6" markerHeight="6" refX="3" refY="3"><path d="M0 0 L6 3 L0 6 Z" fill="currentColor" /></marker>
            <marker id="dag-head-lit" orient="auto" markerWidth="6" markerHeight="6" refX="3" refY="3"><path d="M0 0 L6 3 L0 6 Z" style="fill: var(--accent-blue)" /></marker>
          </defs>
          <path v-for="p in paths" :key="p.key" :d="p.d" :class="{ lit: p.lit }" :marker-end="p.lit ? 'url(#dag-head-lit)' : 'url(#dag-head)'" />
        </svg>
        <button
          v-for="n in dag.nodes"
          :key="n.key"
          :data-testid="`node.${n.kind}`"
          :data-name="n.label"
          :data-problem="n.problem || undefined"
          class="node"
          :class="[n.kind, n.state, n.problem, { selected: selected === n.key, picked: pickNo(n) > 0, dimmed: dimmed(n), muted: n.muted }]"
          :style="{ left: `${layout.at.get(n.key)!.x}px`, top: `${layout.at.get(n.key)!.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
          :aria-pressed="selected === n.key || pickNo(n) > 0"
          :title="`${kindLabel(n)}: ${n.label} — ${n.detail}`"
          @click="tap(n)"
        >
          <span v-if="n.problem === 'missing'" class="badge problem-badge" aria-label="Missing on this device">⚠</span>
          <span v-else-if="n.kind === 'transform' && n.state === 'stale' && !n.problem" class="badge" aria-label="Needs re-run">↻</span>
          <span class="tag">
            <span
              v-if="n.kind === 'dataset'"
              class="store-dot"
              :class="[n.store, { pending: n.pending }]"
              :title="`${n.store === 'remote' ? 'In the cloud' : 'On this device'}${n.pending ? ' · out of date or not made yet: run its transform' : ''}`"
              aria-hidden="true"
            />{{ tag(n) }}</span
          >
          <span class="label">{{ n.label }}</span>
          <span class="detail">{{ n.detail }}</span>
        </button>
      </div>
      <div class="zoom" @pointerdown.stop @touchstart.stop>
        <UiButton size="compact" icon="＋" aria-label="Zoom in" title="Zoom in" @click="zoomBy(1.25)" />
        <UiButton size="compact" icon="−" aria-label="Zoom out" title="Zoom out" @click="zoomBy(0.8)" />
        <UiButton size="compact" icon="⤢" aria-label="Fit the graph" title="Fit" @click="fit" />
      </div>
    </div>
    <p v-if="dag.nodes.length && !mode" class="muted hint">
      Tap a node to open it.
      {{ coarse ? 'Touch and hold, then drag to move the graph; pinch to zoom.' : 'Drag to move the graph; Shift + scroll or pinch to zoom.' }}
    </p>
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
  gap: 0.3rem;
}
.stale-msg {
  margin: 0;
  font-size: 0.74rem;
  color: var(--text-muted);
}
.flip {
  margin-left: auto;
  width: 1.6rem;
  height: 1.6rem;
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 0.8rem;
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
  color: var(--on-accent);
}
.btn:disabled {
  opacity: 0.5;
}
.scroll {
  position: relative;
  overflow: hidden;
  max-height: 70vh;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg);
  cursor: grab;
  /* one finger still scrolls the page; holding first pans the graph */
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.scroll.panning {
  cursor: grabbing;
  border-color: var(--accent-blue);
  box-shadow: inset 0 0 0 1px var(--accent-blue);
}
.canvas {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.zoom {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: grid;
  gap: 0.25rem;
  cursor: default;
}
.edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  color: color-mix(in srgb, var(--text-muted) 55%, var(--border-strong));
}
.edges path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
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
  border-color: var(--kind-dataset);
  background: color-mix(in srgb, var(--kind-dataset) 14%, var(--bg));
}
.node.transform {
  border-color: var(--kind-transform);
  background: color-mix(in srgb, var(--kind-transform) 14%, var(--bg));
}
.node.transform.not-run {
  border-style: dashed;
}
.node.viz {
  border-color: var(--kind-viz);
  background: color-mix(in srgb, var(--kind-viz) 14%, var(--bg));
}
.node.viz.muted {
  opacity: 0.6;
}
/* Can't work on this device: red outline (a missing dataset gets a ⚠ too; never hue alone). */
.node.missing,
.node.waits {
  border-color: var(--danger);
  border-style: dashed;
  background: color-mix(in srgb, var(--danger) 10%, var(--bg));
}
.node.missing {
  border-width: 2px;
  border-style: solid;
}
.node.missing .detail,
.node.waits .detail {
  color: var(--danger);
}
.badge.problem-badge {
  background: var(--danger);
  color: var(--on-accent);
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
.store-dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  margin-right: 0.3rem;
  border-radius: 50%;
  vertical-align: 0.02rem;
  background: var(--text-muted);
  box-shadow: 0 0 0 1px var(--bg-elev);
}
.store-dot.remote {
  background: var(--kind-dataset);
}
.store-dot.pending {
  box-shadow: 0 0 0 1.5px var(--warn);
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
.node.stale .detail {
  color: var(--text);
  font-weight: 650;
}
/* Needs re-run: an amber ↻ on the node's corner (attention = amber + a mark, never hue alone). */
.badge {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--warn);
  color: var(--on-amber);
  font-size: 0.68rem;
  font-weight: 800;
  line-height: 1;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
  margin: 0;
}
</style>
