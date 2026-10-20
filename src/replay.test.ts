import { expect, test } from 'bun:test'
import { countGroups, decodeSteps, describe, encodeSteps, parseTimelines, pausesOf, rle, squash, stateAt, unrle, type Timeline } from './replay'

const timeline = (steps: Timeline['steps'], extra: Partial<Timeline> = {}): Timeline => ({
  draftId: 'd1',
  outcome: 'sent',
  startedAt: '2026-10-20T04:00:00.000Z',
  endedAt: '2026-10-20T04:00:10.000Z',
  initialShape: '',
  initialCursor: 0,
  steps,
  truncated: false,
  ...extra,
})

const shape = (tl: Timeline, ms: number) => stateAt(tl, ms).cells.map(c => c.ch).join('')

test('replays typing, deletes, a move and a recall', () => {
  const tl = timeline(
    [
      [0, 't', 5, 0, ' aaa'],
      [1000, 'w', 6, 3],
      [2000, 'm', 2],
      [3000, 'r', 2, 1, 'aa'],
      [4000, 'c', 5, 0, 'aaa\na', 'history'],
      [5000, 't', 5, 0, 'a'],
    ],
    { initialShape: 'aa aa', initialCursor: 5 },
  )
  expect(shape(tl, -1)).toBe('aa aa')
  expect(shape(tl, 0)).toBe('aa aa aaa')
  expect(shape(tl, 1500)).toBe('aa aa ')
  expect(stateAt(tl, 2500).cursor).toBe(2)
  expect(shape(tl, 3000)).toBe('aaaaaa ')
  expect(stateAt(tl, 3000).cursor).toBe(4)
  expect(shape(tl, 4000)).toBe('aaa\na')
  expect(shape(tl, 9999)).toBe('aaa\naa')
})

test('cells remember where they came from', () => {
  const tl = timeline([[0, 't', 2, 0, 'a'], [500, 'p', 3, 0, 'aaaa']], { initialShape: 'aa', initialCursor: 2 })
  expect(stateAt(tl, 1000).cells.map(c => c.src)).toEqual(['before', 'before', 'typed', 'pasted', 'pasted', 'pasted', 'pasted'])
})

test('positions past the end are clamped instead of throwing', () => {
  const tl = timeline([[0, 'b', 40, 1], [1, 't', 99, 0, 'a']])
  expect(shape(tl, 10)).toBe('a')
})

test('squash shortens long pauses and maps both ways', () => {
  // steps at 0 and 1s, then a 30s pause, then the end at 31s
  const tl = timeline([[0, 't', 0, 0, 'a'], [1000, 't', 1, 0, 'a']], { endedAt: '2026-10-20T04:00:31.000Z' })
  const clock = squash(tl, 2000)
  expect(clock.length).toBe(3000)
  expect(clock.toPlay(1000)).toBe(1000)
  expect(clock.toPlay(31_000)).toBe(3000)
  expect(clock.toReal(3000)).toBe(31_000)
  expect(clock.toReal(500)).toBe(500)
})

test('pauses, group counts and descriptions', () => {
  const tl = timeline([[0, 't', 0, 0, 'aa'], [5000, 'w', 0, 2], [5100, 'm', 0], [6000, 'p', 0, 0, 'aaaa']])
  expect(pausesOf(tl, 2000)).toEqual([{ from: 0, to: 5000 }, { from: 6000, to: 10_000 }])
  expect(countGroups(tl)).toEqual({ typed: 1, deleted: 1, pasted: 1, move: 1, changed: 0 })
  expect(describe([5000, 'w', 3, 6])).toBe('word delete −6 at 3')
  expect(describe([0, 'r', 1, 2, 'aaa'])).toBe('typed over a selection +3 −2 at 1')
})

test('parseTimelines skips junk', () => {
  const good = JSON.stringify({ v: 1, draftId: 'd', outcome: 'sent', startedAt: 1_790_000_000_000, durationMs: 0, steps: '' })
  expect(parseTimelines(`${good}\n{"torn\n{"v":1,"draftId":1}\n`)).toHaveLength(1)
})

test('rle round trips shapes', () => {
  expect(rle('aaaaa aaa\n\na')).toBe('5a_3a2na')
  expect(unrle('5a_3a2na')).toBe('aaaaa aaa\n\na')
  expect(rle('')).toBe('')
  expect(unrle('12a')).toBe('a'.repeat(12))
})

// These strings are the ones hook-analytics' own tests expect it to write,
// so the two sides can't drift apart unnoticed
test('decodes what the mod writes', () => {
  // gaps are in 10ms ticks
  expect(decodeSteps('0t+2a_3a,50n,50b', 0)).toEqual([
    [0, 't', 0, 0, 'aa aaa'],
    [500, 't', 6, 0, '\n'],
    [1000, 'b', 6, 1],
  ])
  expect(decodeSteps('0w@19-4,0k@14-5,0m@4,0d,0w-3,0k@0-4,0a,0r@0-1+2a', 23).map(st => st.slice(1))).toEqual([
    ['w', 19, 4],
    ['k', 14, 5],
    ['m', 4, 0],
    ['d', 4, 1],
    ['w', 4, 3],
    ['k', 0, 4],
    ['t', 0, 0, 'a'],
    ['r', 0, 1, 'aa'],
  ])
  expect(decodeSteps('0t+3a,500m@1,4000m@3,100a', 0).map(st => [st[0], st[1], st[2]])).toEqual([
    [0, 't', 0],
    [5000, 'm', 1],
    [45_000, 'm', 3],
    [46_000, 't', 3],
  ])
  expect(decodeSteps('0b,0c@5+3ana:history,0a', 5).map(st => st.slice(1))).toEqual([
    ['b', 4, 1],
    ['c', 5, 0, 'aaa\na', 'history'],
    ['t', 5, 0, 'a'],
  ])
})

test('encode and decode round trip, skipping junk tokens', () => {
  const steps: Timeline['steps'] = [
    [0, 't', 3, 0, 'a'],
    // 124ms lands on the nearest tick
    [124, 't', 4, 0, ' '],
    [300, 'p', 5, 0, 'aaaa aa'],
    [900, 'b', 11, 1],
    [1000, 'w', 4, 7],
    [1500, 'm', 0],
    [1600, 'r', 0, 2, 'a'],
    [2000, 'c', 2, 0, 'aa\n', 'undo'],
  ]
  const code = encodeSteps(steps, 3)
  expect(code).toBe('0a,12_,18p+4a_2a,60b,10w@4-7,50m@0,10r-2+a,40c@2+2an:undo')
  // a decoded move carries removed 0, which the original left out
  expect(decodeSteps(code, 3)).toEqual(
    steps.map(st => (st[1] === 'm' ? [st[0], 'm', st[2], 0] : st[0] === 124 ? [120, ...st.slice(1)] : st)),
  )
  expect(decodeSteps(`0a,garbage,,${'5'}a`, 0)).toHaveLength(2)
})

test('parseTimelines decodes v1 rows and skips anything else', () => {
  const row = { v: 1, draftId: 'b', outcome: 'sent', startedAt: 1_790_000_000_000, durationMs: 1500, initialShape: '2a_a', initialCursor: 4, steps: '0a' }
  const old = { ...row, draftId: 'a', v: undefined, initialShape: 'aa a', steps: [[0, 't', 4, 0, 'a']] }
  const iso = { ...row, draftId: 'c', startedAt: '2026-10-20T04:00:00.000Z' }
  const rows = parseTimelines(`${JSON.stringify(old)}\n${JSON.stringify(row)}\n${JSON.stringify(iso)}\n`)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual({
    draftId: 'b',
    outcome: 'sent',
    startedAt: new Date(1_790_000_000_000).toISOString(),
    endedAt: new Date(1_790_000_001_500).toISOString(),
    initialShape: 'aa a',
    initialCursor: 4,
    steps: [[0, 't', 4, 0, 'a']],
    truncated: false,
  })
})
