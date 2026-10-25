// Asks the server how a dataset looks under a binding (features, unmatched
// rows, defaults), re-asking as the binding changes. Cached per session.
import { ref, watch, type Ref } from 'vue'
import { request } from '../../client/api'
import type { GeometryBinding } from '../../lib/dataset/binding'
import type { BindingInfo } from '../../lib/dataset/query'

const cache = new Map<string, Promise<BindingInfo | string>>()

/** The server's answer, or an error message. */
export function describeBinding(datasetId: string, binding: GeometryBinding): Promise<BindingInfo | string> {
  const key = `${datasetId}|${JSON.stringify(binding)}`
  let p = cache.get(key)
  if (!p) {
    p = request('describeBinding', { datasetId, binding }).then((r) => (r.ok ? r.data : r.error.message))
    cache.set(key, p)
    p.then((r) => typeof r === 'string' && cache.delete(key))
  }
  return p
}
/** Forget answers for a dataset whose table changed. */
export function forgetBindingInfo(datasetId: string) {
  for (const k of cache.keys()) if (k.startsWith(`${datasetId}|`)) cache.delete(k)
}

export function useBindingInfo(datasetId: () => string | undefined, binding: () => GeometryBinding | null | undefined) {
  const info: Ref<BindingInfo | null> = ref(null)
  const error = ref('')
  const loading = ref(false)
  let seq = 0
  watch(
    () => [datasetId(), JSON.stringify(binding() ?? null)] as const,
    async ([id]) => {
      const b = binding()
      const mine = ++seq
      info.value = null
      error.value = ''
      if (!id || !b) return
      loading.value = true
      const r = await describeBinding(id, b)
      if (mine !== seq) return
      loading.value = false
      if (typeof r === 'string') error.value = r
      else info.value = r
    },
    { immediate: true },
  )
  return { info, error, loading }
}
