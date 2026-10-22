// The timeline's rows: a row per day, each session's active spans as bars
// placed in lanes, newest day first with quiet stretches folded into one line
import type { Summary } from '../analytics/aggregate'
import { MIN } from './shared'

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
export type Hours = { from: number; to: number }

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

// the hours of the day the axis shows: all of them, or with `fit` just the
// ones anything happened in, so the bars get room
function hoursOf(days: Map<number, Map<string, Piece[]>>, fit: boolean): Hours {
  if (!fit) return { from: 0, to: 24 }
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
  return to > 24 ? { from: 21, to: 24 } : { from, to }
}

// the spans in a window as day rows, newest first
export function timelineRows(spans: Piece[], window: { from?: number; to?: number }, home: (id: string) => string, fit: boolean) {
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
  return { rows, hours: hoursOf(days, fit), projects: inRange.map(s => s.project) }
}

// where a moment of a day sits on the track, in percent
export const pct = (hours: Hours, day: number, ms: number) => (((ms - day) / HOUR - hours.from) / (hours.to - hours.from)) * 100

// hour ticks thin out until there's room for them
export function ticks(hours: Hours, trackW: number) {
  const span = hours.to - hours.from
  const every = [0.25, 0.5, 1, 2, 3, 6].find(h => (trackW / span) * h >= 56) ?? 6
  const out: { left: number; label: string }[] = []
  for (let h = Math.ceil(hours.from / every) * every; h < hours.to; h += every) {
    const at = new Date(2000, 0, 1, 0, h * 60)
    const label = at.toLocaleTimeString(undefined, at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })
    out.push({ left: ((h - hours.from) / span) * 100, label })
  }
  return out
}
