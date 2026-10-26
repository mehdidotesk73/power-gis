<script setup lang="ts">
// Edits a VectorStyle: arrow color (single / colormap by magnitude), size
// range and opacity.
import { ARROW } from '../../lib/mapTheme'
import { COLORMAPS, cssGradient, type ColormapName } from '../../lib/colormaps'
import { MAGNITUDE_FIELD, type VectorStyle } from '../../lib/style'

const props = defineProps<{ modelValue: VectorStyle }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: VectorStyle): void }>()
const colormaps = Object.keys(COLORMAPS) as ColormapName[]

function update(patch: Partial<VectorStyle>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}
function setColormap(name: string) {
  if (name === '') update({ color: { kind: 'constant', color: ARROW } })
  else update({ color: { kind: 'colormap', field: MAGNITUDE_FIELD, colormap: name as ColormapName } })
}
</script>

<template>
  <div class="editor">
    <label class="row">
      Color
      <select :value="modelValue.color.kind === 'colormap' ? modelValue.color.colormap : ''" @change="setColormap(($event.target as HTMLSelectElement).value)">
        <option value="">Single color</option>
        <option v-for="c in colormaps" :key="c" :value="c">{{ c }} (by magnitude)</option>
      </select>
    </label>
    <label v-if="modelValue.color.kind === 'constant'" class="row">
      Arrow color
      <input type="color" :value="modelValue.color.color" @input="update({ color: { kind: 'constant', color: ($event.target as HTMLInputElement).value } })" />
    </label>
    <div v-else-if="modelValue.color.kind === 'colormap'" class="ramp" :style="{ background: cssGradient(modelValue.color.colormap) }" />
    <label class="row">
      Smallest {{ modelValue.size.min.toFixed(1) }}×
      <input type="range" min="0.2" max="2" step="0.1" :value="modelValue.size.min" @input="update({ size: { ...modelValue.size, min: +($event.target as HTMLInputElement).value } })" />
    </label>
    <label class="row">
      Largest {{ modelValue.size.max.toFixed(1) }}×
      <input type="range" min="0.4" max="3" step="0.1" :value="modelValue.size.max" @input="update({ size: { ...modelValue.size, max: +($event.target as HTMLInputElement).value } })" />
    </label>
    <label v-if="modelValue.opacity.kind === 'constant'" class="row">
      Opacity {{ Math.round(modelValue.opacity.value * 100) }}%
      <input type="range" min="0.1" max="1" step="0.05" :value="modelValue.opacity.value" @input="update({ opacity: { kind: 'constant', value: +($event.target as HTMLInputElement).value } })" />
    </label>
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  gap: 0.4rem;
  font-size: 0.82rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
select {
  max-width: 12rem;
  padding: 0.25rem;
  font-size: 0.8rem;
}
.ramp {
  height: 0.55rem;
  border-radius: 0.2rem;
}
</style>
