<script setup lang="ts">
// One figure of a story scene. Samples and charts show their snapshot at once,
// then run their SQL (`previewTransform`, nothing stored) and show what the data
// says now, marked when it differs from what the narrative was written on. Maps
// are drawn from their settings on a map of their own, off screen
// (visualizationImage.ts), one at a time, when the figure scrolls into view; the
// picture is kept for the visit. Holding a map's picture (touch) or
// double-clicking it (mouse) brings it to life
// (LiveStoryMap: pan, zoom, tap a region), raised off the page; one live map at a
// time; Release puts the view back as a picture. None of it is stored.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { request } from '../../client/api'
import { runFigure, snapshotChanged, type Figure, type Snapshot } from '../../lib/story/story'
import { chartShapes, short } from '../../lib/story/chart'
import { paletteColors } from '../../lib/palettes'
import type { DatasetRecord } from '../../shared/records'
import type { VisualizationSpec } from '../../lib/dataset/visualization'
import { visualizationsPng } from '../map/visualizationImage'
import LiveStoryMap, { type View } from './LiveStoryMap.vue'
import { logDebug } from '../../debug'

const props = defineProps<{ figure: Figure; records: Map<string, DatasetRecord> }>()

const el = ref<HTMLElement>()
const live = shallowRef<Snapshot | null>(null)
const problem = ref('')
const image = ref('')
const drawing = ref(false)

const shownData = computed(() => (props.figure.kind === 'map' ? null : (live.value ?? props.figure.snapshot ?? null)))
const changed = computed(() => props.figure.kind !== 'map' && !!live.value && snapshotChanged(props.figure.snapshot, live.value))
const missing = computed(() => {
  const ids = props.figure.kind === 'map' ? [props.figure.viz.datasetId] : props.figure.inputs.map((i) => i.datasetId)
  return ids.filter((id) => !props.records.has(id))
})

async function load() {
  const f = props.figure
  if (missing.value.length) return
  if (f.kind === 'map') return drawMap(f)
  const r = await runFigure(f, (sql, inputs, limit) => request('previewTransform', { sql, inputs, limit }))
  if (typeof r === 'string') problem.value = r
  else live.value = r
}

// ── maps: drawn one at a time, kept for the visit ──────────────────────────

let queue: Promise<unknown> = Promise.resolve()
async function drawMap(f: Extract<Figure, { kind: 'map' }>) {
  const v = { ...f.viz, id: 'story-figure', visible: true } as VisualizationSpec
  const key = JSON.stringify([f.viz, f.hide, f.fit, props.records.get(f.viz.datasetId)?.updatedAt])
  let p = mapCache.get(key)
  if (!p) {
    p = (queue = queue.catch(() => undefined).then(() => visualizationsPng([v], props.records, { hide: f.hide, fit: f.fit }))).then((b) => URL.createObjectURL(b as Blob))
    p.catch(() => mapCache.delete(key))
    mapCache.set(key, p)
  }
  drawing.value = true
  try {
    image.value = await p
  } catch (e) {
    problem.value = `The map couldn’t be drawn: ${(e as Error).message}`
    logDebug(`story map "${f.viz.name}": ${(e as Error).message}`, 'error')
  } finally {
    drawing.value = false
  }
}

// ── a live map, one at a time on the page ─────────────────────────────────

const myId = Symbol('figure')
const mapLive = ref(false)
const liveMap = ref<InstanceType<typeof LiveStoryMap>>()
// Hold (touch) or double-click (mouse) — the app's one "go deeper" gesture pair. A tap or a click does
// nothing, so scrolling past a map never wakes it.
const canHover = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches
const HOLD_MS = 500
let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null
const endHold = () => {
  if (hold) clearTimeout(hold.timer)
  hold = null
}
function holdDown(e: PointerEvent) {
  if (e.pointerType === 'mouse') return
  endHold()
  hold = { x: e.clientX, y: e.clientY, timer: setTimeout(() => (endHold(), navigator.vibrate?.(10), goLive()), HOLD_MS) }
}
function holdMove(e: PointerEvent) {
  if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) endHold() // a scroll, not a hold
}
function goLive() {
  if (props.figure.kind !== 'map' || !image.value) return
  // Another figure's live map goes back to a picture first.
  if (activeLive.value && activeLive.value !== myId) releaseOthers.value?.()
  activeLive.value = myId
  releaseOthers.value = () => void liveMap.value?.release()
  mapLive.value = true
}
// Where the live map was left, this visit only: holding / double-clicking again opens it there.
const lastView = shallowRef<View | null>(null)
function onRelease(picture: Blob | null, view: View | null) {
  if (picture) image.value = URL.createObjectURL(picture) // this visit only: the cache keeps the figure's own picture
  if (view) lastView.value = view
  mapLive.value = false
  if (activeLive.value === myId) {
    activeLive.value = null
    releaseOthers.value = null
  }
}
// A click or tap anywhere outside the live map puts it back to a picture. A swipe (the story scrolling) isn't a tap.
const mapEl = ref<HTMLElement>()
let outside: { x: number; y: number } | null = null
function outsideDown(e: PointerEvent) {
  outside = mapEl.value && !mapEl.value.contains(e.target as Node) ? { x: e.clientX, y: e.clientY } : null
}
function outsideUp(e: PointerEvent) {
  if (outside && Math.hypot(e.clientX - outside.x, e.clientY - outside.y) < 10 && mapLive.value) void liveMap.value?.release()
  outside = null
}
watch(mapLive, (on) => {
  const act = on ? document.addEventListener : document.removeEventListener
  act.call(document, 'pointerdown', outsideDown as EventListener, true)
  act.call(document, 'pointerup', outsideUp as EventListener, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outsideDown as EventListener, true)
  document.removeEventListener('pointerup', outsideUp as EventListener, true)
  if (activeLive.value === myId) (activeLive.value = null), (releaseOthers.value = null)
})

let seen: IntersectionObserver | null = null
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return void load()
  seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return
    seen?.disconnect()
    seen = null
    void load()
  }, { rootMargin: '200px' })
  seen.observe(el.value!)
})
onBeforeUnmount(() => seen?.disconnect())

// ── charts ─────────────────────────────────────────────────────────────────

const shapes = computed(() => (props.figure.kind === 'chart' && shownData.value ? chartShapes(props.figure.chart, shownData.value) : null))
const colors = computed(() => paletteColors('auto', Math.max(1, shapes.value?.slices.length ?? 1)))
const cell = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : Number(v.toPrecision(4)).toLocaleString()) : String(v))
</script>

<script lang="ts">
import { ref as sharedRef } from 'vue'
// Shared by every figure on the page: map pictures by their settings.
const mapCache = new Map<string, Promise<string>>()
/** The figure whose map is live now (one at a time), and how to send it back to a picture. */
const activeLive = sharedRef<symbol | null>(null)
const releaseOthers = sharedRef<(() => void) | null>(null)
</script>

<template>
  <figure ref="el" class="figure" :data-kind="figure.kind" data-testid="story.figure">
    <p v-if="missing.length" class="muted small">This figure reads a dataset that isn’t on this device.</p>

    <!-- sample: a few rows -->
    <div v-else-if="figure.kind === 'sample'" class="table-wrap">
      <table v-if="shownData">
        <thead>
          <tr><th v-for="c in shownData.columns" :key="c">{{ c }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in shownData.rows" :key="i"><td v-for="(v, j) in row" :key="j">{{ cell(v) }}</td></tr>
        </tbody>
      </table>
      <p v-else-if="!problem" class="muted small">Reading…</p>
    </div>

    <!-- chart: drawn here from its data -->
    <div v-else-if="figure.kind === 'chart'">
      <svg v-if="shapes" :viewBox="`0 0 ${shapes.width} ${shapes.height}`" class="chart" role="img" :aria-label="figure.caption ?? `${figure.chart} chart`">
        <g class="axes">
          <line v-for="t in shapes.yTicks" :key="`y${t.at}`" :x1="shapes.plot.x" :x2="shapes.plot.x + shapes.plot.w" :y1="t.at" :y2="t.at" class="grid" />
          <text v-for="t in shapes.yTicks" :key="`yl${t.at}`" :x="shapes.plot.x - 4" :y="t.at + 3" text-anchor="end">{{ t.label }}</text>
          <text v-for="t in shapes.xTicks" :key="`xl${t.at}`" :x="t.at" :y="shapes.plot.y + shapes.plot.h + 14" text-anchor="middle">{{ t.label }}</text>
        </g>
        <rect v-for="(b, i) in shapes.bars" :key="`b${i}`" :x="b.x" :y="b.y" :width="b.w" :height="b.h" class="bar"><title>{{ b.label }}: {{ short(b.value) }}</title></rect>
        <g v-if="shapes.slices.length">
          <path v-for="(s, i) in shapes.slices" :key="`s${i}`" :d="s.path" :fill="colors[s.color % colors.length]" class="slice"><title>{{ s.label }}: {{ short(s.value) }} ({{ Math.round(s.share * 100) }}%)</title></path>
        </g>
        <path v-if="shapes.line" :d="shapes.line" class="line" />
        <circle v-for="(d, i) in shapes.dots" :key="`d${i}`" :cx="d.x" :cy="d.y" r="2.4" class="dot" />
      </svg>
      <ul v-if="shapes?.slices.length" class="keys">
        <li v-for="(s, i) in shapes.slices" :key="i"><i :style="{ background: colors[s.color % colors.length] }" />{{ s.label }} · {{ Math.round(s.share * 100) }}%</li>
      </ul>
      <p v-if="!shapes && !problem" class="muted small">Reading…</p>
    </div>

    <!-- map: a picture drawn off screen from its settings; tap it for a live map -->
    <div v-else ref="mapEl" class="map" :class="{ lifted: mapLive }">
      <LiveStoryMap v-if="mapLive" ref="liveMap" :figure="figure" :records="records" :view="lastView" @release="onRelease" />
      <button
        v-else-if="image"
        class="tap"
        data-testid="story.map"
        :aria-label="`Explore the map: ${figure.viz.name}`"
        @dblclick="goLive"
        @keydown.enter="goLive"
        @pointerdown="holdDown"
        @pointermove="holdMove"
        @pointerup="endHold"
        @pointercancel="endHold"
        @pointerleave="endHold"
        @contextmenu.prevent
      >
        <img :src="image" :alt="figure.caption ?? figure.viz.name" draggable="false" />
        <span class="hint">{{ canHover ? 'Double-click to explore' : 'Hold to explore' }}</span>
      </button>
      <p v-else-if="!problem" class="muted small">{{ drawing ? 'Drawing the map…' : 'The map draws when it scrolls into view.' }}</p>
    </div>

    <figcaption v-if="figure.caption">{{ figure.caption }}</figcaption>
    <p v-if="changed" class="changed small" data-testid="story.changed">⚠ The data has changed since this story was written: the narrative may quote older numbers.</p>
    <p v-if="problem" class="problem small">{{ problem }}</p>
  </figure>
</template>

<style scoped>
.figure {
  margin: 0;
  display: grid;
  gap: 0.3rem;
}
.table-wrap {
  overflow-x: auto;
}
table {
  border-collapse: collapse;
  font-size: 0.75rem;
  width: max-content;
  min-width: 100%;
}
th,
td {
  text-align: left;
  padding: 0.2rem 0.45rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--text-muted);
  font-weight: 600;
}
.chart {
  width: 100%;
  max-width: 34rem;
  height: auto;
}
.chart text {
  fill: var(--text-muted);
  font-size: 9px;
}
.grid {
  stroke: var(--border);
  stroke-width: 0.6;
}
.bar {
  fill: var(--accent-green);
}
.slice {
  stroke: var(--bg-elev);
  stroke-width: 1;
}
.line {
  fill: none;
  stroke: var(--accent-green);
  stroke-width: 2;
}
.dot {
  fill: var(--accent-green);
  opacity: 0.8;
}
.keys {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.7rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.72rem;
  color: var(--text-muted);
}
.keys i {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 2px;
  margin-right: 0.3rem;
  vertical-align: -1px;
}
.map {
  border-radius: var(--radius);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
/* Live: raised off the page, so it reads as something to touch. */
.map.lifted {
  position: relative;
  z-index: 2;
  transform: translateY(-3px) scale(1.015);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.55), 0 0 0 1px var(--accent-blue);
}
.tap {
  position: relative;
  -webkit-touch-callout: none;
  user-select: none;
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.tap .hint {
  position: absolute;
  right: 0.45rem;
  bottom: 0.45rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: rgb(0 0 0 / 0.6);
  color: var(--text);
  font-size: 0.7rem;
}
.map img {
  width: 100%;
  border-radius: var(--radius);
  display: block;
}
figcaption {
  font-size: 0.75rem;
  color: var(--text-muted);
}
.changed {
  color: var(--accent-amber);
  margin: 0;
}
.problem {
  color: var(--danger);
  margin: 0;
}
</style>
