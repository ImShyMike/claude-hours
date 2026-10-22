// Bits the dashboard pages share: lookups, storage, formatting and the tooltip
import { refreshAll } from '$app/navigation'

export const MIN = 60_000

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export const load = <T>(key: string, fallback: T): T => {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback
  } catch {
    return fallback
  }
}
export const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

// On the hub, an admin looking at someone else's dashboard carries ?person=
// from page to page and into every API call. It's read each time, since the
// overview and timeline move between each other without a reload
export const withPerson = (path: string) => {
  const person = new URLSearchParams(location.search).get('person')
  return person ? `${path}${path.includes('?') ? '&' : '?'}person=${encodeURIComponent(person)}` : path
}

// The hub answers 401 once the session runs out (or just after logging out,
// to a fetch already on its way). The pages ask the server again rather than
// leave: the overview turns into its welcome, and the pages that need a
// login send you to it from there
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(withPerson(path))
  if (res.status === 401) {
    await refreshAll()
    throw new Error('log in first')
  }
  // an error's body isn't the answer, so nothing keeps it as one
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json() as Promise<T>
}

export type Range = 'today' | '7' | '30' | 'all'

export function rangeWindow(r: Range): { from?: number; to?: number; label: string } {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const now = Date.now() + 1
  if (r === 'today') return { from: midnight.getTime(), to: now, label: 'today' }
  if (r === 'all') return { label: 'all time' }
  const days = Number(r)
  const from = new Date(midnight)
  from.setDate(from.getDate() - (days - 1))
  return { from: from.getTime(), to: now, label: `last ${days} days` }
}

// person is whose dashboard this is, me who's looking; an admin gets people
export type Me = { person?: number; me?: number; name?: string; admin?: boolean; people?: { id: number; name: string }[] }

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function duration(ms: number) {
  const mins = Math.round(ms / MIN)
  if (ms > 0 && mins < 1) return '<1m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

// short spans: 0.4s, 12s, 2m 05s, then hours
export function seconds(ms: number) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`
  return duration(ms)
}

export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

// what prompts carried besides text: "2 images, 1 file", or '' for none
export function attachments(counts: Record<string, unknown>) {
  const kinds = [
    ['image', counts.images],
    ['audio clip', counts.audio],
    ['file', counts.documents],
  ] as const
  return kinds
    .map(([name, n]) => [name, typeof n === 'number' ? n : 0] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${compact(n)} ${name}${n === 1 ? '' : 's'}`)
    .join(', ')
}

export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

export function showTip(e: MouseEvent, html: string) {
  const tooltip = $('tooltip')
  tooltip.innerHTML = html
  tooltip.hidden = false
  const { width, height } = tooltip.getBoundingClientRect()
  const x = Math.min(e.clientX + 12, innerWidth - width - 8)
  const y = e.clientY - height - 12 < 8 ? e.clientY + 16 : e.clientY - height - 12
  tooltip.style.left = `${x}px`
  tooltip.style.top = `${y}px`
}
export const hideTip = () => ($('tooltip').hidden = true)

// Each project keeps one color on every chart and page: the 8 with the most
// time ever get the palette in order, the rest share Other's gray. Ranked over
// all time, not the range shown, so picking a range never repaints one
export const SLOTS = 8
export const OTHER = 'Other'
export type Palette = { color: (project: string) => string; group: (project: string) => string; order: string[] }

export function palette(ranked: { project: string }[]): Palette {
  const order = ranked.slice(0, SLOTS).map(p => p.project)
  const slot = new Map(order.map((project, i) => [project, i + 1]))
  const group = (project: string) => (slot.has(project) ? project : OTHER)
  const color = (project: string) => (slot.has(project) ? `var(--p${slot.get(project)})` : 'var(--p-other)')
  return { color, group, order: [...order, OTHER] }
}
