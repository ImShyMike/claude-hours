import type { Event } from '../src/aggregate'
import {
  apply,
  countGroups,
  describe,
  durationOf,
  groupOf,
  initialState,
  pausesOf,
  squash,
  type State,
  type Step,
  type Timeline,
} from '../src/replay'
import { $, MIN, clockTime, compact, duration, esc, hideTip, load, save, seconds, showTip } from './shared'

const sessionId = new URLSearchParams(location.search).get('id') ?? ''

// a draft as the main log tells it, with its replay if the sidecar has one
type Draft = {
  id: string
  outcome: 'sent' | 'abandoned'
  start: number
  end: number
  line: Event
  timeline?: Timeline
}

let events: Event[] = []
let drafts: Draft[] = []
let selected: Draft | undefined
let zoom = Number(load('zoom', '1'))

// the mod's own thresholds: a gap this long is a pause, and one this long a
// break that stops counting as typing time
const PAUSE_MS = 2_000
const BREAK_MS = 30_000

// a pause shows the surface through blue stripes, tighter for a short pause
// and wider for a break, so both read as "not typing" inside the bar
const hatch = (id: string, gap: number) =>
  `<pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="${gap}" height="${gap}"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="${gap}"/></pattern>`
const PAUSE_PATTERNS = `<defs>${hatch('hatch-pause', 4)}${hatch('hatch-break', 8)}</defs>`

const time = (e: Event) => Date.parse(e.ts)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

// --- data ---------------------------------------------------------------

function buildDrafts(timelines: Timeline[]): Draft[] {
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

// --- session timeline ---------------------------------------------------

const TICKS_MS = [10_000, 30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN]

function drawLanes() {
  const el = $('lanes')
  const turns = events.filter(e => (e.event === 'turn_end' || e.event === 'interrupt') && !e.agentId)
  const compacts = events.filter(e => e.event === 'compact')
  const starts = new Map<string, Event>()
  const tools: { start: number; end: number; e: Event }[] = []
  for (const e of events) {
    if (e.event === 'tool_start' && typeof e.toolUseId === 'string') starts.set(e.toolUseId, e)
    if (e.event === 'tool_end' && typeof e.toolUseId === 'string') {
      const s = starts.get(e.toolUseId)
      tools.push({ start: s ? time(s) : time(e) - num(e.durationMs), end: time(e), e })
    }
  }

  const all = [
    ...events.map(time),
    ...drafts.map(d => d.start),
    ...turns.map(t => time(t) - num(t.durationMs)),
    ...compacts.map(c => time(c) - num(c.durationMs)),
  ]
  const t0 = Math.min(...all)
  const t1 = Math.max(...events.map(time), ...drafts.map(d => d.end))
  const span = Math.max(t1 - t0, 10_000)

  const fit = Math.max(el.parentElement!.clientWidth, 280)
  const pad = { left: 64, right: 12, top: 22 }
  const width = Math.max(fit, Math.round((fit - pad.left - pad.right) * zoom) + pad.left + pad.right)
  const plotW = width - pad.left - pad.right
  const x = (ms: number) => pad.left + ((ms - t0) / span) * plotW
  const LANE = 30
  const lanes = ['You', 'Claude', 'Tools']
  const laneY = (i: number) => pad.top + i * LANE
  const height = pad.top + lanes.length * LANE + 4

  const tick = TICKS_MS.find(t => (t / span) * plotW >= 80) ?? TICKS_MS[TICKS_MS.length - 1]!
  let svg = ''
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    svg += `<line class="gridline" x1="${x(t)}" x2="${x(t)}" y1="${pad.top - 4}" y2="${height}"/>`
    const label = new Date(t).toLocaleTimeString(undefined, tick < MIN ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' })
    svg += `<text x="${x(t)}" y="12" text-anchor="middle">${label}</text>`
  }
  lanes.forEach((name, i) => {
    svg += `<text class="lane-label" x="0" y="${laneY(i) + LANE / 2 + 4}">${name}</text>`
    svg += `<line class="baseline" x1="${pad.left}" x2="${width - pad.right}" y1="${laneY(i) + LANE - 3}" y2="${laneY(i) + LANE - 3}"/>`
  })

  const bar = (cls: string, start: number, end: number, lane: number, attrs = '') => {
    const x0 = x(start)
    const w = Math.max(3, x(end) - x0)
    return `<rect class="${cls}" x="${x0}" y="${laneY(lane) + 5}" width="${w}" height="${LANE - 12}" rx="3" ${attrs}/>`
  }
  const tips: string[] = []
  const tipAttr = (html: string) => `data-tip="${tips.push(html) - 1}"`

  drafts.forEach((d, i) => {
    const cls = `span-you ${d.outcome}${d === selected ? ' selected' : ''}`
    const when = d.line.midTurn ? '<br>sent while Claude was working' : ''
    const tip = `<strong>${d.outcome === 'sent' ? 'Prompt sent' : 'Draft abandoned'}</strong>${clockTime(d.start)}, ${seconds(d.end - d.start)} writing${when}${d.timeline ? '<br>click to replay' : ''}`
    svg += bar(cls, d.start, d.end, 0, `data-draft="${i}" ${tipAttr(tip)}`)
    if (!d.timeline) return
    // the pauses, hatched over the bar (denser for a break long enough to
    // stop counting as typing), each with its own tooltip
    const origin = Date.parse(d.timeline.startedAt)
    for (const p of pausesOf(d.timeline, PAUSE_MS)) {
      const start = origin + p.from
      const kind = p.to - p.from >= BREAK_MS ? 'break' : 'pause'
      const pauseTip = `<strong>${kind === 'break' ? 'Break' : 'Pause'}</strong>${seconds(p.to - p.from)}, from ${clockTime(start)}${kind === 'break' ? '<br>not counted as typing time' : ''}`
      svg += `<rect class="pause-mark ${kind}" x="${x(start)}" y="${laneY(0) + 5}" width="${Math.max(2, x(origin + p.to) - x(start))}" height="${LANE - 12}" data-draft="${i}" ${tipAttr(pauseTip)}/>`
    }
  })
  for (const t of turns) {
    const end = time(t)
    const tip = `<strong>Claude ${t.event === 'interrupt' ? 'interrupted' : 'turn'}</strong>${seconds(num(t.durationMs))}, ended ${clockTime(end)}`
    svg += bar('span-claude', end - num(t.durationMs), end, 1, tipAttr(tip))
    if (t.event === 'interrupt') {
      svg += `<line class="interrupt" x1="${x(end)}" x2="${x(end)}" y1="${laneY(0) + 2}" y2="${laneY(2)}"/>`
      const running = Array.isArray(t.toolsRunning) && t.toolsRunning.length ? `<br>stopped ${esc(t.toolsRunning.join(', '))} mid-run` : ''
      const shown = typeof t.answerChars === 'number' ? `<br>${t.answerChars ? `${compact(t.answerChars)} chars of answer shown` : 'no answer shown yet'}` : ''
      svg += `<text class="interrupt-mark" x="${x(end) + 3}" y="${laneY(1) + 4}" ${tipAttr(`<strong>Interrupt</strong>Esc during a turn${shown}${running}`)}>✕</text>`
    }
  }
  // a prompt sent while Claude worked: a dashed drop from You into the turn
  for (const e of events) {
    if (e.event !== 'prompt' || !e.midTurn) continue
    const at = x(time(e))
    svg += `<line class="mid-turn" x1="${at}" x2="${at}" y1="${laneY(0) + 4}" y2="${laneY(2) - 4}" ${tipAttr(`<strong>Sent mid-turn</strong>${clockTime(time(e))}, ${num(e.words)} words`)}/>`
  }
  for (const t of tools) {
    const tip = `<strong>${esc(String(t.e.tool))}</strong>${seconds(t.end - t.start)} · ${esc(String(t.e.outcome ?? ''))}`
    svg += bar('span-tool', t.start, t.end, 2, tipAttr(tip))
  }
  // over the Claude lane, since an auto compaction lands mid-turn
  for (const c of compacts) {
    const end = time(c)
    const before = num(c.tokensBefore)
    const after = num(c.tokensAfter)
    const sizes = before ? `<br>${compact(before)} → ${after ? compact(after) : '?'} tokens` : ''
    const who = c.agentId ? ', a subagent' : ''
    const tip = `<strong>Compaction (${esc(String(c.trigger))}${who})</strong>${seconds(num(c.durationMs))}, ${esc(String(c.outcome))}${sizes}`
    svg += bar(`span-compact${c.agentId || c.trigger === 'precompute' ? ' background' : ''}`, end - num(c.durationMs), end, 1, tipAttr(tip))
  }

  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Session timeline">${PAUSE_PATTERNS}${svg}</svg>`
  el.querySelectorAll<SVGElement>('[data-tip]').forEach(node => {
    node.addEventListener('mousemove', e => showTip(e, tips[Number(node.dataset.tip)]!))
    node.addEventListener('mouseleave', hideTip)
  })
  el.querySelectorAll<SVGElement>('[data-draft]').forEach(node => {
    node.style.cursor = 'pointer'
    node.addEventListener('click', () => select(drafts[Number(node.dataset.draft)]!))
  })
}

// --- drafts table -------------------------------------------------------

function drawTable() {
  const head = ['Started', 'Outcome', 'Writing', 'Typing', 'Edits', 'Fixes', 'Rewrites', 'Word del', 'Longest pause']
  const rows = drafts.map((d, i) => {
    const l = d.line
    const cells = [
      clockTime(d.start),
      d.outcome === 'sent' ? 'sent' : `abandoned (${esc(String(l.how ?? '?'))})`,
      seconds(d.end - d.start),
      seconds(num(l.typingMs)),
      String(num(l.edits)),
      String(num(l.fixes)),
      String(num(l.rewrites)),
      String(num(l.wordDeletes)),
      seconds(num(l.longestPauseMs)),
    ]
    const cls = `pick${d === selected ? ' selected' : ''}`
    return `<tr class="${cls}" data-draft="${i}">${cells.map((c, j) => `<td${j > 1 ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`
  })
  $('drafts').innerHTML =
    `<tr>${head.map((h, j) => `<th${j > 1 ? ' class="num"' : ''}>${h}</th>`).join('')}</tr>` +
    (rows.join('') || `<tr><td colspan="${head.length}" class="muted">no typed drafts in this session yet</td></tr>`)
  $('drafts').querySelectorAll<HTMLElement>('tr[data-draft]').forEach(row =>
    row.addEventListener('click', () => select(drafts[Number(row.dataset.draft)]!)),
  )
}

// --- replay -------------------------------------------------------------

let tl: Timeline | undefined
let clock = { length: 0, toPlay: (ms: number) => ms, toReal: (ms: number) => ms }
let playMs = 0
let playing = false
let lastFrame = 0
// the box as of `cachedAt` real ms, so playing forward only applies new steps
let cached: State | undefined
let cachedAt = -Infinity

const MAX_CELLS = 6_000

function stateFor(real: number) {
  if (!tl) return undefined
  if (!cached || real < cachedAt) {
    cached = initialState(tl)
    cachedAt = -Infinity
  }
  while (cached.applied < tl.steps.length && tl.steps[cached.applied]![0] <= real) apply(cached, tl.steps[cached.applied]!)
  cachedAt = real
  return cached
}

function drawBox(real: number) {
  const state = stateFor(real)
  if (!state || !tl) return
  const last: Step | undefined = tl.steps[state.applied - 1]
  const deleting = last && groupOf(last[1]) === 'deleted' && real - last[0] < 400
  const fresh = (at: number) => at >= 0 && real - at < 250
  let html = ''
  let word = ''
  let wordCells = 0
  // a word keeps together, but a long run (a paste) may wrap
  const flush = () => {
    if (word) html += wordCells > 40 ? word : `<span class="w">${word}</span>`
    word = ''
    wordCells = 0
  }
  const cursor = `<span class="cur${deleting ? ' deleting' : ''}"></span>`
  const cells = state.cells.slice(0, MAX_CELLS)
  cells.forEach((cell, i) => {
    if (i === state.cursor) word += cursor
    if (cell.ch === 'a') {
      word += `<span class="c k-${cell.src}${fresh(cell.at) ? ' fresh' : ''}"></span>`
      wordCells++
    }
    else {
      flush()
      html += cell.ch === '\n' ? '<br>' : '<span class="sp"></span>'
    }
  })
  if (state.cursor >= cells.length) word += cursor
  flush()
  if (state.cells.length > MAX_CELLS) html += `<span class="muted" style="font-size:12px"> +${state.cells.length - MAX_CELLS} more</span>`
  $('box').innerHTML = html

  $('step').textContent = last ? `${describe(last)} · at ${seconds(last[0])}` : 'the box as the draft began'
}

function drawStrip() {
  if (!tl) return
  const el = $('strip')
  const fit = Math.max(el.parentElement!.clientWidth, 280)
  const width = Math.max(fit, tl.steps.length * 3 + 20)
  const height = 110
  const mid = 56
  const pad = 8
  const x = (real: number) => pad + (clock.toPlay(real) / Math.max(clock.length, 1)) * (width - pad * 2)
  const h = (n: number) => Math.min(44, 6 + Math.log2(1 + n) * 6)

  let svg = ''
  for (const p of pausesOf(tl, 2_000)) {
    const x0 = x(p.from)
    const w = x(p.to) - x0
    svg += `<rect class="pause" data-pause="${p.to - p.from}" x="${x0}" y="4" width="${w}" height="${height - 8}" rx="3"/>`
    if (w > 30) svg += `<text x="${x0 + w / 2}" y="${height - 8}" text-anchor="middle">${seconds(p.to - p.from)}</text>`
  }
  svg += `<line class="baseline" x1="${pad}" x2="${width - pad}" y1="${mid}" y2="${mid}"/>`
  tl.steps.forEach((st, i) => {
    const [, kind, , removed = 0, shape = ''] = st
    const g = groupOf(kind)
    const cx = x(st[0])
    let y = mid - 3
    let hh = 6
    if (g === 'changed') {
      y = 6
      hh = height - 24
    } else if (shape.length || removed) {
      const up = shape.length ? h(shape.length) : 0
      const down = removed ? h(removed) : 0
      y = mid - up
      hh = up + down
    }
    // replacing shows as both: what went in above, what came out below
    if (kind === 'r') {
      const up = h(shape.length)
      const down = h(removed)
      svg += `<rect class="m-pasted" x="${cx - 1}" y="${mid - up}" width="2" height="${up}"/>`
      svg += `<rect class="m-deleted" x="${cx - 1}" y="${mid}" width="2" height="${down}"/>`
    } else svg += `<rect class="m-${g}" x="${cx - 1}" y="${y}" width="2" height="${hh}" rx="1"/>`
    svg += `<rect class="hit" data-step="${i}" x="${cx - 4}" y="0" width="8" height="${height}"/>`
  })
  svg += `<line class="playhead" id="playhead" x1="${pad}" x2="${pad}" y1="2" y2="${height - 2}"/>`
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Every edit over time: typing above the line, deleting below">${svg}</svg>`

  const svgEl = el.querySelector('svg')!
  el.querySelectorAll<SVGRectElement>('.pause').forEach(rect => {
    const ms = Number(rect.dataset.pause)
    rect.addEventListener('mousemove', e => showTip(e, `<strong>Pause</strong>${seconds(ms)}${ms > 30_000 ? ', a break' : ''}`))
    rect.addEventListener('mouseleave', hideTip)
  })
  el.querySelectorAll<SVGRectElement>('.hit').forEach(hit => {
    const st = tl!.steps[Number(hit.dataset.step)]!
    hit.addEventListener('mousemove', e => showTip(e, `<strong>${esc(describe(st))}</strong>at ${seconds(st[0])}`))
    hit.addEventListener('mouseleave', hideTip)
  })
  svgEl.addEventListener('click', e => {
    const box = svgEl.getBoundingClientRect()
    const frac = (e.clientX - box.left - pad) / (box.width - pad * 2)
    seek(Math.max(0, Math.min(1, frac)) * clock.length)
  })
}

function drawPlayhead() {
  const line = document.getElementById('playhead') as SVGLineElement | null
  if (!line || !tl) return
  const svg = line.ownerSVGElement!
  const width = Number(svg.getAttribute('width'))
  const xp = 8 + (playMs / Math.max(clock.length, 1)) * (width - 16)
  line.setAttribute('x1', String(xp))
  line.setAttribute('x2', String(xp))
}

function seek(play: number) {
  playMs = Math.max(0, Math.min(play, clock.length))
  const real = clock.toReal(playMs)
  drawBox(real)
  drawPlayhead()
  $<HTMLInputElement>('scrub').value = String(clock.length ? Math.round((playMs / clock.length) * 1000) : 0)
  $('time').textContent = `${seconds(real)} / ${seconds(tl ? durationOf(tl) : 0)}`
}

function frame(now: number) {
  if (!playing) return
  const speed = Number($<HTMLSelectElement>('speed').value)
  playMs += (now - lastFrame) * speed
  lastFrame = now
  if (playMs >= clock.length) {
    seek(clock.length)
    setPlaying(false)
    return
  }
  seek(playMs)
  requestAnimationFrame(frame)
}

function setPlaying(on: boolean) {
  playing = on
  $('play').textContent = on ? 'Pause' : 'Play'
  if (on) {
    if (playMs >= clock.length) seek(0)
    lastFrame = performance.now()
    requestAnimationFrame(frame)
  }
}

function jump(dir: 1 | -1) {
  if (!tl) return
  const real = clock.toReal(playMs)
  const times = tl.steps.map(st => st[0])
  const target = dir > 0 ? times.find(t => t > real + 0.5) : [...times].reverse().find(t => t < real - 0.5)
  seek(clock.toPlay(target ?? (dir > 0 ? durationOf(tl) : 0)))
}

function setClock() {
  if (!tl) return
  const real = clock.toReal(playMs)
  const squashOn = $<HTMLInputElement>('squash').checked
  clock = squash(tl, squashOn ? 1_500 : Infinity)
  drawStrip()
  seek(clock.toPlay(real))
}

function drawStats(d: Draft) {
  const l = d.line
  const stat = (label: string, value: string, sub = '') =>
    `<div><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
  const groups = d.timeline ? countGroups(d.timeline) : undefined
  $('draft-stats').innerHTML = [
    stat('Writing', seconds(d.end - d.start), `${seconds(num(l.typingMs))} of it typing`),
    stat('Edits', String(num(l.edits)), groups ? `${groups.move} cursor moves` : ''),
    stat('Typed', String(num(l.typedChars)), `${num(l.pastedChars)} pasted`),
    stat('Deleted', String(num(l.deletedChars)), `${num(l.wordDeletes)} word, ${num(l.lineKills)} line`),
    stat('Fixes / rewrites', `${num(l.fixes)} / ${num(l.rewrites)}`, `${num(l.rewrittenChars)} chars redone`),
    stat('Pauses', String(num(l.pauses)), `${num(l.breaks)} breaks, longest ${seconds(num(l.longestPauseMs))}`),
  ].join('')
}

function select(d: Draft) {
  selected = d
  setPlaying(false)
  drawLanes()
  drawTable()
  const card = $('replay-card')
  card.hidden = false
  $('replay-title').textContent = `${d.outcome === 'sent' ? 'Prompt' : 'Abandoned draft'} from ${clockTime(d.start)}`
  drawStats(d)
  tl = d.timeline
  cached = undefined
  const hasReplay = !!tl
  for (const id of ['box', 'step', 'strip', 'kinds-legend']) $(id).hidden = !hasReplay
  ;(card.querySelector('.player') as HTMLElement).hidden = !hasReplay
  $('replay-note').textContent = !tl
    ? 'logged before replays existed, so stats only'
    : tl.truncated
      ? 'very long draft: the replay stops where the recording did'
      : `${tl.steps.length} edits`
  if (tl) {
    playMs = 0
    clock = squash(tl, $<HTMLInputElement>('squash').checked ? 1_500 : Infinity)
    drawStrip()
    seek(0)
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// --- page ---------------------------------------------------------------

function legend(el: HTMLElement, keys: [cls: string, label: string][]) {
  el.innerHTML = keys.map(([cls, label]) => `<span class="key"><span class="swatch ${cls}"></span>${label}</span>`).join('')
}

async function init() {
  if (!sessionId) {
    $('empty').hidden = false
    return
  }
  const [all, timelines] = await Promise.all([
    fetch('/api/events').then(r => r.json() as Promise<Event[]>),
    fetch(`/api/session/${encodeURIComponent(sessionId)}`).then(r => r.json() as Promise<Timeline[]>),
  ])
  events = all.filter(e => e.sessionId === sessionId).sort((a, b) => time(a) - time(b))
  if (!events.length) {
    $('empty').hidden = false
    return
  }
  drafts = buildDrafts(timelines)

  const project = events.find(e => e.project)?.project ?? 'session'
  const first = time(events[0]!)
  const lastAt = time(events[events.length - 1]!)
  $('title').textContent = String(project)
  document.title = `${project} session`
  const sent = drafts.filter(d => d.outcome === 'sent').length
  $('subtitle').textContent = `${new Date(first).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, ${duration(lastAt - first)} long · ${sent} sent, ${drafts.length - sent} abandoned · ${sessionId.slice(0, 8)}`

  legend($('lanes-legend'), [
    ['k-typed', 'writing a prompt'],
    ['k-typed hollow', 'abandoned draft'],
    ['k-pause', 'paused while writing'],
    ['k-claude', 'Claude working'],
    ['k-compact', 'compacting'],
    ['k-before', 'tool call'],
    ['k-critical', 'interrupt'],
    ['k-midturn', 'sent mid-turn'],
  ])
  legend($('kinds-legend'), [
    ['k-typed', 'typed (above the line)'],
    ['k-deleted', 'deleted (below)'],
    ['k-pasted', 'pasted or typed over'],
    ['k-move', 'cursor move'],
    ['k-before', 'already in the box'],
  ])

  $('content').hidden = false
  drawLanes()
  drawTable()
  const withReplay = [...drafts].reverse().find(d => d.timeline)
  if (withReplay) select(withReplay)
}

$('play').addEventListener('click', () => setPlaying(!playing))
$('prev').addEventListener('click', () => jump(-1))
$('next').addEventListener('click', () => jump(1))
$<HTMLInputElement>('scrub').addEventListener('input', e => {
  setPlaying(false)
  seek((Number((e.target as HTMLInputElement).value) / 1000) * clock.length)
})
$('squash').addEventListener('change', setClock)
for (const [id, by] of [['zoom-in', 2], ['zoom-out', 0.5]] as const) {
  $(id).addEventListener('click', () => {
    zoom = Math.max(1, Math.min(64, zoom * by))
    save('zoom', String(zoom))
    drawLanes()
  })
}
addEventListener('keydown', e => {
  if (!tl || (e.target as HTMLElement).matches('input, select, textarea')) return
  if (e.key === ' ') {
    e.preventDefault()
    setPlaying(!playing)
  } else if (e.key === 'ArrowLeft') jump(-1)
  else if (e.key === 'ArrowRight') jump(1)
})

let lastWidth = 0
new ResizeObserver(([entry]) => {
  const width = Math.round(entry!.contentRect.width)
  if (width === lastWidth || !events.length) return
  lastWidth = width
  drawLanes()
  if (tl) {
    drawStrip()
    seek(playMs)
  }
}).observe(document.querySelector('main')!)

init()
