// The timeline's rows: a row per day, each session's active spans as bars
// placed in lanes, newest day first with quiet stretches folded into one line
import type { Interval, Summary } from '../analytics/aggregate'
import { axisOf, type Axis } from './axis'
import { MIN, duration } from './shared'

// a lane's main bar, and the thin bar under it for a subagent elsewhere
const MAIN_H = 20
const SUB_H = 12
const GAP = 3
const LANE_GAP = 8
export const MAX_ZOOM = 48
const HOUR = 60 * MIN

export type Piece = Summary['spans'][number]
export type Bar = { piece: Piece; top: number; height: number }
export type Row = { kind: 'day'; day: number; activeMs: number; bars: Bar[]; height: number } | { kind: 'quiet'; day: number; days: number }
// the hours of the day the axis shows: all of them, just the stretch anything
// happened in, or only the hours anything happened in, the quiet ones squashed
export type Hours = 'all' | 'fit' | 'squash'

const startOfDay = (ms: number) => {
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

function dayRow(day: number, bySession: Map<string, Piece[]>, home: (id: string) => string): Row {
  const bars: Bar[] = []
  let top = 0
  for (const lane of lanesOf(bySession, home)) {
    for (const s of lane.sessions) {
      s.tracks.forEach((track, k) => {
        const y = top + (k ? MAIN_H + GAP + (k - 1) * (SUB_H + GAP) : 0)
        for (const piece of track) bars.push({ piece, top: y, height: k ? SUB_H : MAIN_H })
      })
    }
    top += MAIN_H + lane.subs * (SUB_H + GAP) + LANE_GAP
  }
  return { kind: 'day', day, activeMs: activeMs(bySession), bars, height: Math.max(top - LANE_GAP, MAIN_H) }
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

// the axis across a row, in percent of the track so zoom only stretches it
function axisFor(days: Map<number, Map<string, Piece[]>>, hours: Hours): Axis {
  const spans = dayOffsets(days)
  if (hours === 'all' || !spans.length) return axisOf([[0, 24 * HOUR]], 0, 100, Infinity, 0)
  if (hours === 'fit') {
    // whole hours, and never fewer than 3 of them
    const from = Math.floor(Math.min(...spans.map(s => s[0])) / HOUR)
    const to = Math.max(Math.ceil(Math.max(...spans.map(s => s[1])) / HOUR), from + 3)
    const [lo, hi] = to > 24 ? [21, 24] : [from, to]
    return axisOf([[lo * HOUR, hi * HOUR]], 0, 100, Infinity, 0)
  }
  // the hours anything happened in; one quiet hour between stays, longer
  // quiet stretches become breaks
  const busy = spans.map(([from, to]): Interval => [
    Math.floor(from / HOUR) * HOUR,
    Math.max(Math.ceil(to / HOUR), Math.floor(from / HOUR) + 1) * HOUR,
  ])
  return axisOf(busy, 0, 100, HOUR, 4, HOUR)
}

// the spans in a window as day rows, newest first
export function timelineRows(spans: Piece[], window: { from?: number; to?: number }, home: (id: string) => string, hours: Hours) {
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
    rows.push(dayRow(day, days.get(day)!, home))
    const older = order[k + 1]
    if (older === undefined) return
    let quiet = 0
    for (let at = nextDay(older); at < day; at = nextDay(at)) quiet++
    if (quiet) rows.push({ kind: 'quiet', day: nextDay(older), days: quiet })
  })
  return { rows, axis: axisFor(days, hours), projects: inRange.map(s => s.project) }
}

// where a moment of a day sits on the track, in percent
export const pct = (axis: Axis, day: number, ms: number) => axis.x(ms - day)

const tickLabel = (h: number) => {
  const at = new Date(2000, 0, 1, 0, h * 60)
  return at.toLocaleTimeString(undefined, at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })
}

// What's drawn across the track at a width: a hairline every hour, hour
// labels thinned out until there's room for them, and each squashed stretch
// as a break with its length over it
export function guides(axis: Axis, trackW: number) {
  const pxPerHour = (axis.scale * HOUR * trackW) / 100
  const every = [0.25, 0.5, 1, 2, 3, 6].find(h => pxPerHour * h >= 56) ?? 6
  const breaks = axis.gaps.map(([from, to]) => ({ left: axis.x(from), width: axis.x(to) - axis.x(from), label: duration(to - from) }))
  // labels keep clear of a break's own label
  const clear = (left: number) => breaks.every(b => (Math.abs(b.left + b.width / 2 - left) * trackW) / 100 >= 40)
  const lines: number[] = []
  const ticks: { left: number; label: string }[] = []
  for (const [from, to] of axis.segments) {
    for (let h = Math.ceil(from / HOUR); h * HOUR <= to; h++) lines.push(axis.x(h * HOUR))
    for (let h = Math.ceil(from / HOUR / every) * every; h * HOUR < to; h += every) {
      if (clear(axis.x(h * HOUR))) ticks.push({ left: axis.x(h * HOUR), label: tickLabel(h) })
    }
  }
  return { lines, ticks, breaks }
}
