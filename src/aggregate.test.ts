import { expect, test } from 'bun:test'
import { activeIntervals, dayKey, languageOf, parseLines, summarize, type Event } from './aggregate'

const MIN = 60_000
const at = (iso: string, event: string, extra: Partial<Event> = {}): Event => ({
  ts: iso,
  sessionId: 's1',
  cwd: '/code/terra',
  project: 'terra',
  event,
  ...extra,
})

test('runs in New York time', () => {
  // the package's test script sets TZ; day buckets depend on it
  expect(dayKey(Date.parse('2026-10-20T02:34:00Z'))).toBe('2026-10-19')
})

test('skips torn and junk lines', () => {
  const text = [
    JSON.stringify(at('2026-10-19T12:00:00Z', 'prompt')),
    '{"ts":"2026-10-19T12:0',
    'not json',
    '42',
    '',
    JSON.stringify(at('2026-10-19T12:01:00Z', 'turn_end')),
  ].join('\n')
  expect(parseLines(text).map(e => e.event)).toEqual(['prompt', 'turn_end'])
})

test('a long turn counts in full, idle gaps past the cap do not', () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt'),
    // a 40 minute turn with no events in the middle
    at('2026-10-19T12:40:00Z', 'turn_end', { durationMs: 40 * MIN }),
    // an hour of idle, then a quick one
    at('2026-10-19T13:40:00Z', 'prompt'),
    at('2026-10-19T13:41:00Z', 'turn_end', { durationMs: 1 * MIN }),
  ]
  expect(activeIntervals(events, 5 * MIN)).toEqual([
    [Date.parse('2026-10-19T12:00:00Z'), Date.parse('2026-10-19T12:40:00Z')],
    [Date.parse('2026-10-19T13:40:00Z'), Date.parse('2026-10-19T13:41:00Z')],
  ])
  expect(summarize(events, { idleCapMs: 5 * MIN }).totalMs).toBe(41 * MIN)
})

test('short idle gaps are bridged', () => {
  const events = [at('2026-10-19T12:00:00Z', 'tool_end'), at('2026-10-19T12:04:00Z', 'tool_end')]
  expect(summarize(events, { idleCapMs: 5 * MIN }).totalMs).toBe(4 * MIN)
  expect(summarize(events, { idleCapMs: 3 * MIN }).totalMs).toBe(0)
})

test('subagent turns do not stretch active time', () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt'),
    at('2026-10-19T12:01:00Z', 'turn_end', { durationMs: 1 * MIN }),
    at('2026-10-19T12:30:00Z', 'turn_end', { durationMs: 60 * MIN, agentId: 'a1' }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.totalMs).toBe(1 * MIN)
  expect(s.turns).toBe(1)
})

test('time splits at local midnight', () => {
  // 23:30 to 00:30 in New York
  const events = [at('2026-10-20T04:30:00Z', 'turn_end', { durationMs: 60 * MIN })]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.days).toEqual([
    { day: '2026-10-19', ms: 30 * MIN, prompts: 0 },
    { day: '2026-10-20', ms: 30 * MIN, prompts: 0 },
  ])
})

test('time splits by local hour too', () => {
  // 23:30 to 00:30 in New York
  const events = [at('2026-10-20T04:30:00Z', 'turn_end', { durationMs: 60 * MIN })]
  const { hours } = summarize(events, { idleCapMs: 5 * MIN })
  expect(hours[23]).toBe(30 * MIN)
  expect(hours[0]).toBe(30 * MIN)
  expect(hours.reduce((a, b) => a + b)).toBe(60 * MIN)
})

test('the window clips time and counts', () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt', { words: 10, chars: 50, origin: 'composer' }),
    at('2026-10-19T12:10:00Z', 'turn_end', { durationMs: 10 * MIN }),
    at('2026-10-19T13:00:00Z', 'prompt', { words: 99 }),
  ]
  const s = summarize(events, {
    idleCapMs: 5 * MIN,
    from: Date.parse('2026-10-19T12:05:00Z'),
    to: Date.parse('2026-10-19T12:30:00Z'),
  })
  expect(s.totalMs).toBe(5 * MIN)
  expect(s.prompts.count).toBe(0)
})

test('projects are timed separately, even in one session', () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'tool_end'),
    at('2026-10-19T12:02:00Z', 'tool_end'),
    at('2026-10-19T12:03:00Z', 'tool_end', { cwd: '/code/vxm', project: 'vxm' }),
    at('2026-10-19T12:06:00Z', 'tool_end', { cwd: '/code/vxm', project: 'vxm' }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.projects).toEqual([
    { project: 'vxm', ms: 3 * MIN },
    { project: 'terra', ms: 2 * MIN },
  ])
})

test('file order across sessions does not matter', () => {
  const a = at('2026-10-19T12:00:00Z', 'tool_end')
  const b = at('2026-10-19T12:01:00Z', 'tool_end', { sessionId: 's2' })
  const c = at('2026-10-19T12:02:00Z', 'tool_end')
  expect(summarize([c, b, a], { idleCapMs: 5 * MIN }).totalMs).toBe(2 * MIN)
})

test('counts prompts, interrupts, tokens, tools and languages', () => {
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, model: 'x' }
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt', { words: 4, chars: 20, origin: 'composer' }),
    at('2026-10-19T12:00:30Z', 'prompt', { words: 2, chars: 10, origin: 'bridge' }),
    // not written by a person, so not counted as prompts
    at('2026-10-19T12:00:40Z', 'prompt', { words: 50, chars: 300, origin: 'task-notification' }),
    at('2026-10-19T12:00:45Z', 'prompt', { words: 50, chars: 300, origin: 'composer', isMeta: true }),
    at('2026-10-19T12:01:00Z', 'tool_end', { tool: 'Bash', outcome: 'ok', durationMs: 100 }),
    at('2026-10-19T12:01:10Z', 'tool_end', { tool: 'Bash', outcome: 'error', durationMs: 300 }),
    at('2026-10-19T12:01:20Z', 'tool_end', { tool: 'Edit', outcome: 'denied', durationMs: 5 }),
    at('2026-10-19T12:01:30Z', 'file_changed', { path: '/code/terra/a.ts', via: 'tool' }),
    at('2026-10-19T12:01:31Z', 'file_changed', { path: '/code/terra/Makefile', via: 'bash-window' }),
    at('2026-10-19T12:02:00Z', 'interrupt', { durationMs: 1000, usage }),
    // the same Esc aborting a subagent doesn't count twice
    at('2026-10-19T12:02:00Z', 'interrupt', { durationMs: 500, agentId: 'sub' }),
    at('2026-10-19T12:03:00Z', 'turn_end', { durationMs: 1000, usage, agentId: 'sub' }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.prompts).toEqual({ count: 2, avgWords: 3, avgChars: 15, typed: 1 })
  expect(s.interrupts).toBe(1)
  expect(s.turns).toBe(0)
  // subagent tokens are real spend, so they count
  expect(s.tokens).toEqual({ input: 20, output: 40, cacheRead: 60, cacheWrite: 80 })
  expect(s.tools).toEqual([
    { tool: 'Bash', calls: 2, errors: 1, denied: 0, avgMs: 200 },
    { tool: 'Edit', calls: 1, errors: 0, denied: 1, avgMs: 5 },
  ])
  expect(s.languages).toEqual([
    { language: 'TypeScript', edits: 1 },
    { language: 'Make', edits: 1 },
  ])
  expect(s.days).toEqual([{ day: '2026-10-19', ms: 3 * MIN, prompts: 2 }])
})

test('an empty log summarizes to zeros', () => {
  const s = summarize([], { idleCapMs: 5 * MIN })
  expect(s.totalMs).toBe(0)
  expect(s.days).toEqual([])
  expect(s.sessions).toEqual([])
})

test('languageOf', () => {
  expect(languageOf('/a/b/x.TSX')).toBe('TypeScript')
  expect(languageOf('/a/.env')).toBe('Other')
  expect(languageOf('/a/Dockerfile')).toBe('Docker')
  expect(languageOf('/a/noext')).toBe('Other')
})
