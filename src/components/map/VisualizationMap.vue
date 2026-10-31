<script setup lang="ts">
// A map of a list of visualizations (useVisualizationLayers' `rendered`): the
// basemap, each visualization's layer (scalar or vector), stacked like the list
// (top of the list draws on top, within its geometry kind). The page's map and
// the maps drawn off screen for stories are both this component; overlays (legend,
// tooltip, panels) go in the `overlay` slot.
import { nextTick, ref, watch } from 'vue'
import MapView from './MapView.vue'
import ScalarLayer from './ScalarLayer'
import VectorLayer from './VectorLayer'
import { mapPng } from './mapImage'
import type { HoverInfo } from './mapContext'
import type { RenderedViz } from './useVisualizationLayers'
import type { VisualizationSpec } from '../../lib/dataset/visualization'
import type { BBox } from '../../lib/geometry'
import type { LegendEntry } from '../../lib/style'

const props = withDefaults(
  defineProps<{
    rendered: RenderedViz[]
    highlightFor?: (v: VisualizationSpec) => string[]
    selectedKeyFor?: (v: VisualizationSpec) => string | null
  }>(),
  { highlightFor: () => [], selectedKeyFor: () => null },
)
const emit = defineEmits<{
  (e: 'hover', layerId: string, h: HoverInfo | null): void
  (e: 'select', layerId: string, id: string): void
  (e: 'background-click'): void
}>()

const view = ref<InstanceType<typeof MapView>>()

// Keep the map's stacking in step with the list (top of the list draws on top).
watch(
  () => props.rendered.map((r) => r.layer.id).join('|'),
  () => nextTick(() => view.value?.restack(props.rendered.map((r) => r.layer.id))),
  { flush: 'post', immediate: true },
)

defineExpose({
  fitBounds: (b: BBox, maxZoom?: number) => view.value?.fitBounds(b, maxZoom),
  getMap: () => view.value?.getMap() ?? null,
  /** The map as it shows now, with `legend`, as a PNG. */
  png(legend: LegendEntry[]): Promise<Blob> {
    const m = view.value?.getMap()
    return m ? mapPng(m, legend) : Promise.reject(new Error('the map isn’t ready'))
  },
})
</script>

<template>
  <MapView ref="view" @background-click="emit('background-click')">
    <template v-for="r in rendered" :key="`${r.layer.id}-${r.layer.kind}`">
      <ScalarLayer
        v-if="r.layer.kind === 'scalar'"
        :layer="r.data"
        :style-spec="r.layer.style"
        :visible="r.layer.visible"
        :highlight-ids="highlightFor(r.layer)"
        :selected-id="selectedKeyFor(r.layer)"
        @hover="(h) => emit('hover', r.layer.id, h)"
        @select="(id) => emit('select', r.layer.id, id)"
      />
      <VectorLayer
        v-else
        :layer="r.data"
        :style-spec="r.layer.style"
        :visible="r.layer.visible"
        @hover="(h) => emit('hover', r.layer.id, h)"
        @select="(id) => emit('select', r.layer.id, id)"
      />
    </template>
    <template #overlay><slot name="overlay" /></template>
  </MapView>
</template>
