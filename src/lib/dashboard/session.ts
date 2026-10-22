// The session page's drawing, worked out as shapes and strings for its
// Svelte components to put on the page: the lanes of who was doing what,
// the drafts, and a draft's replay
import { projectSpans, turnPieces, waitsOf, type Event, type Interval } from '../analytics/aggregate'
import { apply, countGroups, describe, groupOf, initialState, pausesOf, type Source, type State, type Step, type Timeline } from '../analytics/replay'
import { axisOf } from './axis'
import { MIN, attachments, clockTime, compact, duration, esc, seconds, type Palette } from './shared'

// a draft as the main log tells it, with its replay if the sidecar has one
export type Draft = {
  id: string
  outcome: 'sent' | 'abandoned'
  start: number
  end: number
  line: Event
  timeline?: Timeline
}

export const time = (e: Event) => Date.parse(e.ts)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

// --- data ---------------------------------------------------------------

export function buildDrafts(events: Event[], timelines: Timeline[]): Draft[] {
  const byId = new Map(timelines.map(tl => [tl.draftId, tl]))
  const out: Draft[] = []
  for (const e of events) {
    if (e.event === 'prompt' && typeof e.composeMs === 'number') {
      const end = time(e)
      const id = typeof e.draftId === 'string' ? e.draftId : `prompt-${e.ts}`
      out.push({ id, outcome: 'sent', start: end - e.composeMs, end, line: e, timeline: byId.get(id) })
    } else if (e.event === 'draft_abandoned') {
      const id = typeof e.draftId === 'string' ? e.draftId : `abandoned-${e.ts}`
      const end = Date.parse(String(e.endedAt ?? e.ts))
      const start = Date.parse(String(e.startedAt ?? e.ts))
      out.push({ id, outcome: 'abandoned', start, end, line: e, timeline: byId.get(id) })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

export type ProjectPiece = { project: string; span: Interval }

// Where the session's time went, by project, for the Projects lane: tracks of
// stretches that don't overlap, home project first, so a fork working in
// another repo at the same time drops to a thin track under it
export function projectTracks(events: Event[], idleCapMs: number, home: string): ProjectPiece[][] {
  const byProject = [...projectSpans(events, idleCapMs)].flatMap(([project, spans]) => spans.map(span => ({ project, span })))
  byProject.sort((a, b) => Number(b.project === home) - Number(a.project === home) || a.span[0] - b.span[0])
  const tracks: ProjectPiece[][] = []
  for (const piece of byProject) {
    const track = tracks.find(t => !t.some(o => o.span[0] < piece.span[1] && piece.span[0] < o.span[1]))
    if (track) track.push(piece)
    else tracks.push([piece])
  }
  return tracks
}

// --- session timeline ---------------------------------------------------

// With gaps collapsed, a quiet stretch longer than GAP_MS is squeezed into a
// break GAP_PX wide (less if there are many)
const GAP_MS = 5 * MIN
const GAP_PX = 48
// the mod's own thresholds: a gap this long is a pause, and one this long a
// break that stops counting as typing time
const PAUSE_MS = 2_000
const BREAK_MS = 30_000
const TICKS_MS = [10_000, 30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN]

export const LANE_NAMES = ['You', 'Claude', 'Tools', 'Projects']
export const LANES_PAD = { left: 64, right: 12, top: 22 }
export const LANE_H = 30
const SUB = 11

// what's drawn, class names in full so Tailwind finds them
export type Shape =
  | { kind: 'rect'; class: string; x: number; y: number; width: number; height: number; rx?: number; fill?: string; tip?: string; draft?: string }
  | { kind: 'line'; class: string; x1: number; x2: number; y1: number; y2: number; tip?: string }
  | { kind: 'text'; class: string; x: number; y: number; text: string; tip?: string; start?: boolean }

const YOU = 'fill-(--typed)'
const PICKABLE = 'cursor-pointer hover:stroke-foreground hover:stroke-2'

// the lanes' legend: a swatch's classes and what it means
export const LANES_LEGEND: [string, string][] = [
  ['bg-(--typed)', 'writing a prompt'],
  ['shadow-[inset_0_0_0_2px_var(--typed)]', 'abandoned draft'],
  ['bg-[repeating-linear-gradient(45deg,var(--typed)_0_2px,var(--card)_2px_4px)]', 'paused while writing'],
  ['bg-(--typed) opacity-45', 'answering Claude'],
  ['bg-(--neutral-2)', 'Claude working'],
  ['bg-foreground/70', 'compacting'],
  ['bg-(--neutral)', 'tool call'],
  ['bg-(--critical)', 'interrupt'],
  ['w-[3px] bg-[repeating-linear-gradient(to_bottom,var(--muted-foreground)_0_3px,transparent_3px_5px)]', 'sent mid-turn'],
]

export function lanes(opts: {
  events: Event[]
  drafts: Draft[]
  tracks: ProjectPiece[][]
  colors: Palette
  selected?: string
  fit: number
  zoom: number
  collapse: boolean
}) {
  const { events, drafts, tracks, colors, selected } = opts
  const turns = events.filter(e => (e.event === 'turn_end' || e.event === 'interrupt') && !e.agentId)
  const compacts = events.filter(e => e.event === 'compact')
  // a tool row is written when the call ends, so it starts durationMs earlier
  const tools = events.filter(e => e.event === 'tool').map(e => ({ start: time(e) - num(e.durationMs), end: time(e), e }))

  // a question or plan waiting on the person is their time: it goes on the
  // You lane, and the turn around it is drawn in pieces on either side
  const waits = waitsOf(events)
  const piecesOf = new Map(turns.map(t => [t, turnPieces(time(t), num(t.durationMs), waits)]))
  // everything drawn, so collapsed gaps are only ever empty ones
  const spans: Interval[] = [
    ...events.map((e): Interval => [time(e), time(e)]),
    ...drafts.map((d): Interval => [d.start, d.end]),
    ...[...piecesOf.values()].flat(),
    ...compacts.map((c): Interval => [time(c) - num(c.durationMs), time(c)]),
    ...tools.map((t): Interval => [t.start, t.end]),
    ...waits.map((w): Interval => [w.from, w.to]),
  ]
  const t1 = Math.max(...spans.map(s => s[1]))

  const pad = LANES_PAD
  const fit = Math.max(opts.fit, 280)
  const width = Math.max(fit, Math.round((fit - pad.left - pad.right) * opts.zoom) + pad.left + pad.right)
  const plotW = width - pad.left - pad.right
  const axis = axisOf(spans, pad.left, plotW, opts.collapse ? GAP_MS : Infinity, GAP_PX)
  const x = axis.x
  const laneY = (i: number) => pad.top + i * LANE_H
  const extra = Math.max(0, tracks.length - 1) * (SUB + 3)
  const height = pad.top + LANE_NAMES.length * LANE_H + extra + 4
  const shapes: Shape[] = []

  const tick = TICKS_MS.find(t => t * axis.scale >= 80) ?? TICKS_MS[TICKS_MS.length - 1]!
  // a collapsed gap wide enough has its length on the time axis, so ticks
  // keep clear of it
  const GAP_LABEL_PX = 30
  const gapLabels = axis.gaps.filter(([from, to]) => x(to) - x(from) >= GAP_LABEL_PX).map(([from, to]) => (x(from) + x(to)) / 2)
  // and apart from each other, across a thin gap too
  let lastTick = -Infinity
  for (const [from, to] of axis.segments) {
    for (let t = Math.ceil(from / tick) * tick; t <= Math.min(to, t1); t += tick) {
      if (x(t) - lastTick < 56 || gapLabels.some(g => Math.abs(g - x(t)) < 56)) continue
      lastTick = x(t)
      shapes.push({ kind: 'line', class: 'stroke-border', x1: x(t), x2: x(t), y1: pad.top - 4, y2: height })
      const label = new Date(t).toLocaleTimeString(
        undefined,
        tick < MIN ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' },
      )
      shapes.push({ kind: 'text', class: 'fill-muted-foreground', x: x(t), y: 12, text: label })
    }
  }
  LANE_NAMES.forEach((_, i) => {
    const y = laneY(i) + LANE_H - 3 + (i === 3 ? extra : 0)
    shapes.push({ kind: 'line', class: 'stroke-muted-foreground/40', x1: pad.left, x2: width - pad.right, y1: y, y2: y })
  })

  const bar = (cls: string, start: number, end: number, lane: number, more: Partial<Extract<Shape, { kind: 'rect' }>> = {}): Shape => ({
    kind: 'rect',
    class: cls,
    x: x(start),
    y: laneY(lane) + 5,
    width: Math.max(3, x(end) - x(start)),
    height: LANE_H - 12,
    rx: 3,
    ...more,
  })

  // each collapsed gap: a soft band through the lanes, its length on top
  for (const [from, to] of axis.gaps) {
    const x0 = x(from)
    const w = x(to) - x0
    const tip = `<strong>Nothing for ${duration(to - from)}</strong>${clockTime(from)} to ${clockTime(to)}, collapsed`
    shapes.push({ kind: 'rect', class: 'fill-muted', x: x0, y: pad.top - 4, width: w, height: height - pad.top + 4, tip })
    if (w >= GAP_LABEL_PX)
      shapes.push({ kind: 'text', class: 'fill-muted-foreground font-semibold', x: x0 + w / 2, y: 12, text: duration(to - from) })
  }

  for (const d of drafts) {
    const outline = d.outcome === 'abandoned' ? 'fill-transparent stroke-(--typed) stroke-2' : YOU
    const cls = `${outline} ${PICKABLE}${d.id === selected ? ' stroke-foreground! stroke-2' : ''}`
    const when = d.line.midTurn ? '<br>sent while Claude was working' : ''
    const tip = `<strong>${d.outcome === 'sent' ? 'Prompt sent' : 'Draft abandoned'}</strong>${clockTime(d.start)}, ${seconds(d.end - d.start)} writing${when}${d.timeline ? '<br>click to replay' : ''}`
    shapes.push(bar(cls, d.start, d.end, 0, { tip, draft: d.id }))
    if (!d.timeline) continue
    // the pauses, hatched over the bar (denser for a break long enough to
    // stop counting as typing), each with its own tooltip
    const origin = Date.parse(d.timeline.startedAt)
    for (const p of pausesOf(d.timeline, PAUSE_MS)) {
      const start = origin + p.from
      const brk = p.to - p.from >= BREAK_MS
      const tip = `<strong>${brk ? 'Break' : 'Pause'}</strong>${seconds(p.to - p.from)}, from ${clockTime(start)}${brk ? '<br>not counted as typing time' : ''}`
      shapes.push({
        kind: 'rect',
        class: `cursor-pointer hover:stroke-foreground ${brk ? 'fill-[url(#hatch-break)]' : 'fill-[url(#hatch-pause)]'}`,
        x: x(start),
        y: laneY(0) + 5,
        width: Math.max(2, x(origin + p.to) - x(start)),
        height: LANE_H - 12,
        tip,
        draft: d.id,
      })
    }
  }
  for (const w of waits) {
    const what = w.kind === 'question' ? `Answering ${esc(w.tool)}` : `Permission for ${esc(w.tool) || 'a tool'}`
    const tip = `<strong>${what}</strong>${seconds(w.to - w.from)}, until ${clockTime(w.to)}<br>not counted as Claude working`
    shapes.push(bar('fill-(--typed)/45', w.from, w.to, 0, { tip }))
  }
  for (const t of turns) {
    const end = time(t)
    const pieces = piecesOf.get(t)!
    const waited = end - pieces[0]![0] - num(t.durationMs)
    const tip = `<strong>Claude ${t.event === 'interrupt' ? 'interrupted' : 'turn'}</strong>${seconds(num(t.durationMs))}${waited ? ` working, ${seconds(waited)} waiting on you` : ''}, ended ${clockTime(end)}`
    for (const [s, e] of pieces) shapes.push(bar('fill-(--neutral-2)', s, e, 1, { tip }))
    if (t.event === 'interrupt') {
      shapes.push({ kind: 'line', class: 'stroke-(--critical) stroke-2', x1: x(end), x2: x(end), y1: laneY(0) + 2, y2: laneY(2) })
      const running = Array.isArray(t.toolsRunning) && t.toolsRunning.length ? `<br>stopped ${esc(t.toolsRunning.join(', '))} mid-run` : ''
      const shown =
        typeof t.answerChars === 'number' ? `<br>${t.answerChars ? `${compact(t.answerChars)} chars of answer shown` : 'no answer shown yet'}` : ''
      shapes.push({
        kind: 'text',
        class: 'fill-(--critical) font-bold',
        x: x(end) + 3,
        y: laneY(1) + 4,
        text: '✕',
        start: true,
        tip: `<strong>Interrupt</strong>Esc during a turn${shown}${running}`,
      })
    }
  }
  // a prompt sent while Claude worked: a dashed drop from You into the turn
  for (const e of events) {
    if (e.event !== 'prompt' || !e.midTurn) continue
    const at = x(time(e))
    shapes.push({
      kind: 'line',
      class: 'stroke-muted-foreground stroke-2 [stroke-dasharray:3_3]',
      x1: at,
      x2: at,
      y1: laneY(0) + 4,
      y2: laneY(2) - 4,
      tip: `<strong>Sent mid-turn</strong>${clockTime(time(e))}, ${num(e.words)} words`,
    })
  }
  for (const t of tools) {
    const tip = `<strong>${esc(String(t.e.tool))}</strong>${seconds(t.end - t.start)} · ${esc(String(t.e.outcome ?? ''))}`
    shapes.push(bar('fill-(--neutral)', t.start, t.end, 2, { tip }))
  }
  // over the Claude lane, since an auto compaction lands mid-turn; a card
  // ring keeps it apart from the turn under it
  for (const c of compacts) {
    const end = time(c)
    const before = num(c.tokensBefore)
    const after = num(c.tokensAfter)
    const sizes = before ? `<br>${compact(before)} → ${after ? compact(after) : '?'} tokens` : ''
    const who = c.agentId ? ', a subagent' : ''
    const tip = `<strong>Compaction (${esc(String(c.trigger))}${who})</strong>${seconds(num(c.durationMs))}, ${esc(String(c.outcome))}${sizes}`
    const faded = c.agentId || c.trigger === 'precompute'
    shapes.push(bar(`stroke-card stroke-2 ${faded ? 'fill-foreground/30' : 'fill-foreground/70'}`, end - num(c.durationMs), end, 1, { tip }))
  }

  tracks.forEach((track, k) => {
    const y = laneY(3) + 5 + (k ? LANE_H - 12 + 3 + (k - 1) * (SUB + 3) : 0)
    const h = k ? SUB : LANE_H - 12
    for (const { project, span } of track) {
      const tip = `<strong>${esc(project)}</strong>${clockTime(span[0])} to ${clockTime(span[1])}, ${duration(span[1] - span[0])}${k ? '<br>alongside the main thread' : ''}`
      const x0 = x(span[0])
      shapes.push({
        kind: 'rect',
        class: '',
        x: x0,
        y,
        width: Math.max(3, x(span[1]) - x0),
        height: h,
        rx: k ? 2 : 3,
        fill: colors.color(project),
        tip,
      })
    }
  })

  return { width, height, axis, shapes, laneY }
}

// --- replay -------------------------------------------------------------

export const KINDS_LEGEND: [string, string][] = [
  ['bg-(--typed)', 'typed (above the line)'],
  ['bg-(--deleted)', 'deleted (below)'],
  ['bg-(--pasted)', 'pasted or typed over'],
  ['bg-(--neutral-2)', 'cursor move'],
  ['bg-(--neutral)', 'already in the box'],
]

const STRIP_H = 110
const STRIP_MID = 56
export const STRIP_PAD = 8
const MARK: Record<string, string> = {
  typed: 'fill-(--typed)',
  deleted: 'fill-(--deleted)',
  pasted: 'fill-(--pasted)',
  move: 'fill-(--neutral-2)',
  changed: 'fill-(--neutral-2)',
}

export type Clock = { length: number; toPlay: (ms: number) => number; toReal: (ms: number) => number }

// every edit over the draft's (squashed) time: typing above the line,
// deleting below, pauses as soft bands
export function strip(tl: Timeline, clock: Clock, fit: number) {
  const width = Math.max(Math.max(fit, 280), tl.steps.length * 3 + 20)
  const x = (real: number) => STRIP_PAD + (clock.toPlay(real) / Math.max(clock.length, 1)) * (width - STRIP_PAD * 2)
  const h = (n: number) => Math.min(44, 6 + Math.log2(1 + n) * 6)
  const shapes: Shape[] = []
  for (const p of pausesOf(tl, 2_000)) {
    const x0 = x(p.from)
    const w = x(p.to) - x0
    const tip = `<strong>Pause</strong>${seconds(p.to - p.from)}${p.to - p.from > 30_000 ? ', a break' : ''}`
    shapes.push({ kind: 'rect', class: 'fill-muted', x: x0, y: 4, width: w, height: STRIP_H - 8, rx: 3, tip })
    if (w > 30) shapes.push({ kind: 'text', class: 'fill-muted-foreground', x: x0 + w / 2, y: STRIP_H - 8, text: seconds(p.to - p.from) })
  }
  shapes.push({ kind: 'line', class: 'stroke-muted-foreground/40', x1: STRIP_PAD, x2: width - STRIP_PAD, y1: STRIP_MID, y2: STRIP_MID })
  for (const st of tl.steps) {
    const [, kind, , removed = 0, shape = ''] = st
    const g = groupOf(kind)
    const cx = x(st[0])
    // replacing shows as both: what went in above, what came out below
    if (kind === 'r') {
      const up = h(shape.length)
      shapes.push({ kind: 'rect', class: MARK.pasted!, x: cx - 1, y: STRIP_MID - up, width: 2, height: up })
      shapes.push({ kind: 'rect', class: MARK.deleted!, x: cx - 1, y: STRIP_MID, width: 2, height: h(removed) })
    } else if (g === 'changed') shapes.push({ kind: 'rect', class: MARK[g]!, x: cx - 1, y: 6, width: 2, height: STRIP_H - 24, rx: 1 })
    else if (shape.length || removed) {
      const up = shape.length ? h(shape.length) : 0
      const down = removed ? h(removed) : 0
      shapes.push({ kind: 'rect', class: MARK[g]!, x: cx - 1, y: STRIP_MID - up, width: 2, height: up + down, rx: 1 })
    } else shapes.push({ kind: 'rect', class: MARK[g]!, x: cx - 1, y: STRIP_MID - 3, width: 2, height: 6, rx: 1 })
    // a wider invisible target, so a 2px mark is easy to hover
    shapes.push({
      kind: 'rect',
      class: 'fill-transparent',
      x: cx - 4,
      y: 0,
      width: 8,
      height: STRIP_H,
      tip: `<strong>${esc(describe(st))}</strong>at ${seconds(st[0])}`,
    })
  }
  return { width, height: STRIP_H, shapes }
}

// The box as of `real` ms into the draft, kept between calls so playing
// forward only applies the new steps
export function replayer(tl: Timeline) {
  let cached: State | undefined
  let cachedAt = -Infinity
  return (real: number) => {
    if (!cached || real < cachedAt) {
      cached = initialState(tl)
      cachedAt = -Infinity
    }
    while (cached.applied < tl.steps.length && tl.steps[cached.applied]![0] <= real) apply(cached, tl.steps[cached.applied]!)
    cachedAt = real
    return cached
  }
}

const MAX_CELLS = 6_000
const CELL: Record<Source, string> = { before: 'bg-(--neutral)', typed: 'bg-(--typed)', pasted: 'bg-(--pasted)', changed: 'bg-(--neutral)' }

// The prompt box as shapes, a cell per character: it redraws every frame
// while playing, so it's one string rather than thousands of nodes
export function boxHtml(tl: Timeline, state: State, real: number) {
  const last: Step | undefined = tl.steps[state.applied - 1]
  const deleting = last && groupOf(last[1]) === 'deleted' && real - last[0] < 400
  const fresh = (at: number) => at >= 0 && real - at < 250
  let html = ''
  let word = ''
  let wordCells = 0
  // a word keeps together, but a long run (a paste) may wrap
  const flush = () => {
    if (word) html += wordCells > 40 ? word : `<span class="inline-block whitespace-nowrap">${word}</span>`
    word = ''
    wordCells = 0
  }
  const cursor = `<span class="my-px mr-px inline-block h-4 align-top ${deleting ? 'w-[3px] bg-(--deleted)' : 'w-0.5 bg-foreground'}"></span>`
  const cells = state.cells.slice(0, MAX_CELLS)
  cells.forEach((cell, i) => {
    if (i === state.cursor) word += cursor
    if (cell.ch === 'a') {
      word += `<span class="mt-[3px] mr-px mb-[3px] inline-block h-3 w-[7px] rounded-[2px] align-top ${CELL[cell.src]}${fresh(cell.at) ? ' outline-2 -outline-offset-1 outline-foreground' : ''}"></span>`
      wordCells++
    } else {
      flush()
      html += cell.ch === '\n' ? '<br>' : '<span class="inline-block h-[18px] w-2"></span>'
    }
  })
  if (state.cursor >= cells.length) word += cursor
  flush()
  if (state.cells.length > MAX_CELLS) html += `<span class="text-xs text-muted-foreground"> +${state.cells.length - MAX_CELLS} more</span>`
  return { html, step: last ? `${describe(last)} · at ${seconds(last[0])}` : 'the box as the draft began' }
}

export function draftStats(d: Draft) {
  const l = d.line
  const groups = d.timeline ? countGroups(d.timeline) : undefined
  return [
    { label: 'Writing', value: seconds(d.end - d.start), sub: `${seconds(num(l.typingMs))} of it typing` },
    { label: 'Edits', value: String(num(l.edits)), sub: groups ? `${groups.move} cursor moves` : '' },
    { label: 'Typed', value: String(num(l.typedChars)), sub: [`${num(l.pastedChars)} pasted`, attachments(l)].filter(Boolean).join(' · ') },
    { label: 'Deleted', value: String(num(l.deletedChars)), sub: `${num(l.wordDeletes)} word, ${num(l.lineKills)} line` },
    { label: 'Fixes / rewrites', value: `${num(l.fixes)} / ${num(l.rewrites)}`, sub: `${num(l.rewrittenChars)} chars redone` },
    { label: 'Pauses', value: String(num(l.pauses)), sub: `${num(l.breaks)} breaks, longest ${seconds(num(l.longestPauseMs))}` },
  ]
}

// a row of the drafts table
export function draftRow(d: Draft) {
  const l = d.line
  return [
    clockTime(d.start),
    d.outcome === 'sent' ? 'sent' : `abandoned (${String(l.how ?? '?')})`,
    seconds(d.end - d.start),
    seconds(num(l.typingMs)),
    String(num(l.edits)),
    String(num(l.fixes)),
    String(num(l.rewrites)),
    String(num(l.wordDeletes)),
    seconds(num(l.longestPauseMs)),
  ]
}
export const DRAFT_HEAD = ['Started', 'Outcome', 'Writing', 'Typing', 'Edits', 'Fixes', 'Rewrites', 'Word del', 'Longest pause']
