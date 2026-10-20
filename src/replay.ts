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

export function parseTimelines(text: string): Timeline[] {
  const rows: Timeline[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row.draftId === 'string' && Array.isArray(row.steps)) rows.push(row)
    } catch {}
  }
  return rows
}
