// A time axis that can squash its quiet stretches: busy stretches closer
// than gapMs merge into one segment, and each quiet stretch between segments
// is squeezed into a break gapPx wide (less if there are many), with the
// segments sharing the rest of the width to scale. gapMs = Infinity draws
// one plain linear axis over everything.
//
// A moment's place is a share of the segments' width plus some breaks, the
// same at any width, so a bar can be placed in CSS (`css`) and stay put in
// it while the width changes: a zoom then lays bars out without restyling
// each one
import type { Interval } from '../analytics/aggregate'

export type Axis = {
  // where a moment sits, and which moment sits at a position
  x: (ms: number) => number
  at: (px: number) => number
  segments: Interval[]
  gaps: Interval[]
  // px per ms inside a segment
  scale: number
  // a moment's left edge, as CSS against the width of the box it sits in,
  // and the length of a stretch the same way
  css: (ms: number) => string
  cssLength: (from: number, to: number) => string
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
  // each segment's start as a share of the busy time
  const starts: number[] = []
  for (let i = 0; i < segments.length; i++) starts.push(i ? starts[i - 1]! + (segments[i - 1]![1] - segments[i - 1]![0]) / busy : 0)
  // where a moment sits: [share of the segments' width, breaks before it]
  const unit = (ms: number): [number, number] => {
    for (let i = 0; i < segments.length; i++) {
      const [s, e] = segments[i]!
      if (ms > e && i < segments.length - 1) continue
      // inside a gap: spread across its break
      if (ms < s && i > 0) return [starts[i]!, i - 1 + (ms - segments[i - 1]![1]) / (s - segments[i - 1]![1])]
      return [starts[i]! + (ms - s) / busy, i]
    }
    return [0, 0]
  }
  const x = (ms: number) => {
    const [share, breaks] = unit(ms)
    return left + share * (plotW - gaps.length * breakPx) + breaks * breakPx
  }
  // the same in CSS, where 100% is the width: a break is gapPx, or less when
  // there are many, and the segments share what's left
  const brk = gaps.length ? `min(${gapPx}px, 100% * ${0.3 / gaps.length})` : '0px'
  const cssOf = (share: number, breaks: number) => `calc((100% - ${gaps.length} * ${brk}) * ${share} + ${brk} * ${breaks})`
  const css = (ms: number) => cssOf(...unit(ms))
  const cssLength = (from: number, to: number) => {
    const [a, i] = unit(from)
    const [b, j] = unit(to)
    return cssOf(b - a, j - i)
  }
  const at = (px: number) => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const [s] = segments[i]!
      const from = left + starts[i]! * (plotW - gaps.length * breakPx) + i * breakPx
      if (px >= from || i === 0) return s + (px - from) / scale
      // inside the break before this segment
      if (px >= from - breakPx) return segments[i - 1]![1] + ((px - from + breakPx) / breakPx) * (s - segments[i - 1]![1])
    }
    return segments[0]?.[0] ?? 0
  }
  return { x, at, segments, gaps, scale, css, cssLength }
}
