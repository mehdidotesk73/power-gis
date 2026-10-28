<script setup lang="ts">
// The account window (☰ → Sign in / Account). Signed out: sign in, create an
// account, or get a password-reset email. Signed in: your profile — name,
// change password, sign out. Opened from a reset email: choose a new password.
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/UiButton.vue'
import {
  auth,
  changePassword,
  deleteAccount,
  MIN_PASSWORD,
  sendPasswordReset,
  setNewPassword,
  signIn,
  signOut,
  signUp,
  updateDisplayName,
} from '../../client/auth'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

type Pane = 'signin' | 'signup' | 'forgot'
const pane = ref<Pane>('signin')
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
/** What just happened, said once (an email sent, a password changed). */
const notice = ref('')

const view = computed(() => (auth.recovering && auth.user ? 'recover' : auth.user ? 'profile' : pane.value))

function go(p: Pane) {
  pane.value = p
  error.value = ''
  notice.value = ''
}

async function run(action: () => Promise<string | null>, done?: string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  const msg = await action()
  busy.value = false
  if (msg) error.value = msg
  else if (done) notice.value = done
  return !msg
}

// Signed in: the window closes (the menu's dot shows it); your profile is a tap away in ☰.
async function submitSignIn() {
  if (await run(() => signIn(email.value, password.value))) {
    password.value = ''
    close()
  }
}
async function submitSignUp() {
  if (await run(() => signUp(email.value, password.value))) {
    password.value = ''
    pane.value = 'signin'
    notice.value = `Almost there: we sent a link to ${email.value.trim()}. Open it to confirm your email, then sign in.`
  }
}
const submitForgot = () => run(() => sendPasswordReset(email.value), `If ${email.value.trim()} has an account, a reset link is on its way. Open it on this device.`)

// Profile
const name = ref('')
watch(() => auth.profile?.displayName, (n) => (name.value = n ?? ''), { immediate: true })
const saveName = () => run(() => updateDisplayName(name.value), 'Name saved.')

const changing = ref(false)
const current = ref('')
const next = ref('')
const again = ref('')
async function submitChange() {
  if (next.value !== again.value) return void (error.value = "The new passwords don't match.")
  if (await run(() => changePassword(current.value, next.value), 'Password changed.')) {
    current.value = next.value = again.value = ''
    changing.value = false
  }
}
async function submitRecover() {
  if (next.value !== again.value) return void (error.value = "The new passwords don't match.")
  if (await run(() => setNewPassword(next.value), 'New password set. You are signed in.')) next.value = again.value = ''
}
const deleting = ref(false)
const deletePassword = ref('')
async function submitDelete() {
  if (await run(() => deleteAccount(deletePassword.value))) {
    deletePassword.value = ''
    deleting.value = false
    go('signin')
    notice.value = 'Your account is deleted.'
  }
}
async function doSignOut() {
  if (await run(() => signOut())) go('signin')
}

function close() {
  error.value = ''
  notice.value = ''
  emit('close')
}
</script>

<template>
  <div v-if="open" class="backdrop" @click="close">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Account" @click.stop>
      <div class="head">
        <strong>{{ view === 'profile' ? 'Your profile' : view === 'signup' ? 'Create account' : view === 'forgot' ? 'Reset your password' : view === 'recover' ? 'Choose a new password' : 'Sign in' }}</strong>
        <UiButton icon="✕" aria-label="Close" @click="close" />
      </div>

      <p v-if="!auth.ready" class="muted">Checking your sign-in…</p>

      <!-- Signed out -->
      <form v-else-if="view === 'signin'" class="form" @submit.prevent="submitSignIn">
        <label>Email <input v-model="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" required /></label>
        <label>Password <input v-model="password" type="password" autocomplete="current-password" required /></label>
        <UiButton type="submit" tone="primary" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</UiButton>
        <div class="links">
          <button type="button" class="link" @click="go('forgot')">Forgot password?</button>
          <button type="button" class="link" @click="go('signup')">Create account</button>
        </div>
        <div class="about">
          <p><strong>Without an account</strong>, your workspace and datasets stay only in this browser, on this device. Clearing the browser's data, private browsing or a new device starts you over, and browsers may also clear a site's stored data on their own.</p>
          <p><strong>With an account</strong>, Save also keeps your workspace in your account, so it opens on any device you sign in on, and you can store datasets in the cloud to use them there too. <em>Sharing datasets with others comes next.</em></p>
        </div>
      </form>

      <form v-else-if="view === 'signup'" class="form" @submit.prevent="submitSignUp">
        <label>Email <input v-model="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" required /></label>
        <label>Password <input v-model="password" type="password" autocomplete="new-password" :minlength="MIN_PASSWORD" required /></label>
        <p class="muted">At least {{ MIN_PASSWORD }} characters. We'll email you a link to confirm the address.</p>
        <UiButton type="submit" tone="primary" :disabled="busy">{{ busy ? 'Creating it…' : 'Create account' }}</UiButton>
        <div class="links"><button type="button" class="link" @click="go('signin')">I have an account — sign in</button></div>
        <div class="about">
          <p><strong>Without an account</strong>, your workspace and datasets stay only in this browser, on this device. Clearing the browser's data, private browsing or a new device starts you over, and browsers may also clear a site's stored data on their own.</p>
          <p><strong>With an account</strong>, Save also keeps your workspace in your account, so it opens on any device you sign in on, and you can store datasets in the cloud to use them there too. <em>Sharing datasets with others comes next.</em></p>
        </div>
      </form>

      <form v-else-if="view === 'forgot'" class="form" @submit.prevent="submitForgot">
        <label>Email <input v-model="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" required /></label>
        <p class="muted">We'll email a link that opens PowerGIS ready to choose a new password.</p>
        <UiButton type="submit" tone="primary" :disabled="busy">{{ busy ? 'Sending…' : 'Email me a reset link' }}</UiButton>
        <div class="links"><button type="button" class="link" @click="go('signin')">Back to sign in</button></div>
      </form>

      <!-- From a reset email -->
      <form v-else-if="view === 'recover'" class="form" @submit.prevent="submitRecover">
        <p class="muted">Signed in as {{ auth.user?.email }}.</p>
        <label>New password <input v-model="next" type="password" autocomplete="new-password" :minlength="MIN_PASSWORD" required /></label>
        <label>New password again <input v-model="again" type="password" autocomplete="new-password" required /></label>
        <UiButton type="submit" tone="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Set new password' }}</UiButton>
      </form>

      <!-- Signed in -->
      <div v-else class="form">
        <div class="who">
          <span class="muted">Signed in as</span>
          <span class="email">{{ auth.user?.email }}</span>
        </div>
        <form class="row" @submit.prevent="saveName">
          <label class="grow">Display name <input v-model="name" type="text" autocomplete="nickname" maxlength="80" /></label>
          <UiButton type="submit" :disabled="busy || name.trim() === (auth.profile?.displayName ?? '')">Save</UiButton>
        </form>

        <div class="section">
          <UiButton v-if="!changing" @click="(changing = true), (error = ''), (notice = '')">Change password</UiButton>
          <form v-else class="form" @submit.prevent="submitChange">
            <label>Current password <input v-model="current" type="password" autocomplete="current-password" required /></label>
            <label>New password <input v-model="next" type="password" autocomplete="new-password" :minlength="MIN_PASSWORD" required /></label>
            <label>New password again <input v-model="again" type="password" autocomplete="new-password" required /></label>
            <div class="row">
              <UiButton type="submit" tone="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Change password' }}</UiButton>
              <UiButton @click="(changing = false), (current = next = again = ''), (error = '')">Cancel</UiButton>
            </div>
          </form>
        </div>

        <div class="section">
          <UiButton :disabled="busy" @click="doSignOut">Sign out</UiButton>
        </div>

        <div class="section">
          <UiButton v-if="!deleting" tone="danger" @click="(deleting = true), (error = ''), (notice = '')">Delete account</UiButton>
          <form v-else class="form danger-zone" @submit.prevent="submitDelete">
            <p class="warn">This deletes your account, your saved workspaces and the datasets you own — people you shared them with lose them too. Datasets others shared with you stay with them. It can't be undone. Data kept on this device isn't touched.</p>
            <label>Your password <input v-model="deletePassword" type="password" autocomplete="current-password" required /></label>
            <div class="row">
              <UiButton type="submit" tone="danger" :disabled="busy">{{ busy ? 'Deleting…' : 'Delete my account' }}</UiButton>
              <UiButton @click="(deleting = false), (deletePassword = ''), (error = '')">Cancel</UiButton>
            </div>
          </form>
        </div>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
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
  width: min(24rem, 100%);
  max-height: 90dvh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
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
  font-size: 1.05rem;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.82rem;
  color: var(--text-muted);
}
input {
  font-size: 16px; /* below 16px iOS zooms the page on focus */
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text);
}
input:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 0;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}
.grow {
  flex: 1;
  min-width: 0;
}
.links {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.link {
  background: none;
  border: none;
  padding: 0.3rem 0;
  color: var(--accent-blue);
  font-size: 0.85rem;
  cursor: pointer;
}
.who {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.email {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.section {
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}
.about {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev-2);
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--text-muted);
}
.about p {
  margin: 0;
}
.about strong {
  color: var(--text);
}
.danger-zone {
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  background: var(--danger-bg);
}
.warn {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
}
.error,
.notice {
  margin: 0;
  font-size: 0.85rem;
}
.error {
  color: var(--danger);
}
.notice {
  color: var(--ok);
}
</style>
