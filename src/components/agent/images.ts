// Screenshots and photos for the assistant: shrunk before sending, since the
// model reads images at up to about 1,500 px on the long edge anyway, and
// smaller images cost fewer tokens (and upload faster from a phone).
import type { ImageInput } from '../../lib/agent/provider'

const MAX_EDGE = 1568
export const MAX_IMAGES = 5

export interface Attached extends ImageInput {
  /** A data URL for thumbnails in the chat. */
  url: string
}

/** An image file (pasted or picked) as a resized JPEG, or an error message. */
export async function prepareImage(file: Blob): Promise<Attached | string> {
  if (!file.type.startsWith('image/')) return 'That file is not an image.'
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return "That image couldn't be read (try a PNG or JPEG)."
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return "That image couldn't be prepared."
  ctx.fillStyle = '#ffffff' // transparent screenshots get a white background in JPEG
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const url = canvas.toDataURL('image/jpeg', 0.88)
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url }
}

/** Image files in a paste (a screenshot copied to the clipboard). */
export function pastedImages(e: ClipboardEvent): File[] {
  const items = [...(e.clipboardData?.items ?? [])]
  return items.flatMap((it) => (it.kind === 'file' && it.type.startsWith('image/') ? [it.getAsFile()].filter((f): f is File => !!f) : []))
}
