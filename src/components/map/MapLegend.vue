<script setup lang="ts">
// Legend for any number of encodings: colormap ramps and categorical /
// pattern swatches (from style.ts colorLegend / patternLegend).
import { ref } from 'vue'
import type { LegendEntry } from '../../lib/style'
import { formatCompact } from '../../lib/format'
import { patternDataUrl } from './images'

defineProps<{ entries: LegendEntry[]; source?: string }>()
// Phones start collapsed: the legend would cover most of a small map.
const collapsed = ref(typeof window !== 'undefined' && window.innerWidth < 600)
</script>

<template>
  <div v-if="entries.length" class="legend" :class="{ collapsed }">
    <button class="lg-toggle" @click="collapsed = !collapsed">{{ collapsed ? 'Legend ▸' : 'Legend ▾' }}</button>
    <template v-if="!collapsed">
      <div v-for="(e, i) in entries" :key="i" class="lg-entry">
        <div class="lg-title">{{ e.title }}</div>
        <template v-if="e.kind === 'ramp'">
          <div class="lg-ramp" :style="{ background: e.gradient }" />
          <div class="lg-ticks">
            <span>{{ e.clippedLow ? '≤ ' : '' }}{{ formatCompact(e.min) }}</span>
            <span v-if="e.scale === 'log'" class="muted">log</span>
            <span>{{ e.clippedHigh ? '≥ ' : '' }}{{ formatCompact(e.max) }}</span>
          </div>
        </template>
        <ul v-else class="lg-swatches" :class="{ cols: e.items.length > 12 }">
          <li v-for="it in e.items" :key="it.label">
            <span
              class="lg-swatch"
              :style="
                it.pattern
                  ? { backgroundImage: `url(${patternDataUrl(it.pattern, it.color)})`, backgroundSize: '8px 8px' }
                  : { background: it.color }
              "
            />
            {{ it.label }}
          </li>
        </ul>
      </div>
      <div v-if="source" class="lg-source">{{ source }}</div>
    </template>
  </div>
</template>

<style scoped>
.legend {
  position: absolute;
  z-index: 4;
  /* Top-left of the map, always (zoom buttons are top-right, the feature panel on the right). */
  left: 0.5rem;
  top: 0.5rem;
  max-width: 14rem;
  max-height: calc(100% - 3rem);
  overflow: auto;
  background: var(--overlay-bg);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.35rem 0.55rem 0.45rem;
  font-size: 0.74rem;
}
.lg-toggle {
  background: none;
  border: none;
  padding: 0;
  color: var(--text-muted);
  font-size: 0.7rem;
}
.lg-entry + .lg-entry {
  margin-top: 0.4rem;
}
.lg-title {
  font-weight: 600;
  margin: 0.15rem 0 0.2rem;
}
.lg-ramp {
  height: 0.6rem;
  border-radius: 0.2rem;
  min-width: 9rem;
}
.lg-ticks {
  display: flex;
  justify-content: space-between;
  color: var(--text-muted);
}
.lg-swatches {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.1rem;
}
.lg-swatches.cols {
  /* Many categories (e.g. 50 states): columns instead of one long list. */
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: 0.5rem;
}
.lg-swatches.cols li {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lg-swatches li {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.lg-swatch {
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 0.15rem;
  border: 1px solid var(--border-strong);
  flex: none;
}
.lg-source {
  margin-top: 0.35rem;
  color: var(--text-muted);
  font-size: 0.66rem;
}
.muted {
  color: var(--text-muted);
}
</style>
