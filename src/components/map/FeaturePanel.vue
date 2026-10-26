<script setup lang="ts">
// Click-to-open panel for one feature. Shows an optional custom dashboard
// (default slot, receives the feature) above a generic table of every field.
// Side panel on wide screens, bottom sheet on phones.
import { computed, ref } from 'vue'
import PropertyValue from './PropertyValue.vue'
import { fieldLabel, type LayerData, type LayerFeature } from '../../lib/schema'

const props = defineProps<{
  layer: LayerData
  feature: LayerFeature
  /** Fields to leave out of the generic table (e.g. ones the dashboard already shows). */
  hideFields?: string[]
}>()
defineEmits<{ (e: 'close'): void }>()

const showAll = ref(false)
const title = computed(() => {
  const f = props.layer.titleField
  return String((f && props.feature.properties[f]) ?? props.feature.properties[props.layer.idField] ?? 'Feature')
})
const fields = computed(() => props.layer.fields.filter((f) => !props.hideFields?.includes(f.name)))
</script>

<template>
  <aside class="feature-panel" role="dialog" :aria-label="title">
    <header class="fp-head">
      <div>
        <div class="fp-layer">{{ layer.name }}</div>
        <h2 class="fp-title"><slot name="title" :feature="feature">{{ title }}</slot></h2>
      </div>
      <button class="fp-close" aria-label="Close" @click="$emit('close')">✕</button>
    </header>
    <div class="fp-body">
      <slot :feature="feature" />
      <details class="fp-props" :open="!$slots.default || showAll" @toggle="showAll = ($event.target as HTMLDetailsElement).open">
        <summary>All properties</summary>
        <dl class="fp-kv">
          <template v-for="f in fields" :key="f.name">
            <dt :title="f.description ?? f.name">{{ fieldLabel(f) }}</dt>
            <dd><PropertyValue :value="feature.properties[f.name]" :type="f.type" :unit="f.unit" /></dd>
          </template>
        </dl>
      </details>
    </div>
  </aside>
</template>

<style scoped>
.feature-panel {
  position: absolute;
  z-index: 5;
  top: 0.5rem;
  right: 0.5rem;
  bottom: 0.5rem;
  width: min(24rem, calc(100% - 1rem));
  display: flex;
  flex-direction: column;
  background: var(--overlay-bg);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  box-shadow: var(--shadow);
}
.fp-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem 0.4rem;
  border-bottom: 1px solid var(--border);
}
.fp-layer {
  font-size: 0.7rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.fp-title {
  margin: 0;
  font-size: 1.05rem;
}
.fp-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  padding: 0.2rem 0.4rem;
}
.fp-body {
  overflow: auto;
  padding: 0.6rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.fp-props summary {
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 0.4rem;
}
.fp-kv {
  display: grid;
  grid-template-columns: minmax(6rem, max-content) 1fr;
  gap: 0.3rem 0.6rem;
  margin: 0;
  font-size: 0.82rem;
}
.fp-kv dt {
  color: var(--text-muted);
}
.fp-kv dd {
  margin: 0;
  min-width: 0;
}
@media (max-width: 40rem) {
  .feature-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-height: 60%;
    border-radius: 0.75rem 0.75rem 0 0;
  }
}
</style>
