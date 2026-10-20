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
