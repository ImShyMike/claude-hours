// What the time-rows chart draws, shared by the timeline (a row per day) and
// the session page (a row per lane): rows of bars on one time axis that can
// squash its quiet stretches, with the same ticks, breaks and bars on both
import type { Axis } from './axis'
import { MIN, duration } from './shared'

// a bar's height in a row, a thin one under it (a subagent, a project
// alongside), the gap between them, and the gap between lanes of bars
export const ROW = { main: 20, sub: 12, gap: 3, lane: 8 }
const HOUR = 60 * MIN

// A stretch of time on a row's track. Its look is Tailwind classes, or a
// project color; hovering lights up every bar of the same group, and a
// plain bar (laid over another, like a pause over its draft) has no ring
export type Bar = {
  from: number
  to: number
  top: number
  height: number
  class?: string
  color?: string
  tip?: string
  label?: string
  href?: string
  onclick?: () => void
  group?: string
  selected?: boolean
  plain?: boolean
}

// a moment drawn through the whole row: now, an interrupt, a prompt sent
// mid-turn; the glyph sits by its top
export type Mark = { at: number; class: string; tip?: string; glyph?: string; glyphClass?: string }

// a quiet row is just its label, a dashed line between busy ones
export type Row = { key: string; label: string; sub?: string; height: number; bars: Bar[]; marks?: Mark[]; quiet?: boolean }

// the steps time labels come in, the smallest that leaves room for a label
const STEPS = [10_000, 30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR]
const TICK_PX = 64
// a break this wide has its length on the axis
const BREAK_LABEL_PX = 30

// tick labels, each formatter made once since a zoom labels hundreds of ticks
const SECONDS = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
const MINUTES = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const HOURS = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })

const startOfDay = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// What's drawn across the track: a labelled hairline every step (on the
// local clock, so hours land on the hour), and each squashed stretch as a
// break with its length over it. `clock` turns a value on the axis into the
// moment it stands for
export function guides(axis: Axis, trackW: number, clock: (v: number) => number) {
  const step = STEPS.find(s => s * axis.scale >= TICK_PX) ?? STEPS[STEPS.length - 1]!
  const breaks = axis.gaps.map(([from, to]) => {
    const left = axis.x(from)
    const width = axis.x(to) - left
    return { from, to, left, width, label: width >= BREAK_LABEL_PX ? duration(to - from) : '' }
  })
  const labelled = breaks.filter(b => b.label).map(b => b.left + b.width / 2)
  const format = step < MIN ? SECONDS : step < HOUR ? MINUTES : HOURS
  const ticks: { left: number; label: string }[] = []
  let last = -Infinity
  for (const [from, to] of axis.segments) {
    // the first step at or after `from`, counted from its local midnight
    const zero = from + startOfDay(clock(from)) - clock(from)
    for (let t = zero + Math.ceil((from - zero) / step) * step; t < to; t += step) {
      const left = axis.x(t)
      // apart from each other (across a thin break too), clear of break
      // labels, and with room for the label inside the track
      if (left - last < TICK_PX - 8 || left > trackW - 48 || labelled.some(c => c > left - 32 && c < left + TICK_PX + 12)) continue
      last = left
      ticks.push({ left, label: format.format(clock(t)) })
    }
  }
  return { ticks, breaks }
}
