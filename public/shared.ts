// Bits both pages use: lookups, storage, formatting and the tooltip

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

// ?theme=dark|light pins the theme, handy for screenshots
const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme

// On the hub, an admin looking at someone else's dashboard carries ?person=
// from page to page and into every API call
const person = new URLSearchParams(location.search).get('person')
export const withPerson = (path: string) =>
  person ? `${path}${path.includes('?') ? '&' : '?'}person=${encodeURIComponent(person)}` : path

// The hub answers 401 until you log in; the local dashboard never does
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(withPerson(path))
  if (res.status === 401) {
    location.href = '/login'
    throw new Error('log in first')
  }
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

export type Me = { person?: string; me?: string; admin?: boolean; people?: string[] }

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

export const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

export const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

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

// a legend for the projects in view, in palette order with Other last
export function projectLegend(colors: Palette, projects: string[]) {
  const shown = new Set(projects.map(colors.group))
  return colors.order
    .filter(p => shown.has(p))
    .map(p => `<span class="key"><span class="swatch" style="background:${colors.color(p)}"></span>${esc(p)}</span>`)
    .join('')
}

// with ms, its time after the name: terra (1h 02m)
export const chip = (colors: Palette, project: string, ms?: number) =>
  `<span class="chip"><span class="swatch" style="background:${colors.color(project)}"></span>${esc(project)}${ms ? ` <span class="muted">(${duration(ms)})</span>` : ''}</span>`
