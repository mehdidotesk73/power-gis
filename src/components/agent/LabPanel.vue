<script setup lang="ts">
// Proof of concept: a scout and a scraper as Anthropic Managed Agents sessions
// (client/agent/managed.ts). Two editable test briefs, a spending cap per run,
// the session's progress live, then its elapsed time, real cost, the report and
// the files it wrote — CSVs import as datasets. Not the final design: the
// assistant will send these itself once the numbers look right.
import { ref } from 'vue'
import UiButton from '../ui/UiButton.vue'
import { confirm, downloadFile, runBrief, traceUrl, type Role, type RunEvent, type RunResult } from '../../client/agent/managed'
import type { AgentHost } from '../../lib/agent/tools'

const props = defineProps<{ apiKey: string; /** The chosen profile's models: the scout's and the scraper's. */ models: Record<Role, string>; host: Pick<AgentHost, 'importCsv'> }>()

const BRIEFS: Record<Role, string> = {
  // A live question: no file to download, the sources' terms and access decide what's possible.
  scout: `The question: how many new job postings went up in each US state over the past 7 days for (a) registered nurses and (b) data scientists, excluding remote jobs. Find where data that can answer this lives.
Consider job boards (LinkedIn, Indeed, Glassdoor, ZipRecruiter, …), job-search APIs and aggregators (Adzuna, USAJobs, Google for Jobs resellers, …) and official statistics (BLS, state labor agencies).
For each candidate: whether it can filter or report by posting date, state, occupation or title, and remote vs on-site; how to access it (API, bulk file, pages), whether it needs a login, an API key or payment; what its terms say about automated access; how fresh it is. Where a public endpoint needs no key, try one small sample query and say what came back. End with the route you'd recommend and what the user would need to provide (a key, an account).`,
  // Each part needs a different way in: an Excel file, a table inside a PDF, a page JavaScript builds.
  scraper: `Make these three tables and save each as a CSV in /mnt/session/outputs/:
1. From https://wsdot.wa.gov/about/transportation-data/travel-data/annual-mileage-and-travel-information, the HPMS Excel file with public road mileage and daily VMT by county, most recent year → wsdot_county_vmt.csv with columns county, year, centerline_miles, lane_miles, daily_vmt (one row per county; no total rows).
2. From Home Depot's most recent annual report PDF (https://ir.homedepot.com/financial-reports/annual-reports/recent), the consolidated statements of earnings → home_depot_earnings.csv with columns fiscal_year, net_sales, gross_profit, operating_income, net_earnings (in millions, one row per fiscal year shown).
3. https://quotes.toscrape.com/js/ (the page is built by JavaScript), pages 1 to 3 → quotes_js.csv with columns page, quote, author, tags (tags joined with "; ").`,
}

const role = ref<Role>('scout')
const briefs = ref({ ...BRIEFS })
const cap = ref(2)
const running = ref(false)
const log = ref<RunEvent[]>([])
const result = ref<RunResult | null>(null)
const error = ref('')
const imported = ref<Record<string, string>>({})
let signal = { stopped: false }

async function run() {
  running.value = true
  error.value = ''
  result.value = null
  log.value = []
  imported.value = {}
  signal = { stopped: false }
  try {
    result.value = await runBrief(props.apiKey, { role: role.value, model: props.models[role.value], brief: briefs.value[role.value], capDollars: cap.value, signal, onEvent: (e) => log.value.push(e) })
  } catch (e) {
    // A failure here before any session is what the test is for: show it whole, with what to do when it's the relay's setup.
    const m = (e as Error).message
    error.value = `${(e as Error).name}: ${m}${relayHint(m)}`
  } finally {
    running.value = false
  }
}

/** The relay (supabase/functions/managed-relay) not deployed yet, or deployed with Verify JWT on. */
const relayHint = (m: string) =>
  /function (was )?not found/i.test(m)
    ? ' — the relay isn’t deployed on Supabase yet (Edge Functions → managed-relay).'
    : /authorization header|invalid jwt/i.test(m)
      ? ' — the relay asks for a Supabase token: turn Verify JWT off for managed-relay.'
      : ''

const sessionOf = () => log.value.find((e) => e.kind === 'status' && e.text.startsWith('Session '))?.text.split(' ')[1]

async function answer(e: RunEvent, allow: boolean) {
  if (!e.id || !e.session) return
  await confirm(props.apiKey, e.session, e.id, allow)
  e.kind = 'tool'
  e.text = `${allow ? 'Allowed' : 'Denied'}: ${e.text}`
}

async function importFile(f: { id: string; name: string }) {
  if (!props.host.importCsv || !result.value) return
  imported.value = { ...imported.value, [f.id]: 'Importing…' }
  try {
    const blob = await downloadFile(props.apiKey, f.id)
    const r = await props.host.importCsv(new File([blob], f.name, { type: 'text/csv' }), `Scraped by the scraper test (session ${result.value.sessionId}). Source: see the session's report.`)
    imported.value = { ...imported.value, [f.id]: r.ok ? 'Imported ✓' : r.message }
  } catch (e) {
    imported.value = { ...imported.value, [f.id]: (e as Error).message }
  }
}

const money = (n?: number) => (n === undefined ? '—' : `$${n.toFixed(2)}`)
const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`)
</script>

<template>
  <section class="lab" data-testid="lab">
    <p class="muted small">
      Test: a <b>scout</b> (looks around, reports) or a <b>scraper</b> (fetches, writes CSVs) runs as a session on Anthropic's servers with
      your key, web access and a spending cap, reached through our relay on Supabase. Model: {{ models[role] }} (the profile's).
    </p>
    <div class="row">
      <label><input v-model="role" type="radio" value="scout" :disabled="running" /> Scout</label>
      <label><input v-model="role" type="radio" value="scraper" :disabled="running" /> Scraper</label>
      <label class="cap">Cap $<input v-model.number="cap" type="number" min="0.1" step="0.5" :disabled="running" /></label>
    </div>
    <textarea v-model="briefs[role]" rows="7" :disabled="running" aria-label="Brief" />
    <div class="row">
      <UiButton data-testid="lab.run" size="compact" tone="primary" :disabled="running || !apiKey || !briefs[role].trim()" @click="run">
        {{ running ? 'Running…' : `Run the ${role} (cap $${cap})` }}
      </UiButton>
      <UiButton v-if="running" size="compact" @click="signal.stopped = true">Stop</UiButton>
      <a v-if="sessionOf()" class="small" :href="traceUrl(sessionOf()!)" target="_blank" rel="noopener">Watch in Anthropic's console ↗</a>
    </div>

    <p v-if="error" class="error small">{{ error }}</p>
    <ol v-if="log.length" class="log">
      <li v-for="(e, i) in log" :key="i" :class="e.kind">
        <template v-if="e.kind === 'ask'">
          {{ e.text }}
          <UiButton size="compact" tone="primary" @click="answer(e, true)">Allow</UiButton>
          <UiButton size="compact" @click="answer(e, false)">Deny</UiButton>
        </template>
        <template v-else>{{ e.kind === 'tool' ? '▸ ' : '' }}{{ e.text }}</template>
      </li>
    </ol>

    <div v-if="result" class="result" data-testid="lab.result">
      <p class="small">
        <b>{{ result.stop }}</b> · {{ result.elapsedSeconds }} s elapsed · {{ result.activeSeconds ?? '—' }} s active · cost {{ money(result.cost) }}
      </p>
      <pre class="report">{{ result.report || '(no final message)' }}</pre>
      <ul v-if="result.files.length" class="files">
        <li v-for="f in result.files" :key="f.id">
          {{ f.name }} · {{ kb(f.bytes) }}
          <UiButton v-if="f.name.endsWith('.csv') && host.importCsv" size="compact" :disabled="!!imported[f.id]" @click="importFile(f)">Import as dataset</UiButton>
          <span v-if="imported[f.id]" class="small">{{ imported[f.id] }}</span>
        </li>
      </ul>
      <p v-else class="muted small">No output files.</p>
    </div>
  </section>
</template>

<style scoped>
.lab {
  display: grid;
  gap: 0.45rem;
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}
.cap input {
  width: 4rem;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
}
.log {
  max-height: 14rem;
  overflow: auto;
  margin: 0;
  padding-left: 1.2rem;
  font-size: var(--chat-fs-xs);
}
.log .tool {
  color: var(--text-muted);
}
.log .error,
.error {
  color: var(--danger);
}
.log .ask {
  color: var(--warn);
}
.report {
  max-height: 18rem;
  overflow: auto;
  white-space: pre-wrap;
  font-size: var(--chat-fs-xs);
  margin: 0;
  padding: 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.files {
  margin: 0;
  padding-left: 1.2rem;
  font-size: var(--chat-fs-sm);
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: var(--chat-fs-xs);
}
</style>
