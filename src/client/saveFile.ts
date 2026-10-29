// Saving a file the app made (a workspace zip, an export, a picture). On a
// phone it goes through the share sheet (Save to Files, AirDrop, …): iOS
// Safari's own download of a link-clicked blob leaves the page ignoring taps
// for the clipboard and file pickers until it reloads (Copy, Paste and Load
// stopped working after a Download). Elsewhere, a plain download.

/** Phones and tablets that can share files: they get the share sheet. */
const shareFirst = () => typeof navigator.share === 'function' && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/**
 * Saves `blob` as `name`. Call it straight from the tap (the share sheet needs
 * one). Resolves to what happened; `cancelled` when the person closed the sheet.
 */
export async function saveFile(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (shareFirst()) {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] })
        return 'shared'
      } catch (e) {
        if ((e as Error).name === 'AbortError') return 'cancelled'
        // Not allowed here (no tap left to share from, say): download it after all.
      }
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  return 'downloaded'
}
