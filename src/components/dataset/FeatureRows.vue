<script setup lang="ts">
// The rows behind one feature, as a table — the generic "dashboard" any
// dataset gets in its click panel.
import { computed } from 'vue'
import PropertyValue from '../map/PropertyValue.vue'
import type { DataRecord } from '../../lib/data/connectors'
import { listOf, structOf } from '../../lib/schema'
import { fieldTypeOf, type BuiltDataset } from '../../lib/dataset/dataset'

const props = defineProps<{ built: BuiltDataset; rows: DataRecord[] }>()
const type = computed(() => listOf(structOf(props.built.columns.map((c) => ({ name: c.name, type: fieldTypeOf(c.type) })))))
</script>

<template>
  <section>
    <div class="head">{{ rows.length.toLocaleString() }} {{ rows.length === 1 ? 'row' : 'rows' }}</div>
    <PropertyValue :value="rows" :type="type" />
  </section>
</template>

<style scoped>
.head {
  font-size: 0.78rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
</style>
