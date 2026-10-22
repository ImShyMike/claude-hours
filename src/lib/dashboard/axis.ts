// A time axis that can squash its quiet stretches: busy stretches closer
// than gapMs merge into one segment, and each quiet stretch between segments
// is squeezed into a break gapPx wide (less if there are many), with the
// segments sharing the rest of the width to scale. gapMs = Infinity draws
// one plain linear axis over everything
import type { Interval } from '../analytics/aggregate'

export type Axis = {
  // where a moment sits, and which moment sits at a position
  x: (ms: number) => number
  at: (px: number) => number
  segments: Interval[]
  gaps: Interval[]
  // px per ms inside a segment
  scale: number
}

export function axisOf(spans: Interval[], left: number, plotW: number, gapMs: number, gapPx: number, minMs = 10_000): Axis {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const segments: Interval[] = []
  for (const [start, end] of sorted) {
    const last = segments[segments.length - 1]
    if (last && start - last[1] <= gapMs) last[1] = Math.max(last[1], end)
    else segments.push([start, end])
  }
  const gaps = segments.slice(1).map((s, i): Interval => [segments[i]![1], s[0]])
  const breakPx = gaps.length ? Math.min(gapPx, (plotW * 0.3) / gaps.length) : 0
  const busy = Math.max(
    segments.reduce((ms, [s, e]) => ms + e - s, 0),
    minMs,
  )
  const scale = (plotW - gaps.length * breakPx) / busy
  // each segment's left edge, in px from the plot's start
  const offs: number[] = []
  for (let i = 0; i < segments.length; i++) offs.push(i ? offs[i - 1]! + (segments[i - 1]![1] - segments[i - 1]![0]) * scale + breakPx : 0)
  const x = (ms: number) => {
    for (let i = 0; i < segments.length; i++) {
      const [s, e] = segments[i]!
      if (ms > e && i < segments.length - 1) continue
      // inside a gap: spread across its break
      if (ms < s && i > 0) return left + offs[i]! - breakPx + ((ms - segments[i - 1]![1]) / (s - segments[i - 1]![1])) * breakPx
      return left + offs[i]! + (ms - s) * scale
    }
    return left
  }
  const at = (px: number) => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const [s] = segments[i]!
      const from = left + offs[i]!
      if (px >= from || i === 0) return s + (px - from) / scale
      // inside the break before this segment
      if (px >= from - breakPx) return segments[i - 1]![1] + ((px - from + breakPx) / breakPx) * (s - segments[i - 1]![1])
    }
    return segments[0]?.[0] ?? 0
  }
  return { x, at, segments, gaps, scale }
}
