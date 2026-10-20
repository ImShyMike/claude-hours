import { dayKey, summarize, type Event, type Summary } from '../src/aggregate'

const MIN = 60_000
const REFRESH_MS = 30_000

type Range = 'today' | '7' | '30' | 'all'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const tooltip = $('tooltip')

const load = <T>(key: string, fallback: T): T => {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback
  } catch {
    return fallback
  }
}
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

// ?theme=dark|light pins the theme, handy for screenshots
const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme

let range = load<Range>('range', '7')
let idleMin = Number(load('idle', '5'))
// undefined until the first fetch, so nothing claims the log is empty early
let events: Event[] | undefined

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function duration(ms: number) {
  const mins = Math.round(ms / MIN)
  if (ms > 0 && mins < 1) return '<1m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

function rangeWindow(r: Range): { from?: number; to?: number; label: string } {
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

// --- tooltip -------------------------------------------------------------

function showTip(e: MouseEvent, html: string) {
  tooltip.innerHTML = html
  tooltip.hidden = false
  const { width, height } = tooltip.getBoundingClientRect()
  const x = Math.min(e.clientX + 12, innerWidth - width - 8)
  const y = e.clientY - height - 12 < 8 ? e.clientY + 16 : e.clientY - height - 12
  tooltip.style.left = `${x}px`
  tooltip.style.top = `${y}px`
}
const hideTip = () => (tooltip.hidden = true)

// --- charts --------------------------------------------------------------

// clean duration ticks: the smallest step that keeps it to about four lines
const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440]
function niceStep(maxMs: number) {
  const maxMin = maxMs / MIN
  return (STEPS_MIN.find(step => maxMin / step <= 4) ?? 1440) * MIN
}

const tickLabel = (ms: number) => (ms >= 60 * MIN ? `${ms / (60 * MIN)}h` : `${ms / MIN}m`)

type Column = { label: string; value: number; tip: string }

// One series of columns from a single baseline: thin bars, 4px rounded tops,
// hairline grid, and a hit target the full width of each band.
function columns(el: HTMLElement, data: Column[], labelEvery = 1) {
  // drawn at the measured size so text never scales with the viewBox
  const width = Math.max(el.clientWidth, 200)
  const height = 200
  const pad = { top: 8, right: 4, bottom: 22, left: 40 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const max = Math.max(...data.map(d => d.value), 0)
  const step = niceStep(max || MIN)
  const top = Math.max(step, Math.ceil(max / step) * step)
  const y = (v: number) => pad.top + plotH - (v / top) * plotH
  const band = plotW / Math.max(data.length, 1)
  const barW = Math.max(2, Math.min(24, band * 0.6))

  let svg = ''
  for (let v = 0; v <= top; v += step) {
    svg += `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/>`
    svg += `<text x="${pad.left - 6}" y="${y(v) + 4}" text-anchor="end">${tickLabel(v)}</text>`
  }
  data.forEach((d, i) => {
    const cx = pad.left + band * i + band / 2
    if (i % labelEvery === 0) svg += `<text x="${cx}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>`
    svg += `<rect class="hit" data-i="${i}" x="${cx - band / 2}" y="${pad.top}" width="${band}" height="${plotH}"/>`
    const h = y(0) - y(d.value)
    if (h <= 0) return
    const r = Math.min(4, h, barW / 2)
    const x0 = cx - barW / 2
    const x1 = cx + barW / 2
    const yt = y(0) - h
    svg += `<path class="bar" data-i="${i}" d="M${x0},${y(0)} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${y(0)} Z"/>`
  })
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${svg}</svg>`

  el.querySelectorAll<SVGRectElement>('.hit').forEach(hit => {
    const i = Number(hit.dataset.i)
    const bar = el.querySelector(`.bar[data-i="${i}"]`)
    hit.addEventListener('mousemove', e => {
      bar?.classList.add('hover')
      showTip(e, data[i]!.tip)
    })
    hit.addEventListener('mouseleave', () => {
      bar?.classList.remove('hover')
      hideTip()
    })
  })
}

// mcp__helium-devtools__new_page reads better as "helium-devtools · new_page"
const toolName = (tool: string) => tool.replace(/^mcp__(.+?)__(.+)$/, '$1 · $2')

type BarItem = { name: string; value: number; amount: string; tip: string }

function barList(el: HTMLElement, items: BarItem[], limit = 10) {
  if (!items.length) {
    el.innerHTML = '<p class="muted">nothing yet</p>'
    return
  }
  const max = Math.max(...items.map(i => i.value))
  const shown = items.slice(0, limit)
  el.className = 'bars'
  el.innerHTML = shown
    .map(
      (item, i) => `<div class="bar-row" data-i="${i}">
        <span class="name" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="track"><span class="fill" style="display:block;width:${(item.value / max) * 100}%"></span></span>
        <span class="amount">${esc(item.amount)}</span>
      </div>`,
    )
    .join('')
  if (items.length > limit) el.insertAdjacentHTML('beforeend', `<p class="muted">+ ${items.length - limit} more</p>`)
  el.querySelectorAll<HTMLElement>('.bar-row').forEach(row => {
    const item = shown[Number(row.dataset.i)]!
    row.addEventListener('mousemove', e => showTip(e, item.tip))
    row.addEventListener('mouseleave', hideTip)
  })
}

// --- render --------------------------------------------------------------

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const longDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })

function tile(label: string, value: string, sub = '') {
  return `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
}

function writingTile(w: Summary['writing']) {
  if (!w.sent && !w.abandoned) return tile('Writing prompts', '-', 'no typing data yet')
  // the usual 5 characters a word, over the time actually typing
  const wpm = w.typingMs ? Math.round(w.typedChars / 5 / (w.typingMs / MIN)) : 0
  const gaveUp = `${w.abandoned} abandoned`
  return tile('Writing prompts', duration(w.typingMs), wpm ? `${gaveUp} · ${wpm} wpm` : gaveUp)
}

function render() {
  if (!events) return
  const w = rangeWindow(range)
  const s: Summary = summarize(events, { from: w.from, to: w.to, idleCapMs: idleMin * MIN })
  const any = s.sessions.length > 0

  $('total').textContent = duration(s.totalMs)
  $('total-label').textContent = `active with Claude, ${w.label}${any ? `, across ${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'}` : ''}`

  const totalTurns = s.turns + s.interrupts
  $('tiles').innerHTML = [
    tile('Prompts', compact(s.prompts.count), s.prompts.count ? `avg ${Math.round(s.prompts.avgWords)} word${Math.round(s.prompts.avgWords) === 1 ? '' : 's'}` : ''),
    tile('Turns', compact(s.turns), ''),
    tile('Interrupts', compact(s.interrupts), totalTurns ? `${Math.round((s.interrupts / totalTurns) * 100)}% of turns` : ''),
    tile('Output tokens', compact(s.tokens.output), s.tokens.cacheRead ? `${compact(s.tokens.cacheRead)} cache reads` : ''),
    writingTile(s.writing),
  ].join('')

  $('empty').hidden = any
  $('content').hidden = !any
  if (!any) return

  // one column per day only makes sense past a single day
  const daysCard = $('days-card')
  daysCard.hidden = s.days.length <= 1
  if (!daysCard.hidden) {
    const today = dayKey(Date.now())
    columns(
      $('days'),
      s.days.map(d => ({
        label: d.day === today ? 'today' : shortDay(d.day),
        value: d.ms,
        tip: `<strong>${longDay(d.day)}</strong>${duration(d.ms)} active · ${d.prompts} prompt${d.prompts === 1 ? '' : 's'}`,
      })),
      Math.ceil(s.days.length / 8),
    )
    $('days-table').innerHTML =
      '<tr><th>Day</th><th class="num">Active</th><th class="num">Prompts</th></tr>' +
      s.days.map(d => `<tr><td>${longDay(d.day)}</td><td class="num">${duration(d.ms)}</td><td class="num">${d.prompts}</td></tr>`).join('')
  }

  columns(
    $('hours'),
    s.hours.map((ms, h) => ({ label: hourLabel(h), value: ms, tip: `<strong>${hourLabel(h)}</strong>${duration(ms)} active` })),
    3,
  )

  barList(
    $('projects'),
    s.projects.map(p => ({
      name: p.project,
      value: p.ms,
      amount: duration(p.ms),
      tip: `<strong>${esc(p.project)}</strong>${duration(p.ms)} · ${Math.round((p.ms / s.totalMs) * 100)}%`,
    })),
  )

  const edits = s.languages.reduce((sum, l) => sum + l.edits, 0)
  barList(
    $('languages'),
    s.languages.map(l => ({
      name: l.language,
      value: l.edits,
      amount: String(l.edits),
      tip: `<strong>${esc(l.language)}</strong>${l.edits} file change${l.edits === 1 ? '' : 's'} · ${Math.round((l.edits / edits) * 100)}%`,
    })),
  )

  barList(
    $('tools'),
    s.tools.map(t => ({
      name: toolName(t.tool),
      value: t.calls,
      amount: compact(t.calls),
      tip: `<strong>${esc(toolName(t.tool))}</strong>${t.calls} calls · avg ${t.avgMs < 1000 ? `${Math.round(t.avgMs)}ms` : `${(t.avgMs / 1000).toFixed(1)}s`}<br>${t.errors} errors · ${t.denied} denied`,
    })),
    12,
  )

  const when = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  $('sessions').innerHTML =
    '<tr><th>Started</th><th>Project</th><th class="num">Active</th><th class="num">Prompts</th><th>Session</th></tr>' +
    s.sessions
      .slice(0, 25)
      .map(
        x => `<tr><td>${when(x.start)}</td><td>${esc(x.project)}</td><td class="num">${duration(x.activeMs)}</td><td class="num">${x.prompts}</td><td class="muted"><code>${esc(x.sessionId.slice(0, 8))}</code></td></tr>`,
      )
      .join('')
}

// --- wiring --------------------------------------------------------------

async function refresh() {
  try {
    const res = await fetch('/api/events')
    events = await res.json()
  } catch (err) {
    console.error('could not load events', err)
    events ??= []
  }
  render()
}

function syncControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.range === range))
  })
  $<HTMLSelectElement>('idle').value = String(idleMin)
}

document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(b =>
  b.addEventListener('click', () => {
    range = b.dataset.range as Range
    save('range', range)
    syncControls()
    render()
  }),
)
$<HTMLSelectElement>('idle').addEventListener('change', e => {
  idleMin = Number((e.target as HTMLSelectElement).value)
  save('idle', String(idleMin))
  render()
})

// charts are drawn at a measured width, so redraw when it changes. That
// includes a scrollbar showing up after the first render
let lastWidth = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
new ResizeObserver(([entry]) => {
  const width = Math.round(entry!.contentRect.width)
  if (width === lastWidth) return
  lastWidth = width
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(render, 50)
}).observe(document.querySelector('main')!)

syncControls()
refresh()
setInterval(refresh, REFRESH_MS)
