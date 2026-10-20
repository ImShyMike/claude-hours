import { expect, test } from 'bun:test'
import { countGroups, describe, parseTimelines, pausesOf, squash, stateAt, type Timeline } from './replay'

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
  const good = JSON.stringify(timeline([]))
  expect(parseTimelines(`${good}\n{"torn\n{"draftId":1}\n`)).toHaveLength(1)
})
