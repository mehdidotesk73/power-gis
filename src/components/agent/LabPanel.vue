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

const props = defineProps<{ apiKey: string; model: string; host: Pick<AgentHost, 'importCsv'> }>()

const BRIEFS: Record<Role, string> = {
  scout: `Look, without extracting anything, at what these two pages publish and how:
1. https://wsdot.wa.gov/about/transportation-data/travel-data/annual-mileage-and-travel-information (Washington State DOT mileage and travel data)
2. https://ir.homedepot.com/financial-reports/annual-reports/recent (Home Depot annual reports)
For each: the datasets or tables offered, their format (HTML table, CSV, Excel, PDF), rough shape (columns, rows), years covered, how to get them, and terms of use.`,
  scraper: `Fetch these two tables and save each as a CSV in /mnt/session/outputs/:
1. https://files.zillowstatic.com/research/public_csvs/zhvi/County_zhvi_uc_condo_tier_0.33_0.67_sm_sa_month.csv → zillow_county_condo.csv, reshaped long: one row per county and month, columns fips (5-digit text, from StateCodeFIPS + MunicipalCodeFIPS), county, state, month (YYYY-MM-DD), zhvi.
2. The Census ACS 5-year 2022 median household income per county (variable B19013_001E) from https://api.census.gov/data/2022/acs/acs5?get=NAME,B19013_001E&for=county:* → census_county_income.csv with columns fips (5-digit text), name, median_hh_income.`,
}

const role = ref<Role>('scout')
const briefs = ref({ ...BRIEFS })
const cap = ref(1)
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
    result.value = await runBrief(props.apiKey, { role: role.value, model: props.model, brief: briefs.value[role.value], capDollars: cap.value, signal, onEvent: (e) => log.value.push(e) })
  } catch (e) {
    // A failure here before any session (e.g. the browser can't reach these endpoints) is what the test is for: show it whole.
    error.value = `${(e as Error).name}: ${(e as Error).message}`
  } finally {
    running.value = false
  }
}

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
      your key, web access and a spending cap. Model: {{ model }}.
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
  font-size: 16px; /* below 16px iOS zooms the page on focus */
}
.log {
  max-height: 14rem;
  overflow: auto;
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.74rem;
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
  font-size: 0.76rem;
  margin: 0;
  padding: 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.files {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.8rem;
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 0.74rem;
}
</style>
