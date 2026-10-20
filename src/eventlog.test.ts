import { expect, test } from 'bun:test'
import type { Event } from './aggregate'
import { decodeSession, encodeSession } from './eventlog'

const start = Date.parse('2026-10-19T12:00:00Z')
const file = (...rows: unknown[]) => rows.map(row => `${JSON.stringify(row)}\n`).join('')

test('decodes times, cwd moves and relative paths', () => {
  const text = file(
    { v: 1, event: 'session', start, cwd: '/code/terra' },
    { t: 0, event: 'prompt', words: 3 },
    { t: 1500, event: 'tool', tool: 'Edit', file: 'src/a.ts' },
    { t: 2000, event: 'cwd_changed', cwd: '/code/vxm' },
    { t: 2000, event: 'file_changed', path: 'b.py' },
    { at: start + 5000, event: 'turn_end', path: '/etc/hosts' },
  )
  const events = decodeSession(text, 's1')
  expect(events.map(e => [e.event, e.ts, e.cwd, e.file ?? e.path])).toEqual([
    ['prompt', '2026-10-19T12:00:00.000Z', '/code/terra', undefined],
    ['tool', '2026-10-19T12:00:01.500Z', '/code/terra', '/code/terra/src/a.ts'],
    ['cwd_changed', '2026-10-19T12:00:02.000Z', '/code/vxm', undefined],
    ['file_changed', '2026-10-19T12:00:02.000Z', '/code/vxm', '/code/vxm/b.py'],
    ['turn_end', '2026-10-19T12:00:05.000Z', '/code/vxm', '/etc/hosts'],
  ])
  expect(events.every(e => e.sessionId === 's1' && !('t' in e) && !('at' in e))).toBe(true)
})

test('skips torn lines, and a file in another format whole', () => {
  const ok = file({ v: 1, event: 'session', start, cwd: '/p' }, { t: 1, event: 'prompt' })
  expect(decodeSession(`${ok}{"t":2,"ev\nnot json\n42\n`, 's')).toHaveLength(1)
  expect(decodeSession(file({ v: 9, event: 'session', start, cwd: '/p' }, { t: 1, event: 'prompt' }), 's')).toEqual([])
  // rows with no time to place them on are dropped
  expect(decodeSession(file({ event: 'prompt' }), 's')).toEqual([])
})

test('encodeSession round trips through decodeSession', () => {
  const at = (sec: number, event: string, extra: Partial<Event> = {}): Event => ({
    ts: new Date(start + sec * 1000).toISOString(),
    sessionId: 's1',
    cwd: '/code/terra',
    event,
    ...extra,
  })
  const events = [
    at(0, 'session_start', { surface: 'terminal', isInteractive: true }),
    at(3, 'tool', { tool: 'Write', file: '/code/terra/a.ts', outcome: 'ok', durationMs: 40 }),
    at(9, 'file_changed', { cwd: '/code/vxm', path: '/code/vxm/x.py', via: 'tool' }),
  ]
  const text = encodeSession(events)
  expect(text).not.toContain('2026-10-19')
  // usual values stay out of the file and come back on the way in
  expect(text).not.toContain('"outcome":"ok"')
  expect(text).not.toContain('"via"')
  expect(text).not.toContain('s1')
  expect(text).toContain('"file":"a.ts"')
  const back = decodeSession(text, 's1')
  expect(back.filter(e => e.event !== 'cwd_changed')).toEqual(events)
})

test('restores left-out defaults, draft zeros and an abandoned draft\'s times', () => {
  const text = file(
    { v: 1, event: 'session', start, cwd: '/p' },
    { t: 0, event: 'tool', tool: 'Read', durationMs: 3 },
    { t: 1, event: 'prompt', typingMs: 900, typedChars: 12 },
    { t: 2, event: 'prompt', origin: 'paste' },
    { t: 9000, event: 'draft_abandoned', typingMs: 400, composeMs: 2000, endedAt: start + 5000, how: 'clear' },
  )
  const [tool, typed, plain, gone] = decodeSession(text, 's')
  expect(tool).toMatchObject({ outcome: 'ok' })
  expect(typed).toMatchObject({ origin: 'composer', isMeta: false, pastedChars: 0, pauses: 0, longestPauseMs: 0 })
  // counters only come back on rows that had a typed draft
  expect(plain).toMatchObject({ origin: 'paste', isMeta: false })
  expect(plain).not.toHaveProperty('pauses')
  expect(gone).toMatchObject({ endedAt: '2026-10-19T12:00:05.000Z', startedAt: '2026-10-19T12:00:03.000Z' })
})

test('a root rides along with its cwd until the next cwd_changed, and back', () => {
  const text = file(
    { v: 1, event: 'session', start, cwd: '/code/terra/packages/api', root: '/code/terra' },
    { t: 0, event: 'prompt' },
    { t: 1, event: 'cwd_changed', cwd: '/code/vxm' },
    { t: 2, event: 'prompt' },
  )
  const events = decodeSession(text, 's1')
  expect(events.map(e => e.root)).toEqual(['/code/terra', undefined, undefined])
  expect(encodeSession(events)).toBe(text)
})
