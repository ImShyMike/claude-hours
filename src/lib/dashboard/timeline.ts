// The timeline's rows: a row per day, each session's active spans as bars
// placed in lanes, newest day first with quiet stretches folded into one line
import { dayKey, type Interval, type Summary } from '../analytics/aggregate'
import { longDay } from './overview'
import { ROW, type Bar, type Row } from './rows'
import { MIN, duration, esc } from './shared'

export const MAX_ZOOM = 48
const HOUR = 60 * MIN

export type Piece = Summary['spans'][number]
// the hours of the day the axis shows: all of them, just the stretch anything
// happened in, or only the hours anything happened in, the quiet ones squashed
export type Hours = 'all' | 'fit' | 'squash'

export const startOfDay = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
export const nextDay = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}
export const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

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

type Look = { color: (project: string) => string; home: (id: string) => string; link: (id: string) => string }

function tip(p: Piece, from: string) {
  return `<strong>${esc(p.project)}</strong>${hm(p.from)} to ${hm(p.to)} · ${duration(p.to - p.from)}<span class="muted">session ${esc(p.sessionId.slice(0, 8))}${from && from !== p.project ? `, started in ${esc(from)}` : ''}</span>`
}

// a day's lanes as bars, in ms from its midnight so every day shares the axis
function dayRow(day: number, bySession: Map<string, Piece[]>, look: Look): Row {
  const bars: Bar[] = []
  let top = 0
  for (const lane of lanesOf(bySession, look.home)) {
    for (const s of lane.sessions) {
      s.tracks.forEach((track, k) => {
        const y = top + (k ? ROW.main + ROW.gap + (k - 1) * (ROW.sub + ROW.gap) : 0)
        for (const piece of track)
          bars.push({
            from: piece.from - day,
            to: piece.to - day,
            top: y,
            height: k ? ROW.sub : ROW.main,
            color: look.color(piece.project),
            tip: tip(piece, look.home(piece.sessionId)),
            label: `${piece.project}, ${hm(piece.from)} to ${hm(piece.to)}`,
            href: look.link(piece.sessionId),
            group: piece.sessionId,
          })
      })
    }
    top += ROW.main + lane.subs * (ROW.sub + ROW.gap) + ROW.lane
  }
  return { key: String(day), label: longDay(dayKey(day)), sub: duration(activeMs(bySession)), bars, height: Math.max(top - ROW.lane, ROW.main) }
}

// every piece's stretch of its day, in ms from midnight
function dayOffsets(days: Map<number, Map<string, Piece[]>>): Interval[] {
  const out: Interval[] = []
  for (const bySession of days.values()) {
    for (const list of bySession.values()) {
      for (const p of list) {
        const day = startOfDay(p.from)
        out.push([p.from - day, p.to - day])
      }
    }
  }
  return out
}

// what the axis spans, in ms from midnight, and how long a quiet stretch
// has to be to squash
function axisFor(days: Map<number, Map<string, Piece[]>>, hours: Hours): { spans: Interval[]; gapMs: number; minMs?: number } {
  const spans = dayOffsets(days)
  if (hours === 'all' || !spans.length) return { spans: [[0, 24 * HOUR]], gapMs: Infinity }
  if (hours === 'fit') {
    // whole hours, and never fewer than 3 of them
    const from = Math.floor(Math.min(...spans.map(s => s[0])) / HOUR)
    const to = Math.max(Math.ceil(Math.max(...spans.map(s => s[1])) / HOUR), from + 3)
    const [lo, hi] = to > 24 ? [21, 24] : [from, to]
    return { spans: [[lo * HOUR, hi * HOUR]], gapMs: Infinity }
  }
  // the hours anything happened in; one quiet hour between stays, longer
  // quiet stretches become breaks
  const busy = spans.map(([from, to]): Interval => [
    Math.floor(from / HOUR) * HOUR,
    Math.max(Math.ceil(to / HOUR), Math.floor(from / HOUR) + 1) * HOUR,
  ])
  return { spans: busy, gapMs: HOUR, minMs: HOUR }
}

// the spans in a window as day rows, newest first
export function timelineRows(spans: Piece[], window: { from?: number; to?: number }, look: Look, hours: Hours) {
  const lo = window.from ?? -Infinity
  const hi = window.to ?? Infinity
  const inRange = spans.flatMap(s => (s.to > lo && s.from < hi ? [{ ...s, from: Math.max(s.from, lo), to: Math.min(s.to, hi) }] : []))
  const days = new Map<number, Map<string, Piece[]>>()
  for (const span of inRange) {
    for (const [day, piece] of byDay(span)) {
      const bySession = days.get(day) ?? new Map<string, Piece[]>()
      bySession.set(piece.sessionId, [...(bySession.get(piece.sessionId) ?? []), piece])
      days.set(day, bySession)
    }
  }
  const rows: Row[] = []
  const order = [...days.keys()].sort((a, b) => b - a)
  order.forEach((day, k) => {
    rows.push(dayRow(day, days.get(day)!, look))
    const older = order[k + 1]
    if (older === undefined) return
    let quiet = 0
    for (let at = nextDay(older); at < day; at = nextDay(at)) quiet++
    if (quiet) rows.push({ key: `quiet-${day}`, label: `${quiet} quiet day${quiet === 1 ? '' : 's'}`, height: 0, bars: [], quiet: true })
  })
  return { rows, ...axisFor(days, hours), projects: inRange.map(s => s.project) }
}
