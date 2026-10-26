<script setup lang="ts">
// Edits a ScalarStyle for a layer: color (constant / colormap / categorical),
// opacity (constant / by field) and pattern (none / constant / by field).
import { PATTERN_INK } from '../../lib/mapTheme'
import { computed } from 'vue'
import { COLORMAPS, cssGradient, type ColormapName } from '../../lib/colormaps'
import { distinctValues, fieldLabel, isNumericType, type LayerData } from '../../lib/schema'
import { PALETTE_LABELS, paletteSize, type PaletteName } from '../../lib/palettes'
import { categoricalColors, PATTERNS, type ColorEncoding, type OpacityEncoding, type PatternEncoding, type PatternKind, type ScalarStyle } from '../../lib/style'

const props = defineProps<{ layer: LayerData; modelValue: ScalarStyle }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: ScalarStyle): void }>()

const numericFields = computed(() => props.layer.fields.filter((f) => isNumericType(f.type)))
const categoryFields = computed(() => props.layer.fields.filter((f) => f.type === 'string' || f.type === 'boolean'))
const colormaps = Object.keys(COLORMAPS) as ColormapName[]

function update(patch: Partial<ScalarStyle>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

const color = computed(() => props.modelValue.color)
function setColorKind(kind: ColorEncoding['kind']) {
  if (kind === 'constant') update({ color: { kind, color: '#3b82f6' } })
  else if (kind === 'colormap') update({ color: { kind, field: numericFields.value[0]?.name ?? '', colormap: 'viridis' } })
  else update({ color: { kind, field: categoryFields.value[0]?.name ?? '' } })
}
function patchColor(p: Record<string, unknown>) {
  update({ color: { ...color.value, ...p } as ColorEncoding })
}

// Categories: every value gets a color from the chosen palette.
const palettes = Object.keys(PALETTE_LABELS) as PaletteName[]
const categories = computed(() => (color.value.kind === 'categorical' ? categoricalColors(color.value, props.layer.features) : []))
const repeats = computed(() => {
  const c = color.value
  if (c.kind !== 'categorical') return 0
  const n = categories.value.filter((x) => !c.colors?.[x.value]).length
  return n > paletteSize(c.palette ?? 'auto', n) ? paletteSize(c.palette ?? 'auto', n) : 0
})

const opacity = computed(() => props.modelValue.opacity)
function setOpacityKind(kind: OpacityEncoding['kind']) {
  if (kind === 'constant') update({ opacity: { kind, value: 0.75 } })
  else update({ opacity: { kind, field: numericFields.value[0]?.name ?? '', range: [0.2, 0.95] } })
}

const pattern = computed(() => props.modelValue.pattern)
const patternValues = computed(() =>
  pattern.value.kind === 'field' ? distinctValues(props.layer.features, pattern.value.field).slice(0, 8) : [],
)
function setPatternKind(kind: PatternEncoding['kind']) {
  if (kind === 'none') update({ pattern: { kind } })
  else if (kind === 'constant') update({ pattern: { kind, pattern: 'hatch' } })
  else {
    const field = categoryFields.value[0]?.name ?? ''
    update({ pattern: { kind, field, patterns: defaultPatterns(field) } })
  }
}
function defaultPatterns(field: string): Record<string, PatternKind> {
  const vals = distinctValues(props.layer.features, field)
  if (vals.includes('true')) return { true: 'hatch' }
  return Object.fromEntries(vals.slice(0, 1).map((v) => [v, 'hatch' as PatternKind]))
}
function setPatternFor(value: string, p: PatternKind | '') {
  if (pattern.value.kind !== 'field') return
  const patterns = { ...pattern.value.patterns }
  if (p) patterns[value] = p
  else delete patterns[value]
  update({ pattern: { ...pattern.value, patterns } })
}
</script>

<template>
  <div class="editor">
    <fieldset>
      <legend>Color</legend>
      <div class="seg">
        <button v-for="k in ['constant', 'colormap', 'categorical'] as const" :key="k" :class="{ on: color.kind === k }" @click="setColorKind(k)">
          {{ k === 'constant' ? 'Single' : k === 'colormap' ? 'Colormap' : 'Categories' }}
        </button>
      </div>
      <label v-if="color.kind === 'constant'" class="row">
        Color <input type="color" :value="color.color" @input="patchColor({ color: ($event.target as HTMLInputElement).value })" />
      </label>
      <template v-else-if="color.kind === 'colormap'">
        <label class="row">
          Field
          <select :value="color.field" @change="patchColor({ field: ($event.target as HTMLSelectElement).value })">
            <option v-for="f in numericFields" :key="f.name" :value="f.name">{{ fieldLabel(f) }}</option>
          </select>
        </label>
        <label class="row">
          Colormap
          <select :value="color.colormap" @change="patchColor({ colormap: ($event.target as HTMLSelectElement).value })">
            <option v-for="c in colormaps" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <div class="ramp" :style="{ background: cssGradient(color.colormap, color.reverse) }" />
        <div class="row">
          <label><input type="checkbox" :checked="color.reverse" @change="patchColor({ reverse: ($event.target as HTMLInputElement).checked })" /> Reverse</label>
          <label><input type="checkbox" :checked="color.scale === 'log'" @change="patchColor({ scale: ($event.target as HTMLInputElement).checked ? 'log' : 'linear' })" /> Log scale</label>
        </div>
      </template>
      <template v-else>
        <label class="row">
          Field
          <select :value="color.field" @change="patchColor({ field: ($event.target as HTMLSelectElement).value, colors: undefined })">
            <option v-for="f in categoryFields" :key="f.name" :value="f.name">{{ fieldLabel(f) }}</option>
          </select>
        </label>
        <label class="row">
          Palette
          <select :value="color.palette ?? 'auto'" @change="patchColor({ palette: ($event.target as HTMLSelectElement).value })">
            <option v-for="p in palettes" :key="p" :value="p">{{ PALETTE_LABELS[p] }}</option>
          </select>
        </label>
        <div class="swatches" :title="`${categories.length} values`">
          <span v-for="c in categories" :key="c.value" :style="{ background: c.color }" />
        </div>
        <p class="note">
          {{ categories.length.toLocaleString() }} values<template v-if="repeats"> · only {{ repeats }} colors, so colors repeat — pick a bigger palette or Many</template>
        </p>
      </template>
    </fieldset>

    <fieldset>
      <legend>Transparency</legend>
      <div class="seg">
        <button :class="{ on: opacity.kind === 'constant' }" @click="setOpacityKind('constant')">Fixed</button>
        <button :class="{ on: opacity.kind === 'field' }" @click="setOpacityKind('field')">By field</button>
      </div>
      <label v-if="opacity.kind === 'constant'" class="row">
        Opacity {{ Math.round(opacity.value * 100) }}%
        <input type="range" min="0.05" max="1" step="0.05" :value="opacity.value" @input="update({ opacity: { kind: 'constant', value: +($event.target as HTMLInputElement).value } })" />
      </label>
      <label v-else class="row">
        Field
        <select :value="opacity.field" @change="update({ opacity: { ...opacity, field: ($event.target as HTMLSelectElement).value } as OpacityEncoding })">
          <option v-for="f in numericFields" :key="f.name" :value="f.name">{{ fieldLabel(f) }}</option>
        </select>
      </label>
    </fieldset>

    <fieldset v-if="layer.geometry === 'region'">
      <legend>Pattern</legend>
      <div class="seg">
        <button :class="{ on: pattern.kind === 'none' }" @click="setPatternKind('none')">None</button>
        <button :class="{ on: pattern.kind === 'constant' }" @click="setPatternKind('constant')">All</button>
        <button :class="{ on: pattern.kind === 'field' }" @click="setPatternKind('field')">By field</button>
      </div>
      <label v-if="pattern.kind === 'constant'" class="row">
        Pattern
        <select :value="pattern.pattern" @change="update({ pattern: { ...pattern, pattern: ($event.target as HTMLSelectElement).value as PatternKind } })">
          <option v-for="p in PATTERNS" :key="p" :value="p">{{ p }}</option>
        </select>
      </label>
      <template v-else-if="pattern.kind === 'field'">
        <label class="row">
          Field
          <select
            :value="pattern.field"
            @change="
              update({
                pattern: { ...pattern, field: ($event.target as HTMLSelectElement).value, patterns: defaultPatterns(($event.target as HTMLSelectElement).value) },
              })
            "
          >
            <option v-for="f in categoryFields" :key="f.name" :value="f.name">{{ fieldLabel(f) }}</option>
          </select>
        </label>
        <label v-for="v in patternValues" :key="v" class="row sub">
          {{ v }}
          <select :value="pattern.patterns[v] ?? ''" @change="setPatternFor(v, ($event.target as HTMLSelectElement).value as PatternKind | '')">
            <option value="">none</option>
            <option v-for="p in PATTERNS" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>
      </template>
      <label v-if="pattern.kind !== 'none'" class="row">
        Pattern color
        <input type="color" :value="pattern.color ?? PATTERN_INK" @input="update({ pattern: { ...pattern, color: ($event.target as HTMLInputElement).value } })" />
      </label>
    </fieldset>
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  gap: 0.5rem;
  font-size: 0.82rem;
}
fieldset {
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.4rem 0.6rem 0.55rem;
  margin: 0;
  display: grid;
  gap: 0.4rem;
}
legend {
  font-weight: 600;
  padding: 0 0.25rem;
}
.seg {
  display: flex;
  gap: 0;
}
.seg button {
  flex: 1;
  padding: 0.35rem 0.3rem;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  font-size: 0.78rem;
}
.seg button + button {
  border-left: none;
}
.seg button:first-child {
  border-radius: 0.35rem 0 0 0.35rem;
}
.seg button:last-child {
  border-radius: 0 0.35rem 0.35rem 0;
}
.seg button.on {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--on-accent);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.row.sub {
  padding-left: 0.6rem;
  color: var(--text-muted);
}
select {
  max-width: 11rem;
  padding: 0.25rem;
  font-size: 0.8rem;
}
.ramp {
  height: 0.55rem;
  border-radius: 0.2rem;
}
.swatches {
  display: flex;
  height: 0.7rem;
  border-radius: 0.2rem;
  overflow: hidden;
}
.swatches span {
  flex: 1;
  min-width: 1px;
}
.note {
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-muted);
}
</style>
