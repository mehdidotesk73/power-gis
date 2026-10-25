<script setup lang="ts">
// Custom dashboard for a county in the utilities layer: ownership mix bar
// plus the utilities serving it, each linkable to its full territory.
import { computed } from 'vue'
import type { LayerFeature } from '../lib/schema'
import { formatPrimitive } from '../lib/format'
import { OWNERSHIP_COLORS } from './utilityStyles'

interface UtilityRef {
  utility_id_eia: number
  utility_name: string
  entity_type: string
  state_customers: number | null
  counties_in_state: number
}

const props = defineProps<{ feature: LayerFeature; selectedUtilityId: number | null }>()
defineEmits<{ (e: 'pick-utility', id: number): void }>()

const utilities = computed(() => (props.feature.properties.utilities ?? []) as UtilityRef[])
const mix = computed(() => {
  const counts = (props.feature.properties.entity_type_counts ?? {}) as Record<string, number>
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => ({ type, n, pct: total ? (100 * n) / total : 0, color: OWNERSHIP_COLORS[type] ?? '#9e9e9e' }))
})
</script>

<template>
  <section class="dash">
    <div class="stat">
      <span class="big">{{ utilities.length }}</span>
      <span class="muted">{{ utilities.length === 1 ? 'utility serves' : 'utilities serve' }} this county</span>
    </div>
    <div v-if="mix.length" class="mix" role="img" :aria-label="mix.map((m) => `${m.n} ${m.type}`).join(', ')">
      <span v-for="m in mix" :key="m.type" :style="{ width: m.pct + '%', background: m.color }" :title="`${m.type}: ${m.n}`" />
    </div>
    <ul class="mix-legend">
      <li v-for="m in mix" :key="m.type"><i :style="{ background: m.color }" />{{ m.type }} · {{ m.n }}</li>
    </ul>
    <ol class="utils">
      <li v-for="u in utilities" :key="u.utility_id_eia" :class="{ on: u.utility_id_eia === selectedUtilityId }">
        <div class="u-main">
          <span class="u-name">{{ u.utility_name }}</span>
          <span class="muted">{{ u.entity_type }} · EIA {{ u.utility_id_eia }}</span>
          <span class="muted">
            {{ formatPrimitive(u.state_customers, 'int') }} customers in state · {{ u.counties_in_state }} counties
          </span>
        </div>
        <button class="u-btn" @click="$emit('pick-utility', u.utility_id_eia)">
          {{ u.utility_id_eia === selectedUtilityId ? 'Shown' : 'Territory' }}
        </button>
      </li>
    </ol>
    <p v-if="!utilities.length" class="muted">No EIA-861 service territory lists this county.</p>
  </section>
</template>

<style scoped>
.dash {
  display: grid;
  gap: 0.5rem;
  font-size: 0.82rem;
}
.stat {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}
.big {
  font-size: 1.6rem;
  font-weight: 700;
}
.muted {
  color: var(--text-muted);
}
.mix {
  display: flex;
  height: 0.7rem;
  border-radius: 0.3rem;
  overflow: hidden;
}
.mix-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.7rem;
  font-size: 0.74rem;
}
.mix-legend i {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 0.15rem;
  margin-right: 0.25rem;
}
.utils {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.35rem;
}
.utils li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
}
.utils li.on {
  border-color: var(--accent-blue);
}
.u-main {
  display: grid;
  flex: 1;
  min-width: 0;
}
.u-name {
  font-weight: 600;
}
.u-main .muted {
  font-size: 0.74rem;
}
.u-btn {
  flex: none;
  padding: 0.3rem 0.5rem;
  font-size: 0.74rem;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-elev);
  color: var(--text);
}
</style>
