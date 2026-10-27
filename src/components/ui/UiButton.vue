<script setup lang="ts">
// The app's button. One component so every button sizes its icon and label
// together, with little padding around them:
//   size  tag      — pills: ＋ Dataset, Visible / Hidden, ↻ Run all stale
//         compact  — header controls: Workspace, Assistant
//         regular  — tool buttons: ⤢ open in a window, ⚙, ✕ (the default)
//         large    — a scaled-up regular, for a page's main action
//   tone  colors by job (vars.css): neutral, primary (blue: the action),
//         dataset / transform / viz (kinds), attention (amber, with a mark),
//         ok (green), danger (red)
// An `icon` with no label makes a square button; give it an aria-label.
withDefaults(
  defineProps<{
    size?: 'tag' | 'compact' | 'regular' | 'large'
    tone?: 'neutral' | 'primary' | 'dataset' | 'transform' | 'viz' | 'attention' | 'ok' | 'danger'
    /** A glyph before the label, drawn larger than the text (glyphs render small). */
    icon?: string
    /** On / selected (toggles): filled with the tone. */
    active?: boolean
    type?: 'button' | 'submit'
  }>(),
  { size: 'regular', tone: 'neutral', type: 'button' },
)
defineSlots<{ default?(): unknown }>()
</script>

<template>
  <button :type="type" class="ui-btn" :class="[`sz-${size}`, `t-${tone}`, { active, square: !!icon && !$slots.default }]">
    <span v-if="icon" class="glyph" aria-hidden="true">{{ icon }}</span>
    <span v-if="$slots.default" class="label"><slot /></span>
  </button>
</template>

<style scoped>
.ui-btn {
  --c: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3em;
  box-sizing: border-box;
  border: 1px solid var(--border-strong);
  background: var(--bg-elev-2);
  color: var(--c);
  font-family: inherit;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.glyph {
  font-size: 1.35em; /* symbol glyphs draw small next to letters */
  line-height: 1;
}
.label {
  line-height: 1.1;
}

/* sizes: text and glyph scale together; padding stays tight */
.sz-tag {
  height: 1.45rem;
  padding: 0 0.5rem;
  border-radius: 1rem;
  font-size: 0.7rem;
}
.sz-compact {
  height: 1.9rem;
  padding: 0 0.55rem;
  border-radius: 0.4rem;
  font-size: 0.8rem;
}
.sz-regular {
  height: 2.3rem;
  padding: 0 0.7rem;
  border-radius: 0.45rem;
  font-size: 0.92rem;
}
.sz-large {
  height: 2.8rem;
  padding: 0 0.9rem;
  border-radius: 0.55rem;
  font-size: 1.08rem;
}
.square {
  padding: 0;
  aspect-ratio: 1;
}
.square .glyph {
  font-size: 1.45em;
}

/* tones */
.t-neutral {
  --c: var(--text-muted);
}
.t-neutral:not(:disabled):hover,
.t-neutral.active {
  --c: var(--text);
  border-color: var(--accent-blue);
}
.t-primary {
  border-color: var(--accent-blue);
  background: var(--accent-blue);
  --c: var(--on-accent);
}
.t-dataset {
  --k: var(--kind-dataset);
}
.t-transform {
  --k: var(--kind-transform);
}
.t-viz {
  --k: var(--kind-viz);
}
.t-attention {
  --k: var(--warn);
}
.t-ok {
  --k: var(--ok);
}
.t-danger {
  --k: var(--danger);
}
.t-dataset,
.t-transform,
.t-viz,
.t-attention,
.t-ok,
.t-danger {
  --c: var(--k);
  border-color: var(--k);
  background: color-mix(in srgb, var(--k) 12%, transparent);
}
:is(.t-dataset, .t-transform, .t-viz, .t-attention, .t-ok, .t-danger):not(:disabled):hover,
:is(.t-dataset, .t-transform, .t-viz, .t-attention, .t-ok, .t-danger).active {
  background: color-mix(in srgb, var(--k) 24%, transparent);
}
.ui-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.ui-btn:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}
</style>
