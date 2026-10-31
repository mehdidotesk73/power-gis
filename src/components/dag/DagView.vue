<script setup lang="ts">
// The workspace as a graph: datasets → transforms → output datasets →
// visualizations, laid out automatically (lib/workspace/dag.ts). Tap a node
// to select it (the page opens it below the graph). ＋ Dataset: the page opens
// the add form below. ＋ Transform: tap the input datasets, then Next.
// ＋ Visualization: tap the dataset to draw. ↓ / → flips the flow (top to
// bottom, left to right), remembered per device. The graph pans and zooms
// (usePanZoom): drag / Shift + wheel / pinch; on phones hold, then drag.
// Several nodes can be picked to delete together: Ctrl/⌘- or Shift-click, or
// Select (phones) then taps; Delete takes them out of the workspace (the page
// does it, undoable; data is never erased).
import UiButton from '../ui/UiButton.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { vReveal } from '../reveal'
import { picks, useSelection } from '../selection'
import { usePanZoom } from './usePanZoom'
import { copyPng, graphPng } from './graphImage'
import { edgePath, layoutDag, NODE_H, NODE_W, type Dag, type DagDirection, type DagNode, type DagStyle } from '../../lib/workspace/dag'

const props = defineProps<{
  dag: Dag
  selected: string | null
  /** How many transforms "Run all stale" would run (0 hides it). */
  staleCount?: number
  /** While running, "Running 2 of 3 · …"; then the outcome. */
  staleProgress?: { running: boolean; text: string } | null
  /** False while the page is still preparing the workspace: the ＋ buttons wait (an item added then would be lost). */
  adding?: boolean
  /** What the last Delete did. */
  note?: string
}>()
const emit = defineEmits<{
  (e: 'select', node: DagNode | null): void
  (e: 'new-transform', datasetIds: string[]): void
  (e: 'new-viz', datasetId: string): void
  (e: 'new-dataset'): void
  (e: 'run-stale'): void
}>()

const DIRECTION = 'powergis.dagDirection'
const STYLE = 'powergis.dagStyle'
const stored = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const direction = ref<DagDirection>(stored(DIRECTION) === 'horizontal' ? 'horizontal' : 'vertical')
const style = ref<DagStyle>(stored(STYLE) === 'compact' ? 'compact' : 'regular')
function setLayout(d: DagDirection, st: DagStyle) {
  direction.value = d
  style.value = st
  layoutOpen.value = false
  try {
    localStorage.setItem(DIRECTION, d)
    localStorage.setItem(STYLE, st)
  } catch {
    /* per-device convenience only */
  }
}
/** The layout menu (under ✎ in the graph's corner): open, it lists the layouts; any tap elsewhere closes it. */
const layoutOpen = ref(false)
const LAYOUTS: { id: string; direction: DagDirection; style: DagStyle; icon: string; label: string }[] = [
  { id: 'vertical', direction: 'vertical', style: 'regular', icon: '↓', label: 'Top to bottom' },
  { id: 'horizontal', direction: 'horizontal', style: 'regular', icon: '→', label: 'Left to right' },
  { id: 'vertical-compact', direction: 'vertical', style: 'compact', icon: '⇊', label: 'Top to bottom, compact' },
  { id: 'horizontal-compact', direction: 'horizontal', style: 'compact', icon: '⇉', label: 'Left to right, compact' },
]
const current = computed(() => LAYOUTS.find((l) => l.direction === direction.value && l.style === style.value)!)
const closeLayout = (e: PointerEvent) => {
  if (!(e.target as HTMLElement | null)?.closest('.layout-menu')) layoutOpen.value = false
}
watch(layoutOpen, (on) => (on ? document.addEventListener('pointerdown', closeLayout, true) : document.removeEventListener('pointerdown', closeLayout, true)))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeLayout, true))
const layout = computed(() => layoutDag(props.dag, direction.value, style.value))

// The graph sits in a fixed viewport and pans / zooms; it opens fitted (never
// enlarged), and refits when its size or direction changes.
const viewport = ref<HTMLElement>()
const { view, panning, fit, zoomBy } = usePanZoom(viewport, () => ({ w: layout.value.width, h: layout.value.height }))
/**
 * Viewport height: the space left below it on screen (less room for the hint under it and, in setup on a
 * phone, the mini map's bar), so the graph uses what's there; at least 240 px.
 */
const viewportH = ref(240)
const RESERVE = 130
function refit() {
  const el = viewport.value
  if (!el) return
  const top = el.getBoundingClientRect().top
  viewportH.value = Math.max(240, Math.round(window.innerHeight - Math.max(top, 0) - RESERVE))
  nextTick(fit)
}
const onWindowResize = () => refit()
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
  window.addEventListener('resize', onWindowResize)
})
let resizer: ResizeObserver | null = null
onBeforeUnmount(() => {
  resizer?.disconnect()
  window.removeEventListener('resize', onWindowResize)
})
watch(() => [layout.value.width, layout.value.height, direction.value, style.value, props.dag.nodes.length > 0], () => nextTick(refit))
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** Copies what the graph's window shows (as panned and zoomed) as a PNG; downloads it where the clipboard can't take images. */
const copied = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copyImage() {
  const el = viewport.value
  if (!el) return
  const at = { ...view.value }
  try {
    const how = await copyPng(() => graphPng(el, props.dag, layout.value, at, el.clientWidth, el.clientHeight), 'graph.png')
    copied.value = how === 'copied' ? 'Copied ✓' : 'Saved as graph.png'
  } catch (e) {
    copied.value = `Couldn’t copy: ${(e as Error).message}`
  }
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 2500)
}

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

// ── picking several (to delete) ──────────────────────────────────────────────

// The page's selection (components/selection.ts), shared with the lists; the tools (Select, Delete,
// undo, redo) float in the graph's corner (the `tools` slot).
const selection = useSelection()
const marked = computed(() => selection?.marked.value ?? [])
const isMarked = (n: DagNode) => marked.value.includes(n.key)
function toggleMark(n: DagNode) {
  // An open node joins the selection when a second one is added.
  if (!marked.value.length && props.selected && props.selected !== n.key) selection?.toggle(props.selected)
  selection?.toggle(n.key)
  emit('select', null)
}

function tap(n: DagNode, e?: MouseEvent) {
  if (!mode.value && e && picks(selection, e)) return toggleMark(n)
  if (!mode.value) {
    if (marked.value.length && selection) selection.marked.value = []
    return emit('select', props.selected === n.key ? null : n)
  }
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
      <template v-if="adding !== false">
        <UiButton data-testid="graph.add-dataset" size="tag" tone="dataset" icon="＋" @click="emit('new-dataset')">Dataset</UiButton>
        <UiButton data-testid="graph.add-transform" size="tag" tone="transform" icon="＋" :disabled="!dag.nodes.some((n) => n.kind === 'dataset')" @click="start('transform')">Transform</UiButton>
        <UiButton size="tag" tone="viz" icon="＋" :disabled="!dag.nodes.some((n) => n.kind === 'dataset')" @click="start('viz')">Visualization</UiButton>
      </template>
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
    </div>
    <p v-if="!mode && note" class="stale-msg" role="status">{{ note }}</p>
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
          :class="[n.kind, n.state, n.problem, { selected: selected === n.key, picked: pickNo(n) > 0, marked: isMarked(n), dimmed: dimmed(n), muted: n.muted }]"
          :style="{ left: `${layout.at.get(n.key)!.x}px`, top: `${layout.at.get(n.key)!.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
          :aria-pressed="selected === n.key || pickNo(n) > 0 || isMarked(n)"
          :title="`${kindLabel(n)}: ${n.label} — ${n.detail}`"
          @click="tap(n, $event)"
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
      <div v-if="!mode" class="corner-tools">
        <slot name="tools" />
        <div class="layout-menu" @pointerdown.stop @touchstart.stop>
          <UiButton
            data-testid="graph.layout"
            size="compact"
            :icon="current.icon"
            :active="layoutOpen"
            :aria-expanded="layoutOpen"
            aria-haspopup="menu"
            aria-label="Layout"
            title="Layout"
            @click="layoutOpen = !layoutOpen"
          />
          <div v-if="layoutOpen" class="layouts" role="menu" aria-label="Layouts">
            <button
              v-for="l in LAYOUTS"
              :key="l.id"
              role="menuitemradio"
              :aria-checked="current.id === l.id"
              :data-testid="`graph.layout.${l.id}`"
              :class="{ on: current.id === l.id }"
              @click="setLayout(l.direction, l.style)"
            >
              <span class="li" aria-hidden="true">{{ l.icon }}</span>{{ l.label }}
            </button>
          </div>
        </div>
      </div>
      <div class="zoom" @pointerdown.stop @touchstart.stop>
        <UiButton size="compact" icon="＋" aria-label="Zoom in" title="Zoom in" @click="zoomBy(1.25)" />
        <UiButton size="compact" icon="−" aria-label="Zoom out" title="Zoom out" @click="zoomBy(0.8)" />
        <UiButton size="compact" icon="⤢" aria-label="Fit the graph" title="Fit" @click="fit" />
        <UiButton data-testid="graph.copy-image" size="compact" icon="⧉" aria-label="Copy what's shown as an image" title="Copy what's shown as an image" @click="copyImage" />
      </div>
      <p v-if="copied" class="copied" role="status">{{ copied }}</p>
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
.corner-tools {
  position: absolute;
  z-index: 3;
  left: 6px;
  top: 6px;
  max-width: calc(100% - 12px);
  display: grid;
  justify-items: start;
  gap: 0.3rem;
}
.layout-menu {
  display: grid;
  justify-items: start;
  gap: 0.25rem;
  cursor: default;
}
.layouts {
  display: grid;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-elev) 96%, transparent);
  box-shadow: var(--shadow);
}
.layouts button {
  display: flex;
  gap: 0.45rem;
  align-items: center;
  padding: 0.35rem 0.55rem;
  border: 0;
  border-radius: calc(var(--radius) - 2px);
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
}
.layouts button.on {
  background: color-mix(in srgb, var(--accent-blue) 18%, transparent);
}
.layouts .li {
  width: 1rem;
  text-align: center;
}
.zoom {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: grid;
  gap: 0.25rem;
  cursor: default;
}
.copied {
  position: absolute;
  left: 6px;
  bottom: 6px;
  margin: 0;
  padding: 0.2rem 0.5rem;
  border-radius: 0.4rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 0.74rem;
  pointer-events: none;
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
.node.marked {
  outline: 2px dashed var(--danger);
  outline-offset: 2px;
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
