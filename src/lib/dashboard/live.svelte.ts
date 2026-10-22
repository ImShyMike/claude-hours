// What the dashboard pages work from: the person's events, fetched now and
// every 30 s, who's looking, and a tick for redrawing charts on a theme flip
import { page } from '$app/state'
import type { Event } from '../analytics/aggregate'
import { api, load, save, type Me } from './shared'

const REFRESH_MS = 30_000

// The last answers by ?person, so moving between the overview and the
// timeline shows what's already here while it refreshes
const eventsCache = new Map<string, Event[]>()
const meCache = new Map<string, Me>()

// undefined until the first fetch, so nothing claims the log is empty early;
// refetched when an admin switches whose dashboard it is
export function liveEvents() {
  const live = $state<{ events?: Event[] }>({})
  $effect(() => {
    const person = page.url.searchParams.get('person') ?? ''
    let stale = false
    live.events = eventsCache.get(person)
    const refresh = async () => {
      try {
        const events = await api<Event[]>('/api/events')
        if (stale) return
        eventsCache.set(person, events)
        live.events = events
      } catch (err) {
        console.error('could not load events', err)
        if (!stale) live.events ??= []
      }
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      stale = true
      clearInterval(timer)
    }
  })
  return live
}

export function whoIsLooking() {
  const who = $state<{ me: Me }>({ me: {} })
  $effect(() => {
    const person = page.url.searchParams.get('person') ?? ''
    let stale = false
    who.me = meCache.get(person) ?? who.me
    api<Me>('/api/me')
      .then(me => {
        meCache.set(person, me)
        if (!stale) who.me = me
      })
      .catch(() => {})
    return () => (stale = true)
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
