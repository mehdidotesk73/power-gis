<script setup lang="ts">
// Hover card that follows the pointer inside the map. Content is a title
// plus label/value rows, or whatever the default slot renders.
import { computed } from 'vue'

const props = defineProps<{ x: number; y: number; title: string; rows?: { label: string; value: string }[] }>()
// Flip to the left/top near the right/bottom edges so it stays on-screen.
const style = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
  transform: `translate(${props.x > 260 ? 'calc(-100% - 12px)' : '12px'}, ${props.y > 160 ? 'calc(-100% - 12px)' : '12px'})`,
}))
</script>

<template>
  <div class="tip" :style="style">
    <div class="tip-title">{{ title }}</div>
    <slot>
      <div v-for="r in rows" :key="r.label" class="tip-row">
        <span class="tip-label">{{ r.label }}</span>
        <span>{{ r.value }}</span>
      </div>
    </slot>
  </div>
</template>

<style scoped>
.tip {
  position: absolute;
  z-index: 6;
  pointer-events: none;
  max-width: 17rem;
  background: var(--overlay-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  box-shadow: var(--shadow);
  padding: 0.4rem 0.55rem;
  font-size: 0.78rem;
  line-height: 1.35;
}
.tip-title {
  font-weight: 600;
  margin-bottom: 0.15rem;
}
.tip-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
.tip-label {
  color: var(--text-muted);
}
</style>
