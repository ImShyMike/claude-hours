// What the dashboard pages work from: the person's events, fetched now and
// every 30 s, who's looking, and a tick for redrawing charts on a theme flip
import type { Event } from '../analytics/aggregate'
import { api, load, save, type Me } from './shared'

const REFRESH_MS = 30_000

// undefined until the first fetch, so nothing claims the log is empty early
export function liveEvents() {
  const live = $state<{ events?: Event[] }>({})
  $effect(() => {
    const refresh = async () => {
      try {
        live.events = await api<Event[]>('/api/events')
      } catch (err) {
        console.error('could not load events', err)
        live.events ??= []
      }
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  })
  return live
}

export function whoIsLooking() {
  const who = $state<{ me: Me }>({ me: {} })
  $effect(() => {
    api<Me>('/api/me')
      .then(me => (who.me = me))
      .catch(() => {})
  })
  return who
}

// a setting kept in localStorage, as the old dashboard kept it
export function stored<T extends string>(key: string, fallback: T) {
  const setting = $state({ value: load<T>(key, fallback) })
  $effect(() => save(key, setting.value))
  return setting
}

// the charts read their colors when drawn, so they redraw when .dark flips
let theme = $state(0)
let watching = false
export function themeTick() {
  if (!watching && typeof document !== 'undefined') {
    watching = true
    new MutationObserver(() => theme++).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return theme
}
