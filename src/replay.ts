// Rebuilds a prompt draft from hook-analytics' edit timeline. Shapes only:
// 'a' is any character, ' ' a blank, '\n' a newline. Pure, shared by the
// session page and the tests.

// [ms since the draft began, kind, position, removed, inserted shape, who]
export type Step = [number, string, number, number?, string?, string?]

export type Timeline = {
  draftId: string
  outcome: 'sent' | 'abandoned'
  startedAt: string
  endedAt: string
  initialShape: string
  initialCursor: number
  steps: Step[]
  truncated: boolean
}

// how a character got into the box, which is what colors it
export type Source = 'before' | 'typed' | 'pasted' | 'changed'
export type Cell = { ch: string; src: Source; at: number }
export type Group = 'typed' | 'deleted' | 'pasted' | 'move' | 'changed'

export const KIND_NAMES: Record<string, string> = {
  t: 'typed',
  p: 'pasted',
  r: 'typed over a selection',
  b: 'backspace',
  d: 'forward delete',
  w: 'word delete',
  k: 'line kill',
  m: 'cursor move',
  c: 'box replaced',
}

export function groupOf(kind: string): Group {
  if (kind === 't') return 'typed'
  if (kind === 'p' || kind === 'r') return 'pasted'
  if (kind === 'm') return 'move'
  if (kind === 'c') return 'changed'
  return 'deleted'
}

const cellsOf = (shape: string, src: Source, at: number): Cell[] => [...shape].map(ch => ({ ch, src, at }))

export type State = { cells: Cell[]; cursor: number; applied: number }

export const initialState = (tl: Timeline): State => ({
  cells: cellsOf(tl.initialShape, 'before', -1),
  cursor: tl.initialCursor,
  applied: 0,
})

// Applies one step in place. Positions are clamped, so a timeline that drifted
// (a hot reload mid-draft, a truncated one) degrades instead of throwing
export function apply(state: State, step: Step) {
  const [at, kind, rawPos, removed = 0, shape = ''] = step
  const pos = Math.max(0, Math.min(rawPos, state.cells.length))
  switch (groupOf(kind)) {
    case 'move':
      state.cursor = pos
      break
    case 'changed':
      state.cells = cellsOf(shape, 'changed', at)
      state.cursor = Math.min(pos, state.cells.length)
      break
    default: {
      const src: Source = kind === 't' ? 'typed' : 'pasted'
      state.cells.splice(pos, removed, ...cellsOf(shape, src, at))
      state.cursor = pos + shape.length
    }
  }
  state.applied++
}

// The box as it stood at `ms` into the draft
export function stateAt(tl: Timeline, ms: number): State {
  const state = initialState(tl)
  for (const step of tl.steps) {
    if (step[0] > ms) break
    apply(state, step)
  }
  return state
}

export const durationOf = (tl: Timeline) => Date.parse(tl.endedAt) - Date.parse(tl.startedAt)

// Squashes every pause longer than `capMs` down to `capMs`, so a replay
// doesn't sit through a tea break. Maps real draft time to replay time and back
export function squash(tl: Timeline, capMs: number) {
  const marks = [0, ...tl.steps.map(st => st[0]), durationOf(tl)]
  const real: number[] = [0]
  const play: number[] = [0]
  for (let i = 1; i < marks.length; i++) {
    const gap = Math.max(0, marks[i]! - marks[i - 1]!)
    real.push(marks[i]!)
    play.push(play[i - 1]! + Math.min(gap, capMs))
  }
  const map = (from: number[], to: number[], x: number) => {
    let i = 1
    while (i < from.length - 1 && from[i]! < x) i++
    const span = from[i]! - from[i - 1]!
    const f = span > 0 ? (x - from[i - 1]!) / span : 1
    return to[i - 1]! + Math.min(1, Math.max(0, f)) * (to[i]! - to[i - 1]!)
  }
  return {
    length: play[play.length - 1]!,
    toPlay: (ms: number) => map(real, play, ms),
    toReal: (ms: number) => map(play, real, ms),
  }
}

// gaps between steps at least `minMs` long, for the strip
export function pausesOf(tl: Timeline, minMs: number) {
  const marks = [0, ...tl.steps.map(st => st[0]), durationOf(tl)]
  const pauses: { from: number; to: number }[] = []
  for (let i = 1; i < marks.length; i++) {
    if (marks[i]! - marks[i - 1]! >= minMs) pauses.push({ from: marks[i - 1]!, to: marks[i]! })
  }
  return pauses
}

export function countGroups(tl: Timeline) {
  const counts: Record<Group, number> = { typed: 0, deleted: 0, pasted: 0, move: 0, changed: 0 }
  for (const st of tl.steps) counts[groupOf(st[1])]++
  return counts
}

export function describe(step: Step) {
  const [, kind, pos, removed = 0, shape = ''] = step
  const name = KIND_NAMES[kind] ?? kind
  if (kind === 'm') return `${name} to ${pos}`
  if (kind === 'c') return `${name} (${step[5] ?? 'engine'}), now ${shape.length} chars`
  const parts = [name]
  if (shape) parts.push(`+${shape.length}`)
  if (removed) parts.push(`−${removed}`)
  return `${parts.join(' ')} at ${pos}`
}

// --- the stored format -------------------------------------------------
// v 1 (hook-analytics' encodeSteps; keep the two in step): shapes are
// run-length encoded, a for a letter, _ a blank, n a newline ("5a_3a"), and
// steps are one string of comma separated "<dt><kind>[@pos][-removed]
// [+shape][:who]". dt is ms since the previous step; a missing position is
// the cursor (just before it for b), a missing removed is 1 for b and d and 0
// otherwise; a lone a, _ or n is that one character typed at the cursor.

const SYMBOLS: Record<string, string> = { a: 'a', _: ' ', n: '\n' }
const SYMBOL_OF: Record<string, string> = { a: 'a', ' ': '_', '\n': 'n' }

export function unrle(code: string) {
  let out = ''
  for (const [, count, sym] of code.matchAll(/(\d*)([a_n])/g)) out += SYMBOLS[sym!]!.repeat(count ? Number(count) : 1)
  return out
}

export function rle(shape: string) {
  let out = ''
  for (let i = 0; i < shape.length; ) {
    const ch = shape[i]!
    let n = 1
    while (shape[i + n] === ch) n++
    out += `${n > 1 ? n : ''}${SYMBOL_OF[ch] ?? 'a'}`
    i += n
  }
  return out
}

const TOKEN = /^(\d+)([a-z_])(?:@(\d+))?(?:-(\d+))?(?:\+([0-9a_n]+))?(?::([a-z]+))?$/

export function decodeSteps(code: string, initialCursor: number): Step[] {
  const steps: Step[] = []
  let at = 0
  let cursor = initialCursor
  for (const token of code.split(',')) {
    const m = TOKEN.exec(token)
    if (!m) continue
    at += Number(m[1])
    const op = m[2]!
    let step: Step
    if (op in SYMBOLS) step = [at, 't', cursor, 0, SYMBOLS[op]!]
    else {
      const removed = m[4] !== undefined ? Number(m[4]) : op === 'b' || op === 'd' ? 1 : 0
      const pos = m[3] !== undefined ? Number(m[3]) : op === 'b' ? cursor - (removed || 1) : cursor
      step = [at, op, pos, removed]
      if (m[5]) step[4] = unrle(m[5])
      if (m[6]) step[5] = m[6]
    }
    const [, kind, pos, , shape = ''] = step
    cursor = kind === 'm' || kind === 'c' ? pos : kind === 't' || kind === 'p' || kind === 'r' ? pos + shape.length : pos
    steps.push(step)
  }
  return steps
}

export function encodeSteps(steps: Step[], initialCursor: number) {
  let cursor = initialCursor
  let prev = 0
  return steps
    .map(([at, kind, pos, removed = 0, shape = '', who]) => {
      const dt = Math.max(0, Math.round(at - prev))
      prev = at
      let token: string
      if (kind === 't' && !removed && shape.length === 1 && pos === cursor) token = `${dt}${rle(shape)}`
      else {
        const usualRemoved = kind === 'b' || kind === 'd' ? 1 : 0
        const usualPos = kind === 'b' ? cursor - (removed || 1) : cursor
        token = `${dt}${kind}`
        if (pos !== usualPos) token += `@${pos}`
        if (removed !== usualRemoved) token += `-${removed}`
        if (shape) token += `+${rle(shape)}`
        if (who) token += `:${who.replace(/[^a-z]/g, '')}`
      }
      cursor = kind === 'm' || kind === 'c' ? pos : kind === 't' || kind === 'p' || kind === 'r' ? pos + shape.length : pos
      return token
    })
    .join(',')
}

// a stored row as the replay wants it, or undefined if it isn't v1
function decodeRow(row: Record<string, unknown>): Timeline | undefined {
  if (row.v !== 1 || typeof row.draftId !== 'string' || typeof row.steps !== 'string') return undefined
  const cursor = Number(row.initialCursor) || 0
  return { ...(row as unknown as Timeline), initialShape: unrle(String(row.initialShape ?? '')), steps: decodeSteps(row.steps, cursor) }
}

export function parseTimelines(text: string): Timeline[] {
  const rows: Timeline[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = decodeRow(JSON.parse(line))
      if (row) rows.push(row)
    } catch {}
  }
  return rows
}
