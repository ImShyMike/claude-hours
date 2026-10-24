// The session page's drawing, worked out as rows, shapes and strings for
// its Svelte components to put on the page: the lanes of who was doing
// what, the drafts, and a draft's replay
import { projectSpans, turnPieces, waitsOf, type Event, type Interval } from '../analytics/aggregate'
import { apply, countGroups, describe, groupOf, initialState, pausesOf, type Source, type State, type Step, type Timeline } from '../analytics/replay'
import { toolName } from './overview'
import { ROW, type Bar, type Mark, type Row } from './rows'
import { MIN, attachments, clockTime, compact, duration, esc, modelName, seconds, type Palette } from './shared'

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
const modelOf = (e: Event) => {
  const model = (e.usage as { model?: unknown } | undefined)?.model
  return typeof model === 'string' ? modelName(model) : undefined
}

// a tool call's card: the file it worked on and the repo, when the mod knew them
function toolTip(e: Event, ms: number) {
  const repo = typeof e.repoName === 'string' ? e.repoName : typeof e.repo === 'string' ? e.repo.split('/').pop() : undefined
  // the reader makes paths whole again; under the working dir they read better short
  const path = typeof e.file === 'string' && typeof e.cwd === 'string' && e.file.startsWith(`${e.cwd}/`) ? e.file.slice(e.cwd.length + 1) : e.file
  const file = typeof path === 'string' ? `<br>${esc(path)}` : ''
  return `<strong>${esc(toolName(String(e.tool)))}</strong>${seconds(num(e.durationMs))} · ${esc(String(e.outcome ?? ''))}${file}${repo ? `<br>in ${esc(repo)}` : ''}`
}

// Each subagent's runs (its turns, or the stretch of its tool calls when no
// turn ended) and its calls, a track apiece; ones that never overlap share
// a track, so a long session doesn't grow a row per agent
function subagents(events: Event[], tools: { start: number; end: number; e: Event }[]) {
  const byId = new Map<string, { runs: { from: number; to: number; model?: string }[]; tools: typeof tools }>()
  const of = (id: string) => byId.get(id) ?? byId.set(id, { runs: [], tools: [] }).get(id)!
  for (const t of tools) if (typeof t.e.agentId === 'string') of(t.e.agentId).tools.push(t)
  for (const e of events) {
    if ((e.event !== 'turn_end' && e.event !== 'interrupt') || typeof e.agentId !== 'string') continue
    of(e.agentId).runs.push({ from: time(e) - num(e.durationMs), to: time(e), model: modelOf(e) })
  }
  const agents = [...byId].map(([id, a]) => {
    if (!a.runs.length) a.runs.push({ from: Math.min(...a.tools.map(t => t.start)), to: Math.max(...a.tools.map(t => t.end)) })
    const ends = [...a.runs.flatMap(r => [r.from, r.to]), ...a.tools.flatMap(t => [t.start, t.end])]
    return { id, ...a, from: Math.min(...ends), to: Math.max(...ends), track: 0 }
  })
  agents.sort((a, b) => a.from - b.from)
  const tracks: number[] = []
  for (const a of agents) {
    a.track = tracks.findIndex(end => end <= a.from)
    if (a.track < 0) a.track = tracks.length
    tracks[a.track] = a.to
  }
  return { agents, tracks: tracks.length }
}

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

// With gaps collapsed, a quiet stretch longer than this is squashed into a break
export const GAP_MS = 5 * MIN
// the mod's own thresholds: a gap this long is a pause, and one this long a
// break that stops counting as typing time
const PAUSE_MS = 2_000
const BREAK_MS = 30_000

// what's drawn on the replay strip, class names in full so Tailwind finds them
export type Shape =
  | { kind: 'rect'; class: string; x: number; y: number; width: number; height: number; rx?: number; tip?: string }
  | { kind: 'line'; class: string; x1: number; x2: number; y1: number; y2: number; tip?: string }
  | { kind: 'text'; class: string; x: number; y: number; text: string; tip?: string }

const SENT = 'bg-(--typed)'
const ABANDONED = 'border-2 border-(--typed)'
const PAUSE = 'bg-[repeating-linear-gradient(45deg,var(--typed)_0_2px,var(--card)_2px_4px)]'
const BREAK = 'bg-[repeating-linear-gradient(45deg,var(--typed)_0_2px,var(--card)_2px_8px)]'
const MID_TURN = 'border-l-2 border-dashed border-muted-foreground'
// faint, so the tool calls drawn over it show
const SUBAGENT = 'bg-(--neutral)/40'
// in the text's color, a little taller than a turn and never thinner than a few px, so a
// minute's compaction stands out in an hour's session
const COMPACTING = 'min-w-1.5! bg-foreground'

// the lanes' legend: a swatch's classes and what it means
export const LANES_LEGEND: [string, string][] = [
  [SENT, 'writing a prompt'],
  [ABANDONED, 'abandoned draft'],
  [PAUSE, 'paused while writing'],
  ['bg-(--typed)/45', 'answering Claude'],
  ['bg-(--neutral-2)', 'Claude working'],
  [COMPACTING, 'compacting'],
  ['bg-(--neutral)', 'tool call'],
  [SUBAGENT, 'subagent running'],
  ['bg-(--critical)', 'interrupt'],
  ['w-[3px] bg-[repeating-linear-gradient(to_bottom,var(--muted-foreground)_0_3px,transparent_3px_5px)]', 'sent mid-turn'],
]

// The session as rows for the time-rows chart: what you did, what Claude
// did, its tool calls, and the projects the time went to. `spans` is every
// moment drawn, so a collapsed gap is only ever an empty one
export function laneRows(opts: {
  events: Event[]
  drafts: Draft[]
  tracks: ProjectPiece[][]
  colors: Palette
  selected?: string
  onpick: (draft: string) => void
}): { rows: Row[]; spans: Interval[] } {
  const { events, drafts, tracks, colors, selected, onpick } = opts
  const turns = events.filter(e => (e.event === 'turn_end' || e.event === 'interrupt') && !e.agentId)
  const compacts = events.filter(e => e.event === 'compact')
  // a tool row is written when the call ends, so it starts durationMs earlier
  const tools = events.filter(e => e.event === 'tool').map(e => ({ start: time(e) - num(e.durationMs), end: time(e), e }))
  const agents = subagents(events, tools)

  // a question or plan waiting on the person is their time: it goes on the
  // You lane, and the turn around it is drawn in pieces on either side
  const waits = waitsOf(events)
  const piecesOf = new Map(turns.map(t => [t, turnPieces(time(t), num(t.durationMs), waits)]))
  const spans: Interval[] = [
    ...events.map((e): Interval => [time(e), time(e)]),
    ...drafts.map((d): Interval => [d.start, d.end]),
    ...[...piecesOf.values()].flat(),
    ...compacts.map((c): Interval => [time(c) - num(c.durationMs), time(c)]),
    ...tools.map((t): Interval => [t.start, t.end]),
    ...agents.agents.flatMap(a => a.runs.map((r): Interval => [r.from, r.to])),
    ...waits.map((w): Interval => [w.from, w.to]),
  ]

  const bar = (cls: string, from: number, to: number, more: Partial<Bar> = {}): Bar => ({ from, to, top: 0, height: ROW.main, class: cls, ...more })
  const you: Bar[] = []
  const claude: Bar[] = []
  const youMarks: Mark[] = []
  const claudeMarks: Mark[] = []

  for (const d of drafts) {
    const when = d.line.midTurn ? '<br>sent while Claude was working' : ''
    const tip = `<strong>${d.outcome === 'sent' ? 'Prompt sent' : 'Draft abandoned'}</strong>${clockTime(d.start)}, ${seconds(d.end - d.start)} writing${when}${d.timeline ? '<br>click to replay' : ''}`
    const pick = { onclick: () => onpick(d.id), group: d.id }
    you.push(bar(d.outcome === 'abandoned' ? ABANDONED : SENT, d.start, d.end, { tip, selected: d.id === selected, ...pick }))
    if (!d.timeline) continue
    // the pauses, hatched over the bar (wider for a break long enough to
    // stop counting as typing), each with its own tooltip
    const origin = Date.parse(d.timeline.startedAt)
    for (const p of pausesOf(d.timeline, PAUSE_MS)) {
      const start = origin + p.from
      const brk = p.to - p.from >= BREAK_MS
      const tip = `<strong>${brk ? 'Break' : 'Pause'}</strong>${seconds(p.to - p.from)}, from ${clockTime(start)}${brk ? '<br>not counted as typing time' : ''}`
      you.push(bar(brk ? BREAK : PAUSE, start, origin + p.to, { tip, plain: true, ...pick }))
    }
  }
  for (const w of waits) {
    const what = w.kind === 'question' ? `Answering ${esc(w.tool)}` : `Permission for ${esc(w.tool) || 'a tool'}`
    const tip = `<strong>${what}</strong>${seconds(w.to - w.from)}, until ${clockTime(w.to)}<br>not counted as Claude working`
    you.push(bar('bg-(--typed)/45', w.from, w.to, { tip }))
  }
  for (const t of turns) {
    const end = time(t)
    const pieces = piecesOf.get(t)!
    const waited = end - pieces[0]![0] - num(t.durationMs)
    const model = modelOf(t)
    const by = model ? `<br>${esc(model)}` : ''
    const tip = `<strong>Claude ${t.event === 'interrupt' ? 'interrupted' : 'turn'}</strong>${seconds(num(t.durationMs))}${waited ? ` working, ${seconds(waited)} waiting on you` : ''}, ended ${clockTime(end)}${by}`
    for (const [s, e] of pieces) claude.push(bar('bg-(--neutral-2)', s, e, { tip }))
    if (t.event !== 'interrupt') continue
    // a red line down from You into the turn it stopped
    const running = Array.isArray(t.toolsRunning) && t.toolsRunning.length ? `<br>stopped ${esc(t.toolsRunning.join(', '))} mid-run` : ''
    const shown =
      typeof t.answerChars === 'number' ? `<br>${t.answerChars ? `${compact(t.answerChars)} chars of answer shown` : 'no answer shown yet'}` : ''
    const mark = { at: end, class: 'border-l-2 border-(--critical)', tip: `<strong>Interrupt</strong>Esc during a turn${shown}${running}` }
    youMarks.push(mark)
    claudeMarks.push({ ...mark, glyph: '✕', glyphClass: 'text-(--critical)' })
  }
  // a prompt sent while Claude worked: a dashed drop from You into the turn
  for (const e of events) {
    if (e.event !== 'prompt' || !e.midTurn) continue
    const mark = { at: time(e), class: MID_TURN, tip: `<strong>Sent mid-turn</strong>${clockTime(time(e))}, ${num(e.words)} words` }
    youMarks.push(mark)
    claudeMarks.push(mark)
  }
  // over the Claude lane, since an auto compaction lands mid-turn; its card
  // ring keeps it apart from the turn under it. The context's size before
  // and after is in its card
  for (const c of compacts) {
    const end = time(c)
    const before = num(c.tokensBefore)
    const after = num(c.tokensAfter)
    const shrunk = before && after ? `, ${Math.round((1 - after / before) * 100)}% smaller` : ''
    const sizes = before ? `<br>context ${compact(before)} → ${after ? compact(after) : '?'} tokens${shrunk}` : ''
    const who = c.agentId ? ', a subagent' : ''
    const tip = `<strong>Compaction (${esc(String(c.trigger))}${who})</strong>${seconds(num(c.durationMs))}, ${esc(String(c.outcome))}${sizes}`
    const faded = c.agentId || c.trigger === 'precompute'
    const from = end - num(c.durationMs)
    claude.push(faded ? bar('bg-foreground/30', from, end, { tip }) : bar(COMPACTING, from, end, { tip, top: -3, height: ROW.main + 6 }))
  }
  // the main thread's calls; a subagent's go on its own track
  const toolBars = tools
    .filter(t => typeof t.e.agentId !== 'string')
    .map(t => bar('bg-(--neutral)', t.start, t.end, { tip: toolTip(t.e, t.end - t.start) }))
  // a subagent's run faint, its calls over it, and the lot lit up together
  const agentBars = agents.agents.flatMap(a => {
    const top = a.track * (ROW.sub + ROW.gap)
    const calls = `${a.tools.length} tool ${a.tools.length === 1 ? 'call' : 'calls'}`
    const runs = a.runs.map(r => {
      const tip = `<strong>Subagent</strong>${seconds(r.to - r.from)} · ${calls}, ended ${clockTime(r.to)}${r.model ? `<br>${esc(r.model)}` : ''}`
      return bar(SUBAGENT, r.from, r.to, { top, height: ROW.sub, group: a.id, tip })
    })
    const own = a.tools.map(t =>
      bar('bg-(--neutral)', t.start, t.end, { top, height: ROW.sub, group: a.id, plain: true, tip: toolTip(t.e, t.end - t.start) }),
    )
    return [...runs, ...own]
  })
  const projects = tracks.flatMap((track, k) =>
    track.map(({ project, span }) => ({
      from: span[0],
      to: span[1],
      top: k ? ROW.main + ROW.gap + (k - 1) * (ROW.sub + ROW.gap) : 0,
      height: k ? ROW.sub : ROW.main,
      color: colors.color(project),
      tip: `<strong>${esc(project)}</strong>${clockTime(span[0])} to ${clockTime(span[1])}, ${duration(span[1] - span[0])}${k ? '<br>alongside the main thread' : ''}`,
    })),
  )
  const rows: Row[] = [
    { key: 'you', label: 'You', height: ROW.main, bars: you, marks: youMarks },
    { key: 'claude', label: 'Claude', height: ROW.main, bars: claude, marks: claudeMarks },
    ...(agents.tracks
      ? [
          {
            key: 'agents',
            label: 'Subagents',
            sub: `${agents.agents.length} ran`,
            height: agents.tracks * ROW.sub + (agents.tracks - 1) * ROW.gap,
            bars: agentBars,
          },
        ]
      : []),
    { key: 'tools', label: 'Tools', height: ROW.main, bars: toolBars },
    { key: 'projects', label: 'Projects', height: ROW.main + Math.max(0, tracks.length - 1) * (ROW.sub + ROW.gap), bars: projects },
  ]
  return { rows, spans }
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
      tip: `<strong>${esc(describe(st))}</strong>${seconds(st[0])} in`,
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
  return { html, step: last ? `${describe(last)} · ${seconds(last[0])} in` : 'the box as the draft began' }
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
