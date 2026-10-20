import { summarize, type Event, type Summary } from '../src/aggregate'
import {
  $,
  MIN,
  api,
  duration,
  esc,
  hideTip,
  load,
  palette,
  projectLegend,
  rangeWindow,
  save,
  showTip,
  withPerson,
  type Palette,
  type Range,
} from './shared'

const REFRESH_MS = 30_000
// a lane's main bar, and the thin bar under it for a subagent elsewhere
const MAIN_H = 20
const SUB_H = 12
const GAP = 3
const LANE_GAP = 8
const MAX_ZOOM = 48

let range = load<Range>('range', '7')
const idleMin = Number(load('idle', '5'))
let zoom = 1
// the hours of the day the axis shows: all of them, or with `fit` just the
// ones anything happened in, so the bars get room
let fit = load('fit', '1') === '1'
let hours = { from: 0, to: 24 }
const HOUR = 60 * MIN
let events: Event[] | undefined

type Piece = Summary['spans'][number]

const labelW = () => (innerWidth < 560 ? 88 : 112)

const startOfDay = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
const nextDay = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}
const longDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

// a span cut at local midnights, each piece in its own day's row
function* byDay(span: Piece): Generator<[number, Piece]> {
  let at = span.from
  while (at < span.to) {
    const cut = Math.min(span.to, nextDay(at))
    yield [startOfDay(at), { ...span, from: at, to: cut }]
    at = cut
  }
}

const overlaps = (a: Piece, b: Piece) => a.from < b.to && b.from < a.to

// One session's pieces of a day in tracks: its home project first on the
// main track, then anything else wherever it fits. The main thread moving
// repos stays on the main track; a subagent elsewhere at the same time can't,
// so it drops to a thin track under it
function tracksOf(pieces: Piece[], home: string): Piece[][] {
  const tracks: Piece[][] = []
  const ordered = [...pieces].sort((a, b) => Number(b.project === home) - Number(a.project === home) || a.from - b.from)
  for (const piece of ordered) {
    const track = tracks.find(t => !t.some(other => overlaps(other, piece)))
    if (track) track.push(piece)
    else tracks.push([piece])
  }
  return tracks
}

type Lane = { end: number; sessions: { id: string; tracks: Piece[][] }[]; subs: number }

// sessions side by side in time get lanes of their own, first fit
function lanesOf(bySession: Map<string, Piece[]>, home: (id: string) => string): Lane[] {
  const sessions = [...bySession].map(([id, pieces]) => ({
    id,
    tracks: tracksOf(pieces, home(id)),
    from: Math.min(...pieces.map(p => p.from)),
    to: Math.max(...pieces.map(p => p.to)),
  }))
  sessions.sort((a, b) => a.from - b.from)
  const lanes: Lane[] = []
  for (const s of sessions) {
    const lane = lanes.find(l => l.end <= s.from)
    if (lane) {
      lane.end = s.to
      lane.sessions.push(s)
      lane.subs = Math.max(lane.subs, s.tracks.length - 1)
    } else lanes.push({ end: s.to, sessions: [s], subs: s.tracks.length - 1 })
  }
  return lanes
}

const laneH = (lane: Lane) => MAIN_H + lane.subs * (SUB_H + GAP)

// every bar drawn, by index, for the tooltip and the table
let pieces: Piece[] = []

// a day's active time: each session's pieces once however many projects
// shared them, summed over sessions, the way the overview counts it
function activeMs(bySession: Map<string, Piece[]>) {
  let ms = 0
  for (const list of bySession.values()) {
    let end = -Infinity
    for (const p of [...list].sort((a, b) => a.from - b.from)) {
      ms += Math.max(0, p.to - Math.max(p.from, end))
      end = Math.max(end, p.to)
    }
  }
  return ms
}

function dayRow(day: number, bySession: Map<string, Piece[]>, colors: Palette, home: (id: string) => string) {
  const end = nextDay(day)
  const pct = (ms: number) => (((ms - day) / HOUR - hours.from) / (hours.to - hours.from)) * 100
  const lanes = lanesOf(bySession, home)
  let top = 0
  let bars = ''
  for (const lane of lanes) {
    for (const s of lane.sessions) {
      s.tracks.forEach((track, k) => {
        const y = top + (k ? MAIN_H + GAP + (k - 1) * (SUB_H + GAP) : 0)
        const h = k ? SUB_H : MAIN_H
        for (const piece of track) {
          const i = pieces.push(piece) - 1
          bars += `<a class="tl-bar" data-i="${i}" data-session="${esc(piece.sessionId)}" href="${withPerson(`/session?id=${encodeURIComponent(piece.sessionId)}`)}" style="left:${pct(piece.from)}%;width:${pct(piece.to) - pct(piece.from)}%;top:${y}px;height:${h}px;background:${colors.color(piece.project)}" aria-label="${esc(piece.project)}, ${hm(piece.from)} to ${hm(piece.to)}"></a>`
        }
      })
    }
    top += laneH(lane) + LANE_GAP
  }
  const now = Date.now()
  if (now >= day && now < end && pct(now) <= 100) bars += `<span class="tl-now" style="left:${pct(now)}%" title="now"></span>`
  return `<div class="tl-row">
    <div class="tl-label"><span>${longDay(day)}</span><span class="muted">${duration(activeMs(bySession))}</span></div>
    <div class="tl-track" style="height:${Math.max(top - LANE_GAP, MAIN_H)}px">${bars}</div>
  </div>`
}

function render() {
  if (!events) return
  const w = rangeWindow(range)
  // all time: each project's color and each session's home
  const ever = summarize(events, { idleCapMs: idleMin * MIN })
  const colors = palette(ever.projects)
  const homes = new Map(ever.sessions.map(s => [s.sessionId, s.project]))
  const home = (id: string) => homes.get(id) ?? ''

  const lo = w.from ?? -Infinity
  const hi = w.to ?? Infinity
  const inRange = ever.spans.flatMap(s => (s.to > lo && s.from < hi ? [{ ...s, from: Math.max(s.from, lo), to: Math.min(s.to, hi) }] : []))
  const days = new Map<number, Map<string, Piece[]>>()
  for (const span of inRange) {
    for (const [day, piece] of byDay(span)) {
      const bySession = days.get(day) ?? new Map<string, Piece[]>()
      bySession.set(piece.sessionId, [...(bySession.get(piece.sessionId) ?? []), piece])
      days.set(day, bySession)
    }
  }

  $('empty').hidden = days.size > 0
  $('content').hidden = days.size === 0
  if (!days.size) return

  $('legend').innerHTML = projectLegend(colors, inRange.map(s => s.project))
  hours = { from: 0, to: 24 }
  if (fit) {
    let lo = 24
    let hi = 0
    for (const bySession of days.values()) {
      for (const list of bySession.values()) {
        for (const p of list) {
          const day = startOfDay(p.from)
          lo = Math.min(lo, (p.from - day) / HOUR)
          hi = Math.max(hi, (p.to - day) / HOUR)
        }
      }
    }
    // whole hours, and never fewer than 3 of them
    const from = Math.floor(lo)
    const to = Math.max(Math.ceil(hi), from + 3)
    hours = to > 24 ? { from: 21, to: 24 } : { from, to }
  }
  pieces = []
  let rows = ''
  // newest first, with a quiet stretch shown as one line
  const order = [...days.keys()].sort((a, b) => b - a)
  order.forEach((day, k) => {
    rows += dayRow(day, days.get(day)!, colors, home)
    const older = order[k + 1]
    if (older === undefined) return
    let quiet = 0
    for (let at = nextDay(older); at < day; at = nextDay(at)) quiet++
    if (quiet) rows += `<div class="tl-quiet"><span class="tl-label muted">${quiet} quiet day${quiet === 1 ? '' : 's'}</span></div>`
  })
  $('timeline').innerHTML = `<div class="tl-axis"><div class="tl-label"></div><div class="tl-track" id="axis"></div></div>${rows}`
  layout()
  wire(home)
}

function wire(home: (id: string) => string) {
  const lit = (session: string, on: boolean) =>
    document.querySelectorAll<HTMLElement>(`.tl-bar[data-session="${CSS.escape(session)}"]`).forEach(b => b.classList.toggle('lit', on))
  document.querySelectorAll<HTMLAnchorElement>('.tl-bar').forEach(bar => {
    const p = pieces[Number(bar.dataset.i)]!
    const from = home(p.sessionId)
    const tip = `<strong>${esc(p.project)}</strong>${hm(p.from)} to ${hm(p.to)} · ${duration(p.to - p.from)}<span class="muted">session ${esc(p.sessionId.slice(0, 8))}${from && from !== p.project ? `, started in ${esc(from)}` : ''}</span>`
    bar.addEventListener('mouseenter', () => lit(p.sessionId, true))
    bar.addEventListener('mousemove', e => showTip(e, tip))
    bar.addEventListener('mouseleave', () => {
      lit(p.sessionId, false)
      hideTip()
    })
  })
}

// --- zoom: the rows stretch, the bars are in percent so only widths move ---

const scroller = () => $('scroll')
const trackW = () => (scroller().clientWidth - labelW()) * zoom

function layout() {
  const el = $('timeline')
  if (!el.firstElementChild) return
  el.style.width = `${labelW() + trackW()}px`
  el.style.setProperty('--label-w', `${labelW()}px`)
  // hour ticks thin out until there's room for them
  const span = hours.to - hours.from
  const every = [0.25, 0.5, 1, 2, 3, 6].find(h => (trackW() / span) * h >= 56) ?? 6
  let ticks = ''
  for (let h = Math.ceil(hours.from / every) * every; h < hours.to; h += every) {
    const at = new Date(2000, 0, 1, 0, h * 60)
    const label = at.toLocaleTimeString(undefined, at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })
    ticks += `<span style="left:${((h - hours.from) / span) * 100}%">${label}</span>`
  }
  $('axis').innerHTML = ticks
  el.style.setProperty('--hour', `${trackW() / span}px`)
}

function setZoom(next: number, anchor = (scroller().clientWidth + labelW()) / 2) {
  const before = trackW()
  const at = (scroller().scrollLeft + anchor - labelW()) / before
  zoom = Math.min(MAX_ZOOM, Math.max(1, next))
  layout()
  scroller().scrollLeft = at * trackW() - (anchor - labelW())
}

let wheel = 0
let wheelX = 0
let frame = 0
scroller().addEventListener(
  'wheel',
  e => {
    if (!e.ctrlKey) return
    e.preventDefault()
    wheel += e.deltaY
    wheelX = e.clientX - scroller().getBoundingClientRect().left
    frame ||= requestAnimationFrame(() => {
      setZoom(zoom * Math.exp(-wheel * 0.002), Math.max(labelW(), wheelX))
      wheel = 0
      frame = 0
    })
  },
  { passive: false },
)
$('zoom-in').addEventListener('click', () => setZoom(zoom * 2))
const fitBox = $<HTMLInputElement>('fit')
fitBox.checked = fit
fitBox.addEventListener('change', () => {
  fit = fitBox.checked
  save('fit', fit ? '1' : '0')
  render()
})
$('zoom-out').addEventListener('click', () => setZoom(zoom / 2))

// --- wiring ---------------------------------------------------------------

async function refresh() {
  try {
    events = await api<Event[]>('/api/events')
  } catch (err) {
    console.error('could not load events', err)
    events ??= []
  }
  render()
}

function syncControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === range)))
}

document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach(b =>
  b.addEventListener('click', () => {
    range = b.dataset.range as Range
    save('range', range)
    syncControls()
    render()
  }),
)
document.querySelectorAll<HTMLAnchorElement>('nav a').forEach(a => (a.href = withPerson(a.getAttribute('href')!)))

// laying out can bring in a scrollbar, which resizes what's watched, so wait
let lastWidth = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
new ResizeObserver(([entry]) => {
  const width = Math.round(entry!.contentRect.width)
  if (width === lastWidth) return
  lastWidth = width
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(layout, 50)
}).observe(scroller())

syncControls()
refresh()
setInterval(refresh, REFRESH_MS)
