// What the dashboard pages work from: the hub's summaries, fetched now and
// every 30 s, who's looking, and a tick for redrawing charts on a theme flip
import { page } from '$app/state'
import type { Event } from '../analytics/aggregate'
import type { Timeline } from '../analytics/replay'
import type { Digest } from '../server/digest'
import { api, apiText, load, rangeWindow, save, withPerson, type Me, type Range } from './shared'

export type { Digest }
export type SessionDigest = { events: Event[]; projects: Digest['projects']; idleCapMs: number; timelines: Timeline[]; devices: string[] }

const REFRESH_MS = 30_000

// the viewer's time zone, which the hub counts days and hours in
export const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// The last answers by ?person and key, so moving between the overview and
// the timeline shows what's already here while it refreshes, with the text
// each came as: a refresh that brings the same text changes nothing, so
// nothing is drawn again
const answers = new Map<string, { text: string; value: unknown }>()
const meCache = new Map<string, Me>()

// Answers asked for ahead, by the same key: a page's load starts its fetch
// when a link to it is hovered, and the page takes it up if it opens soon
// after. Not api(): its 401 reruns every load, and so this again
const ahead = new Map<string, { at: number; value: Promise<string> }>()
const AHEAD_MS = 10_000

function prefetch(url: URL, want: string, path: string) {
  const person = url.searchParams.get('person') ?? ''
  // the fetch asks for whoever's dashboard is open now (withPerson)
  if (person !== (new URLSearchParams(location.search).get('person') ?? '')) return
  // the load runs again when the click comes, and the hover's is on its way
  const key = `${person} ${want}`
  if (Date.now() - (ahead.get(key)?.at ?? 0) < AHEAD_MS) return
  const value = fetch(withPerson(path)).then(res => {
    if (!res.ok) throw new Error(`${path} answered ${res.status}`)
    return res.text()
  })
  value.catch(() => {})
  ahead.set(key, { at: Date.now(), value })
}

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
    live.value = answers.get(cached)?.value as T | undefined
    const refresh = async () => {
      try {
        const early = ahead.get(cached)
        ahead.delete(cached)
        const fresh = () => apiText(path(want))
        const text = early && Date.now() - early.at < AHEAD_MS ? await early.value.catch(fresh) : await fresh()
        if (stale || text === answers.get(cached)?.text) return
        const value = JSON.parse(text) as T
        answers.set(cached, { text, value })
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

const digestKey = (range: Range, spans: boolean) => `digest ${range}${spans ? ' spans' : ''}`

function digestPath(range: Range, spans: boolean) {
  const { from, to } = rangeWindow(range)
  const q = new URLSearchParams({ tz: tz() })
  if (from !== undefined) q.set('from', String(from))
  if (to !== undefined) q.set('to', String(to))
  if (spans) q.set('spans', '')
  return `/api/summary?${q}`
}

// the hub's summary of a range, with what all time decides; spans for the timeline
export function liveDigest(range: () => Range, spans = false) {
  return polled<Digest>(
    () => digestKey(range(), spans),
    () => digestPath(range(), spans),
  )
}

// for a page's load: the summary its stored range will ask for
export function prefetchDigest(url: URL, spans = false) {
  const range = load<Range>('range', '7')
  prefetch(url, digestKey(range, spans), digestPath(range, spans))
}

// for a range picker's option, pointed at or focused before it's picked
export const prefetchRange = (range: Range, spans = false) => prefetch(new URL(location.href), digestKey(range, spans), digestPath(range, spans))

const sessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}?tz=${encodeURIComponent(tz())}`

// one session's events and draft timelines
export function liveSession(id: () => string) {
  return polled<SessionDigest>(() => id() || undefined, sessionPath)
}

export function prefetchSession(url: URL) {
  const id = url.searchParams.get('id')
  if (id) prefetch(url, id, sessionPath(id))
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
