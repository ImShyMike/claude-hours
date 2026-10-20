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
    at(0, 'session_start', { surface: 'terminal' }),
    at(3, 'tool', { tool: 'Write', file: '/code/terra/a.ts', outcome: 'ok', durationMs: 40 }),
    at(9, 'file_changed', { cwd: '/code/vxm', path: '/code/vxm/x.py', via: 'tool' }),
  ]
  const text = encodeSession(events)
  expect(text).not.toContain('2026-10-19')
  expect(text).not.toContain('s1')
  expect(text).toContain('"file":"a.ts"')
  const back = decodeSession(text, 's1')
  expect(back.filter(e => e.event !== 'cwd_changed')).toEqual(events)
})
