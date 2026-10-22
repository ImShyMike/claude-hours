// What the dashboard pages work from: the hub's summaries, fetched now and
// every 30 s, who's looking, and a tick for redrawing charts on a theme flip
import { page } from '$app/state'
import type { Event } from '../analytics/aggregate'
import type { Timeline } from '../analytics/replay'
import type { Digest } from '../server/digest'
import { api, load, rangeWindow, save, type Me, type Range } from './shared'

export type { Digest }
export type SessionDigest = { events: Event[]; projects: Digest['projects']; idleCapMs: number; timelines: Timeline[] }

const REFRESH_MS = 30_000

// the viewer's time zone, which the hub counts days and hours in
export const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// The last answers by ?person and key, so moving between the overview and
// the timeline shows what's already here while it refreshes
const answers = new Map<string, unknown>()
const meCache = new Map<string, Me>()

// What the hub answers for a key, fetched now and every 30 s. undefined
// until the first answer, so nothing claims the log is empty early; asked
// again when the key changes or an admin switches whose dashboard it is.
// path is worked out on every fetch, so a range ending now moves with now
function polled<T>(key: () => string | undefined, path: (key: string) => string) {
  const live = $state<{ value?: T }>({})
  $effect(() => {
    const want = key()
    if (want === undefined) return
    const cached = `${page.url.searchParams.get('person') ?? ''} ${want}`
    let stale = false
    live.value = answers.get(cached) as T | undefined
    const refresh = async () => {
      try {
        const value = await api<T>(path(want))
        if (stale) return
        answers.set(cached, value)
        live.value = value
      } catch (err) {
        console.error(`could not load ${want}`, err)
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

// the hub's summary of a range, with what all time decides; spans for the timeline
export function liveDigest(range: () => Range, spans = false) {
  return polled<Digest>(
    () => `digest ${range()}${spans ? ' spans' : ''}`,
    () => {
      const { from, to } = rangeWindow(range())
      const q = new URLSearchParams({ tz: tz() })
      if (from !== undefined) q.set('from', String(from))
      if (to !== undefined) q.set('to', String(to))
      if (spans) q.set('spans', '')
      return `/api/summary?${q}`
    },
  )
}

// one session's events and draft timelines
export function liveSession(id: () => string) {
  return polled<SessionDigest>(
    () => id() || undefined,
    id => `/api/session/${encodeURIComponent(id)}?tz=${encodeURIComponent(tz())}`,
  )
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
