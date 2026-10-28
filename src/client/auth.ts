// The signed-in account: who you are, and the actions on your own account
// (sign up / in / out, reset and change password, display name). This is the
// client's own state, like the assistant's API key: the session lives in this
// browser (localStorage `powergis.auth`). Data — datasets, workspaces — still
// goes through the server's requests; it will carry this session to Supabase.
//
// Every action answers `null` on success or a message to show; nothing throws.
import { reactive } from 'vue'
import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { logDebug } from '../debug'

export interface Profile {
  id: string
  email: string
  displayName: string
}

export const MIN_PASSWORD = 8

export const auth = reactive({
  /** false until the stored session (or a link's) has been read */
  ready: false,
  user: null as User | null,
  profile: null as Profile | null,
  /** opened from a password-reset email: the next step is choosing a new password */
  recovering: false,
})

// A reset link lands here with `type=recovery` in the address; note it before
// Supabase reads the link and tidies the address.
if (typeof location !== 'undefined' && /[#&?]type=recovery\b/.test(location.hash + location.search)) auth.recovering = true

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') auth.recovering = true
  const user = session?.user ?? null
  const changed = user?.id !== auth.user?.id
  auth.user = user
  auth.ready = true
  if (!user) auth.profile = null
  // Not awaited inside the callback: Supabase calls back while it holds its lock.
  else if (changed || !auth.profile) setTimeout(() => void loadProfile(), 0)
})

/** Where links in our emails come back to: this app, on whichever site (production or a preview). */
const here = () => `${location.origin}${location.pathname}`

function fail(what: string, error: { message: string } | null | undefined): string | null {
  if (!error) return null
  logDebug(`Account: ${what} failed — ${error.message}`, 'warn')
  return friendly(error.message)
}

/** Supabase's messages, said plainly where they aren't already. */
function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Wrong email or password.'
  if (/email not confirmed/i.test(message)) return 'Confirm your email first: open the link we sent you.'
  if (/already registered|already been registered/i.test(message)) return 'That email already has an account. Sign in instead.'
  if (/rate limit/i.test(message)) return 'Too many emails sent just now. Try again in a little while.'
  if (/different from the old/i.test(message)) return 'Pick a password different from your current one.'
  return message
}

async function loadProfile() {
  const id = auth.user?.id
  if (!id) return
  const { data, error } = await supabase.from('profiles').select('id, email, display_name').eq('id', id).maybeSingle()
  if (error) return void fail('loading your profile', error)
  if (auth.user?.id !== id) return
  auth.profile = data
    ? { id: data.id, email: data.email, displayName: data.display_name }
    : { id, email: auth.user.email ?? '', displayName: '' }
}

/** Make an account; the email gets a confirmation link back to this app. */
export async function signUp(email: string, password: string): Promise<string | null> {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: here() } })
  if (error) return fail('sign up', error)
  // An existing, confirmed email answers with a user that has no identities (Supabase hides which emails exist).
  if (data.user && !data.user.identities?.length) return 'That email already has an account. Sign in instead.'
  return null
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  return fail('sign in', error)
}

export async function signOut(): Promise<string | null> {
  const { error } = await supabase.auth.signOut()
  auth.recovering = false
  return fail('sign out', error)
}

/** Email a link that opens this app ready to choose a new password. */
export async function sendPasswordReset(email: string): Promise<string | null> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: here() })
  return fail('sending the reset email', error)
}

/** Set a new password after following a reset link (no current password: the link proved who you are). */
export async function setNewPassword(password: string): Promise<string | null> {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  const { error } = await supabase.auth.updateUser({ password })
  if (!error) auth.recovering = false
  return fail('setting the new password', error)
}

/** Change the password from the profile: the current one is checked first. */
export async function changePassword(current: string, next: string): Promise<string | null> {
  const email = auth.user?.email
  if (!email) return 'Sign in first.'
  if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  const check = await supabase.auth.signInWithPassword({ email, password: current })
  if (check.error) return /invalid login credentials/i.test(check.error.message) ? 'Your current password is wrong.' : fail('checking your password', check.error)
  const { error } = await supabase.auth.updateUser({ password: next })
  return fail('changing the password', error)
}

/**
 * Delete the account: the password is checked first, then the database deletes
 * the datasets you own (people you shared them with lose them too), your
 * workspaces and the account (supabase/002_delete_account.sql).
 */
export async function deleteAccount(password: string): Promise<string | null> {
  const email = auth.user?.email
  if (!email) return 'Sign in first.'
  const check = await supabase.auth.signInWithPassword({ email, password })
  if (check.error) return /invalid login credentials/i.test(check.error.message) ? 'Your password is wrong.' : fail('checking your password', check.error)
  // Cloud datasets' files go first once they exist (PR 3): storage deletes go through its API.
  const { error } = await supabase.rpc('delete_my_account')
  if (error) return fail('deleting the account', error)
  // The account is gone on the server; forget the session here.
  await supabase.auth.signOut({ scope: 'local' })
  auth.user = null
  auth.profile = null
  auth.recovering = false
  return null
}

export async function updateDisplayName(name: string): Promise<string | null> {
  const id = auth.user?.id
  if (!id) return 'Sign in first.'
  const displayName = name.trim()
  const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', id)
  if (error) return fail('saving your name', error)
  if (auth.profile) auth.profile.displayName = displayName
  return null
}

/** What to call the signed-in person. */
export const shownName = () => auth.profile?.displayName || auth.user?.email || ''
