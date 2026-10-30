<script setup lang="ts">
// A cloud dataset's people: who has access (owner, write, read), sharing it
// with someone by email, changing a level, taking access away, and leaving it.
// What you may do follows your own access (canManage: the database's rules);
// the rest shows, disabled.
import { onMounted, ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import { request } from '../../client/api'
import { canManage, canShare, type Access, type CloudMember } from '../../shared/cloud'

const props = defineProps<{ id: string; name: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'left'): void }>()

const members = ref<CloudMember[]>([])
const mine = ref<Access>()
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const note = ref('')
const email = ref('')
const level = ref<'read' | 'write'>('read')

type Answer = { ok: true; data: { members: CloudMember[]; access?: Access; left?: boolean } } | { ok: false; error: { message: string } }
async function act(run: () => Promise<Answer>, done?: string) {
  busy.value = true
  error.value = ''
  note.value = ''
  const r = await run()
  busy.value = false
  loading.value = false
  if (!r.ok) return void (error.value = r.error.message)
  if (r.data.left) return emit('left')
  members.value = r.data.members
  mine.value = r.data.access
  if (done) note.value = done
}
onMounted(() => act(() => request('datasetMembers', { id: props.id })))

function share() {
  const to = email.value.trim()
  if (!to) return
  void act(() => request('shareDataset', { id: props.id, email: to, access: level.value }), `Shared with ${to} (${level.value}) ✓`).then(() => !error.value && (email.value = ''))
}
const setLevel = (m: CloudMember, access: 'read' | 'write') => act(() => request('setMemberAccess', { id: props.id, userId: m.userId, access }), `${m.name} can ${access === 'write' ? 'push changes' : 'only pull'} now ✓`)
function remove(m: CloudMember) {
  const q = m.you
    ? `Leave "${props.name}"? Your copy stays on this device, local only; you won't get its changes any more.`
    : `Take ${m.name}'s access to "${props.name}" away? Their copies stay on their devices.`
  if (confirm(q)) void act(() => request('removeMember', { id: props.id, userId: m.userId }), m.you ? '' : `${m.name} removed ✓`)
}
const LEVEL: Record<Access, string> = { owner: 'Owner', write: 'Can push', read: 'Can pull' }
</script>

<template>
  <div class="backdrop" @click="!busy && emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" :aria-label="`Share ${name}`" @click.stop>
      <div class="head">
        <strong :title="name">Share “{{ name }}”</strong>
        <UiButton icon="✕" aria-label="Close" :disabled="busy" @click="emit('close')" />
      </div>
      <p class="intro">
        People you share it with add it from ＋ Dataset → Library → In your account, and get a copy of their own linked to it. <b>Can pull</b>: they take your
        changes. <b>Can push</b>: they also send theirs, and can share it too. Owners and pushers can change readers; only the owner changes or
        removes pushers.
      </p>
      <p v-if="loading" class="muted">Loading…</p>
      <ul v-else class="people">
        <li v-for="m in members" :key="m.userId" data-testid="share.member" :data-email="m.email">
          <span class="who">
            <strong class="clip" :title="m.email">{{ m.name }}{{ m.you ? ' (you)' : '' }}</strong>
            <span v-if="m.name !== m.email" class="muted clip">{{ m.email }}</span>
          </span>
          <select
            v-if="m.access !== 'owner'"
            :value="m.access"
            :disabled="busy || !canManage(mine, m).change"
            :title="canManage(mine, m).change ? '' : 'You can’t change this'"
            :aria-label="`${m.name}'s access`"
            @change="setLevel(m, ($event.target as HTMLSelectElement).value as 'read' | 'write')"
          >
            <option value="read">{{ LEVEL.read }}</option>
            <option value="write">{{ LEVEL.write }}</option>
          </select>
          <span v-else class="owner">{{ LEVEL.owner }}</span>
          <UiButton v-if="m.you && m.access !== 'owner'" size="compact" :disabled="busy" @click="remove(m)">Leave</UiButton>
          <UiButton
            v-else-if="m.access !== 'owner'"
            size="compact"
            tone="danger"
            icon="✕"
            :aria-label="`Remove ${m.name}`"
            :title="canManage(mine, m).remove ? `Remove ${m.name}` : 'You can’t remove this person'"
            :disabled="busy || !canManage(mine, m).remove"
            @click="remove(m)"
          />
        </li>
      </ul>
      <form v-if="!loading && mine" class="add" @submit.prevent="share">
        <input
          v-model="email"
          data-testid="share.email"
          type="email"
          placeholder="Their account’s email"
          autocapitalize="off"
          autocomplete="off"
          :disabled="busy || !canShare(mine)"
        />
        <select v-model="level" data-testid="share.level" aria-label="Access" :disabled="busy || !canShare(mine)">
          <option value="read">{{ LEVEL.read }}</option>
          <option value="write">{{ LEVEL.write }}</option>
        </select>
        <UiButton data-testid="share.submit" tone="primary" type="submit" :disabled="busy || !canShare(mine) || !email.trim()">Share</UiButton>
      </form>
      <p v-if="!loading && mine && !canShare(mine)" class="muted">You can pull it: only its owner and people who can push share it.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="note" class="ok">{{ note }}</p>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--backdrop);
}
.sheet {
  width: min(28rem, 100%);
  max-height: 90dvh;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem 1rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.8rem;
  box-shadow: var(--shadow);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 1.05rem;
}
.head strong,
.clip {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
p {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.45;
}
.intro,
.muted {
  color: var(--text-muted);
}
.people {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.people li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev-2);
}
.who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
}
.who .muted {
  font-size: 0.74rem;
}
.owner {
  font-size: 0.8rem;
  color: var(--text-muted);
}
select,
input {
  font: inherit;
  font-size: 16px; /* below 16px iOS zooms the page on focus */
  padding: 0.25rem 0.35rem;
}
.add {
  display: flex;
  gap: 0.4rem;
}
.add input {
  flex: 1;
  min-width: 0;
}
.error {
  color: var(--danger);
}
.ok {
  color: var(--ok);
}
</style>
