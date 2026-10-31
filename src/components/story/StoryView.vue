<script setup lang="ts">
// A story, open: its scenes one after another, each a title, a narrative and
// its figures (drawn from their code). Edit turns the title and narratives into
// text boxes; Save edits keeps them in the workspace draft (Save keeps it).
import { computed, ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import StoryFigure from './StoryFigure.vue'
import { NARRATIVE_WORDS, readSeconds, words, type Scene, type Story } from '../../lib/story/story'
import type { DatasetRecord } from '../../shared/records'

const props = defineProps<{
  story: Story
  records: Map<string, DatasetRecord>
  /** A scene's subject by name ("dataset Clean county income"), if it's still in the workspace. */
  aboutName: (about: NonNullable<Scene['about']>) => string | undefined
}>()
const emit = defineEmits<{ (e: 'update', s: Story): void; (e: 'rewrite'): void; (e: 'close'): void }>()

const editing = ref(false)
const name = ref('')
const narratives = ref<string[]>([])
function edit() {
  name.value = props.story.name
  narratives.value = props.story.scenes.map((s) => s.narrative)
  editing.value = true
}
function save() {
  emit('update', { ...props.story, name: name.value.trim() || props.story.name, scenes: props.story.scenes.map((s, i) => ({ ...s, narrative: narratives.value[i].trim() || s.narrative })) })
  editing.value = false
}
const total = computed(() => props.story.scenes.reduce((t, s) => t + readSeconds(s.narrative), 0))
const written = computed(() => new Date(props.story.writtenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))

/** Escaped text with **bold**, *italic*, paragraphs and "- " lists; nothing else becomes HTML. */
function format(text: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (t: string) => esc(t).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`
      return `<p>${lines.map(inline).join(' ')}</p>`
    })
    .join('')
}
</script>

<template>
  <article class="story" data-testid="story.view" :data-name="story.name">
    <header>
      <span class="eyebrow">Story</span>
      <input v-if="editing" v-model="name" class="title-input" aria-label="Story title" />
      <h2 v-else>{{ story.name }}</h2>
      <p class="muted small">{{ story.scenes.length }} scenes · about {{ Math.max(1, Math.round(total / 60)) }} min to read · written {{ written }}</p>
      <div class="actions">
        <template v-if="editing">
          <UiButton size="compact" tone="primary" data-testid="story.save" @click="save">Save edits</UiButton>
          <UiButton size="compact" @click="editing = false">Cancel</UiButton>
        </template>
        <template v-else>
          <UiButton size="compact" icon="✎" data-testid="story.edit" @click="edit">Edit</UiButton>
          <UiButton size="compact" icon="↻" title="The storyteller writes it again (the assistant panel opens)" @click="emit('rewrite')">Rewrite</UiButton>
          <UiButton size="compact" icon="✕" aria-label="Close the story" @click="emit('close')" />
        </template>
      </div>
    </header>

    <section v-for="(s, i) in story.scenes" :key="s.id" class="scene" data-testid="story.scene">
      <h3><span class="n">{{ i + 1 }}</span> {{ s.title }}</h3>
      <p v-if="s.about && aboutName(s.about)" class="about muted small">{{ aboutName(s.about) }}</p>
      <template v-if="editing">
        <textarea v-model="narratives[i]" rows="5" :aria-label="`Narrative of scene ${i + 1}`" />
        <p class="muted small" :class="{ over: words(narratives[i]) > NARRATIVE_WORDS * 1.25 }">{{ words(narratives[i]) }} words · about {{ readSeconds(narratives[i]) }} s read aloud</p>
      </template>
      <div v-else class="narrative" v-html="format(s.narrative)" />
      <StoryFigure v-for="(f, j) in s.figures" :key="j" :figure="f" :records="records" />
    </section>
  </article>
</template>

<style scoped>
.story {
  display: grid;
  gap: 1.1rem;
}
header {
  display: grid;
  gap: 0.25rem;
}
h2 {
  margin: 0;
  font-size: 1.15rem;
}
.title-input {
  font: inherit;
  font-size: 1.05rem;
  font-weight: 600;
}
.actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.scene {
  display: grid;
  gap: 0.5rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--border);
}
h3 {
  margin: 0;
  font-size: 0.98rem;
  display: flex;
  gap: 0.45rem;
  align-items: baseline;
}
.n {
  flex: none;
  min-width: 1.4rem;
  height: 1.4rem;
  display: inline-grid;
  place-items: center;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 0.72rem;
  color: var(--text-muted);
}
.about {
  margin: -0.3rem 0 0;
}
.narrative {
  line-height: 1.5;
  font-size: 0.92rem;
}
.narrative :deep(p) {
  margin: 0 0 0.5rem;
}
.narrative :deep(ul) {
  margin: 0 0 0.5rem;
  padding-left: 1.2rem;
}
textarea {
  font: inherit;
  font-size: 0.9rem;
  width: 100%;
  box-sizing: border-box;
}
.over {
  color: var(--accent-amber);
}
.small {
  font-size: 0.74rem;
  margin: 0;
}
</style>
