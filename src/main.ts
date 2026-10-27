import { createApp } from 'vue'
import App from './App.vue'
import { installErrorCapture } from './debug'
import './styles/vars.css'

const app = createApp(App)

// Before mount, so a crash during the first render still reaches the log panel.
installErrorCapture(app)

// "Reload latest" navigates with a `?fresh=<ts>` cache-buster to get past the
// service-worker and HTTP caches. Tidy it out of the URL once loaded.
try {
  const url = new URL(window.location.href)
  if (url.searchParams.has('fresh')) {
    url.searchParams.delete('fresh')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
} catch {
  // Non-fatal — a stray query param is harmless.
}

// iOS Safari zooms the whole page into any text field under 16px when it's tapped, and doesn't
// zoom back. maximum-scale=1 stops that on iOS (two-finger pinch zoom still works there); it's
// left off elsewhere, where it would block pinch zoom and there's no focus zoom to stop.
if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  const vp = document.querySelector('meta[name="viewport"]')
  if (vp && !/maximum-scale/.test(vp.getAttribute('content') ?? '')) vp.setAttribute('content', `${vp.getAttribute('content')}, maximum-scale=1`)
}

app.mount('#app')
