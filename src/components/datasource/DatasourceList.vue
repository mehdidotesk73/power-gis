<script setup lang="ts">
// Imported data sources: what each holds, how its rows matched, and a
// button to add a layer (visualization) from it.
import type { LoadedDatasource } from './types'
import { BOUNDARIES } from '../../lib/datasource/binding'

defineProps<{ datasources: LoadedDatasource[]; layerCount: (id: string) => number }>()
const emit = defineEmits<{ (e: 'add-layer', id: string): void; (e: 'zoom', id: string): void; (e: 'remove', id: string): void }>()

function where(ds: LoadedDatasource): string {
  const b = ds.spec.binding
  if (b.kind === 'boundary') return `${b.column} → ${BOUNDARIES[b.boundary].split(' (')[0]}`
  if (b.kind === 'latlon') return `${b.lat}, ${b.lon} → points`
  return `${b.column} → shapes`
}

function stats(ds: LoadedDatasource): string {
  const n = ds.built.base.features.length
  const rows = [...ds.built.rowsByKey.values()].reduce((a, r) => a + r.length, 0)
  const kind = ds.built.geometryKind === 'point' ? 'points' : ds.built.geometryKind === 'polyline' ? 'lines' : 'regions'
  return `${plural(rows, 'row')} · ${n.toLocaleString()} ${kind} · ${plural(ds.built.columns.length, 'column')}`
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
</script>

<template>
  <ul class="list">
    <li v-for="ds in datasources" :key="ds.spec.id" class="ds">
      <div class="head">
        <div class="title">
          <strong>{{ ds.spec.name }}</strong>
          <span class="muted">{{ stats(ds) }}</span>
          <span class="muted">{{ where(ds) }} · {{ ds.spec.origin }}</span>
        </div>
        <button class="icon" title="Zoom to data" @click="emit('zoom', ds.spec.id)">⤢</button>
        <button class="icon" title="Remove data source and its layers" @click="emit('remove', ds.spec.id)">✕</button>
      </div>
      <p v-if="ds.built.unmatched" class="warn">
        {{ plural(ds.built.unmatched, 'row') }} had no matching feature (e.g. {{ ds.built.unmatchedSamples.slice(0, 3).join(', ') }})
      </p>
      <button class="add" @click="emit('add-layer', ds.spec.id)">＋ Layer</button>
      <span class="muted count">{{ plural(layerCount(ds.spec.id), 'layer') }}</span>
    </li>
  </ul>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.ds {
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.4rem 0.5rem;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 0.3rem;
}
.title {
  flex: 1;
  display: grid;
  min-width: 0;
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.icon {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.9rem;
  padding: 0 0.2rem;
}
.warn {
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  color: #b26a00;
}
.count {
  margin-left: 0.5rem;
}
.add {
  margin-top: 0.3rem;
  background: none;
  border: none;
  color: var(--accent-blue);
  font-size: 0.8rem;
  padding: 0;
}
</style>
