<script setup lang="ts" generic="T">
// Type-ahead search over any list. Shows at most `limit` ranked matches in a
// dropdown — instead of a <datalist>, which iOS can't handle with thousands
// of options.
import { computed, ref, watch } from 'vue'
import { search } from '../../lib/search'

const props = withDefaults(
  defineProps<{
    items: T[]
    /** Text matched against the query. */
    text: (item: T) => string
    /** Text the query is matched against, if not `text` (e.g. name + id). */
    match?: (item: T) => string
    /** Secondary line under each result. */
    detail?: (item: T) => string
    placeholder?: string
    label?: string
    limit?: number
    /** Tolerate typos ("elastic" matching). */
    fuzzy?: boolean
    /** Focusing an empty box lists the items (for short lists, like a picker). */
    allWhenEmpty?: boolean
    /** Text to show when not typing (e.g. the current pick); kept in sync. */
    value?: string
  }>(),
  { limit: 12, fuzzy: false, allWhenEmpty: false, value: undefined },
)
const emit = defineEmits<{ (e: 'pick', item: T): void }>()

const query = ref(props.value ?? '')
watch(
  () => props.value,
  (v) => v !== undefined && (query.value = v),
)
const open = ref(false)
const active = ref(0)
// While the box still shows the current pick, list everything (a picker), not just that name.
const typed = computed(() => (props.value !== undefined && query.value === props.value ? '' : query.value))
const results = computed(() => search(props.items, typed.value, props.match ?? props.text, { limit: props.limit, fuzzy: props.fuzzy, allWhenEmpty: props.allWhenEmpty }))

function pick(item: T) {
  query.value = props.text(item)
  open.value = false
  emit('pick', item)
}
function onKey(e: KeyboardEvent) {
  if (!results.value.length) return
  if (e.key === 'ArrowDown') active.value = (active.value + 1) % results.value.length
  else if (e.key === 'ArrowUp') active.value = (active.value - 1 + results.value.length) % results.value.length
  else if (e.key === 'Enter') pick(results.value[active.value])
  else if (e.key === 'Escape') open.value = false
  else return
  e.preventDefault()
}
defineExpose({ clear: () => (query.value = '') })
</script>

<template>
  <div class="search-box">
    <label v-if="label" class="sb-label" :for="`sb-${label}`">{{ label }}</label>
    <input
      :id="`sb-${label}`"
      v-model="query"
      type="search"
      role="combobox"
      :aria-expanded="open && results.length > 0"
      :placeholder="placeholder"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      @input="(open = true), (active = 0)"
      @focus="open = true"
      @blur="(open = false), value !== undefined && (query = value)"
      @keydown="onKey"
    />
    <ul v-if="open && results.length" class="sb-results" role="listbox">
      <li
        v-for="(item, i) in results"
        :key="i"
        role="option"
        :aria-selected="i === active"
        :class="{ active: i === active }"
        @mousedown.prevent="pick(item)"
      >
        <span class="sb-main">{{ text(item) }}</span>
        <span v-if="detail" class="sb-detail">{{ detail(item) }}</span>
      </li>
    </ul>
    <div v-else-if="open && query.trim() && !results.length" class="sb-results sb-empty">No matches</div>
  </div>
</template>

<style scoped>
.search-box {
  position: relative;
}
.sb-label {
  font-weight: 600;
  display: block;
  margin-bottom: 0.25rem;
}
input {
  width: 100%;
  padding: 0.5rem;
  font-size: 1rem; /* ≥16px stops iOS zooming on focus */
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-input);
  color: var(--text);
}
.sb-results {
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  top: calc(100% + 0.2rem);
  margin: 0;
  padding: 0.2rem 0;
  list-style: none;
  max-height: 18rem;
  overflow: auto;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  box-shadow: var(--shadow);
}
.sb-results li {
  display: grid;
  padding: 0.45rem 0.6rem;
  cursor: pointer;
}
.sb-results li.active,
.sb-results li:hover {
  background: color-mix(in srgb, var(--accent-blue) 18%, var(--bg-elev-2));
}
.sb-main {
  font-size: 0.9rem;
}
.sb-detail {
  font-size: 0.74rem;
  color: var(--text-muted);
}
.sb-empty {
  padding: 0.5rem 0.6rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}
</style>
