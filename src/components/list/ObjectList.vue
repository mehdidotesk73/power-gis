<script setup lang="ts" generic="T">
// A list of objects (datasets, visualizations, transforms…) as cards. The
// page decides what a card shows (the default slot) and which actions its
// menu offers (`actions`); the list owns the gestures. Tap and hold a card
// (right-click with a mouse) for its menu; picking an action emits
// `action(id, item)`. **Reorder** is built in when `reorderable`: it shows a
// ≡ handle on every card, vertically centered, until Done.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDragReorder } from './useDragReorder'
import { useLongPress } from './useLongPress'

export interface ObjectAction {
  id: string
  label: string
  /** A short glyph before the label. */
  icon?: string
  /** Shown in red (delete, remove). */
  danger?: boolean
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    items: T[]
    itemKey: (item: T) => string
    /** The menu for one item, top to bottom. Reorder is added before the first danger action. */
    actions: (item: T) => ObjectAction[]
    reorderable?: boolean
    /** What reordering means here, shown while reordering. */
    reorderHint?: string
    /** Accessible name of an item's menu. */
    itemLabel?: (item: T) => string
    /** Shown above the cards when there are any. */
    hint?: string
  }>(),
  { reorderable: false, reorderHint: 'Drag ≡ to reorder', itemLabel: () => 'Item', hint: 'Tap and hold for options.' },
)
const emit = defineEmits<{ (e: 'action', id: string, item: T): void; (e: 'reorder', ids: string[]): void }>()
defineSlots<{ default(props: { item: T }): unknown }>()

const REORDER: ObjectAction = { id: 'reorder', label: 'Reorder', icon: '≡' }

// ── reorder ────────────────────────────────────────────────────────────────

const listEl = ref<HTMLElement>()
const reordering = ref(false)
const canReorder = computed(() => props.reorderable && props.items.length > 1)
const { dragging, onHandleDown, onHandleUp } = useDragReorder(
  listEl,
  () => props.items.map(props.itemKey),
  (ids) => emit('reorder', ids),
)
function finishReorder() {
  reordering.value = false
  onHandleUp() // a drag whose end the browser never reported still ends here
}
watch(canReorder, (ok) => ok || finishReorder())

// ── the hold menu ──────────────────────────────────────────────────────────

const menuFor = ref<string | null>(null)
let menuEl: HTMLElement | undefined // a function ref: a string ref inside v-for is an array
const { holdHandlers } = useLongPress((id) => {
  if (!reordering.value) menuFor.value = id
})
function menu(item: T): ObjectAction[] {
  const list = props.actions(item)
  if (!canReorder.value) return list
  const at = list.findIndex((a) => a.danger)
  return at < 0 ? [...list, REORDER] : [...list.slice(0, at), REORDER, ...list.slice(at)]
}
function choose(a: ObjectAction, item: T) {
  menuFor.value = null
  if (a.id === REORDER.id) reordering.value = true
  else emit('action', a.id, item)
}
// Any tap outside the open menu, or Escape, closes it.
function outside(e: PointerEvent) {
  if (!menuEl?.contains(e.target as Node)) menuFor.value = null
}
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (menuFor.value = null)
function listen(on: boolean) {
  if (on) {
    // Next tick: the press that opened the menu mustn't close it.
    setTimeout(() => document.addEventListener('pointerdown', outside, true))
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', onKey)
  }
}
watch(menuFor, (id, was) => (!!id !== !!was ? listen(!!id) : undefined))
onBeforeUnmount(() => listen(false))

defineExpose({ reorder: () => canReorder.value && (reordering.value = true) })
</script>

<template>
  <div class="object-list">
    <div v-if="reordering" class="reorder-bar">
      <span class="muted">{{ reorderHint }}</span>
      <button class="done" @click="finishReorder">Done</button>
    </div>
    <p v-else-if="items.length && hint" class="muted hint">{{ hint }}</p>
    <ul ref="listEl" class="list">
      <li
        v-for="item in items"
        :key="itemKey(item)"
        :data-id="itemKey(item)"
        class="card"
        :class="{ dragging: dragging === itemKey(item), held: menuFor === itemKey(item) }"
        v-on="holdHandlers(itemKey(item))"
      >
        <span
          v-if="reordering"
          class="handle"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          @pointerdown="onHandleDown($event, itemKey(item))"
          >≡</span
        >
        <div class="body">
          <slot :item="item" />
        </div>
        <div
          v-if="menuFor === itemKey(item)"
          :ref="(el) => (menuEl = (el as HTMLElement) ?? undefined)"
          class="menu"
          role="menu"
          :aria-label="`${itemLabel(item)} options`"
        >
          <button
            v-for="a in menu(item)"
            :key="a.id"
            role="menuitem"
            :class="{ danger: a.danger }"
            :disabled="a.disabled"
            @click="choose(a, item)"
          >
            <span class="icon">{{ a.icon }}</span>{{ a.label }}
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.card {
  position: relative;
  display: flex;
  align-items: center; /* the ≡ handle sits at the card's vertical middle */
  gap: 0.3rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0.4rem 0.5rem;
  /* Tap and hold opens our menu, not iOS's callout or a text selection. */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  touch-action: pan-y;
}
.card.held {
  border-color: var(--accent-blue);
}
.card.dragging {
  opacity: 0.7;
  border-color: var(--accent-blue);
}
.body {
  flex: 1;
  min-width: 0;
}
/* Forms and tables inside a card behave normally. */
.body :deep(input),
.body :deep(textarea),
.body :deep(table) {
  -webkit-user-select: text;
  user-select: text;
}
.handle {
  align-self: center;
  cursor: grab;
  touch-action: none;
  user-select: none;
  color: var(--text-muted);
  font-size: 1.3rem;
  line-height: 1;
  padding: 0.5rem 0.4rem 0.5rem 0; /* a bigger target than the glyph */
}
.muted {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.hint {
  margin: 0 0 0.35rem;
}
.reorder-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}
.done {
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--accent-blue);
  border-radius: 0.3rem;
  background: var(--accent-blue);
  color: #fff;
  font-size: 0.8rem;
}
.menu {
  position: absolute;
  z-index: 5;
  top: 2rem;
  right: 0.4rem;
  display: grid;
  min-width: 12rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.menu button {
  display: flex;
  gap: 0.5rem;
  text-align: left;
  padding: 0.6rem 0.8rem; /* finger-sized */
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: 0.85rem;
}
.menu button:last-child {
  border-bottom: none;
}
.menu button:disabled {
  opacity: 0.45;
}
.menu .danger {
  color: var(--danger);
}
.menu .icon {
  width: 1rem;
  text-align: center;
}
</style>
