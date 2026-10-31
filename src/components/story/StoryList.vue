<script setup lang="ts">
// The workspace's stories as cards (open, rewrite, rename, delete), and ＋ Story:
// pick the visualizations to tell (the ones picked in the graph or lists start
// ticked), then the request goes into the assistant's chat (tell_story). An open story
// shows where editors open (the page's right column in setup on desktop).
import { computed, ref } from 'vue'
import ObjectList, { type ObjectAction } from '../list/ObjectList.vue'
import UiButton from '../ui/UiButton.vue'
import StoryView from './StoryView.vue'
import { useDetailTarget } from '../detailTarget'
import { vReveal } from '../reveal'
import type { Scene, Story } from '../../lib/story/story'
import type { VisualizationSpec } from '../../lib/dataset/visualization'
import type { DatasetRecord } from '../../shared/records'

const props = defineProps<{
  stories: Story[]
  visualizations: VisualizationSpec[]
  records: Map<string, DatasetRecord>
  /** Visualizations picked in the graph or lists (ticked when ＋ Story opens). */
  picked: string[]
  aboutName: (about: NonNullable<Scene['about']>) => string | undefined
  /** Shown under the graph: no add button or hint. */
  compact?: boolean
}>()
const emit = defineEmits<{
  (e: 'tell', visualizationIds: string[], rewrite?: Story): void
  (e: 'update', s: Story): void
  (e: 'remove', id: string): void
}>()

const detailTarget = useDetailTarget()
const openId = ref<string | null>(null)
const open = computed(() => props.stories.find((s) => s.id === openId.value) ?? null)

// ── ＋ Story ────────────────────────────────────────────────────────────────

const adding = ref(false)
const chosen = ref<string[]>([])
function startAdd() {
  chosen.value = props.picked.filter((id) => props.visualizations.some((v) => v.id === id))
  adding.value = true
}
function tell() {
  emit('tell', props.visualizations.filter((v) => chosen.value.includes(v.id)).map((v) => v.id))
  adding.value = false
}

// ── the cards ──────────────────────────────────────────────────────────────

const gone = (s: Story) => s.visualizationIds.filter((id) => !props.visualizations.some((v) => v.id === id)).length
const actions = (s: Story): ObjectAction[] => [
  { id: 'open', icon: '▤', label: openId.value === s.id ? 'Close' : 'Open' },
  { id: 'rewrite', icon: '↻', label: 'Rewrite', disabled: gone(s) === s.visualizationIds.length },
  { id: 'rename', icon: '✎', label: 'Rename' },
  { id: 'delete', icon: '✕', label: 'Delete', danger: true },
]
function onAction(id: string, s: Story) {
  if (id === 'open') openId.value = openId.value === s.id ? null : s.id
  else if (id === 'rewrite') rewrite(s)
  else if (id === 'rename') {
    const name = prompt('Story title', s.name)?.trim()
    if (name) emit('update', { ...s, name })
  } else if (id === 'delete') {
    if (openId.value === s.id) openId.value = null
    emit('remove', s.id)
  }
}
const rewrite = (s: Story) => emit('tell', s.visualizationIds.filter((id) => props.visualizations.some((v) => v.id === id)), s)
const when = (s: Story) => new Date(s.writtenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
defineExpose({ open: (id: string) => (openId.value = id) })
</script>

<template>
  <div class="stories">
    <UiButton v-if="!compact" size="tag" tone="primary" icon="＋" class="add" data-testid="story.add" :disabled="!visualizations.length" @click="startAdd">Story</UiButton>
    <div v-if="adding" v-reveal class="pick" data-testid="story.pick">
      <p class="small">Which visualizations should the story tell? It walks from their starting data to these maps.</p>
      <label v-for="v in visualizations" :key="v.id" class="choice">
        <input v-model="chosen" type="checkbox" :value="v.id" :data-testid="`story.pick.${v.name}`" />
        {{ v.name }}
      </label>
      <div class="row">
        <UiButton size="compact" tone="primary" data-testid="story.tell" :disabled="!chosen.length" @click="tell">Tell the story</UiButton>
        <UiButton size="compact" @click="adding = false">Cancel</UiButton>
      </div>
      <p class="muted small">It goes into your assistant chat, which hands it to the storyteller (your Anthropic key; its model is set by the profile in ⚙). It reads your data but changes nothing else.</p>
    </div>
    <p v-if="!stories.length && !compact && !adding" class="muted small">No stories yet. A story walks from the starting data, through each step, to the maps.</p>
    <ObjectList
      :items="stories"
      :item-key="(s) => s.id"
      :item-label="(s) => s.name"
      test-kind="story"
      :actions="actions"
      :hint="compact ? '' : 'Tap and hold a story for options; double-tap to open it.'"
      @action="onAction"
      @open="(s) => (openId = s.id)"
    >
      <template #default="{ item: s }">
        <div>
          <strong>{{ s.name }}</strong>
          <span class="muted small line">{{ s.scenes.length }} scenes · {{ when(s) }}</span>
          <span v-if="gone(s)" class="problem small line">⚠ {{ gone(s) }} of its visualizations {{ gone(s) === 1 ? 'is' : 'are' }} no longer in the workspace</span>
        </div>
        <Teleport defer :to="detailTarget ?? 'body'" :disabled="!!compact || !detailTarget">
          <div v-if="open && open.id === s.id" v-reveal :class="{ aside: detailTarget && !compact }" data-no-open>
            <StoryView :story="open" :records="records" :about-name="aboutName" @update="(n) => emit('update', n)" @rewrite="rewrite(open)" @close="openId = null" />
          </div>
        </Teleport>
      </template>
    </ObjectList>
  </div>
</template>

<style scoped>
.stories {
  display: grid;
  gap: 0.45rem;
}
.add {
  justify-self: start;
}
.pick {
  display: grid;
  gap: 0.35rem;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.choice {
  display: flex;
  gap: 0.45rem;
  align-items: center;
  font-size: 0.85rem;
}
.row {
  display: flex;
  gap: 0.4rem;
}
.line {
  display: block;
}
.small {
  font-size: 0.74rem;
  margin: 0;
}
.problem {
  color: var(--danger);
}
</style>
