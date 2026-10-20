import { expect, test } from 'bun:test'
import { activeIntervals, dayKey, languageOf, summarize, type Event } from './aggregate'

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

test('a turn that asked the person something works around the wait, judged like any gap', () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt'),
    // 2 min of work, a 10 min wait on an answer, 3 more min of work; the
    // engine's durationMs leaves the wait out
    at('2026-10-19T12:12:00Z', 'tool', { tool: 'AskUserQuestion', durationMs: 10 * MIN }),
    at('2026-10-19T12:15:00Z', 'turn_end', { durationMs: 5 * MIN }),
  ]
  expect(activeIntervals(events, 5 * MIN)).toEqual([
    [Date.parse('2026-10-19T12:00:00Z'), Date.parse('2026-10-19T12:02:00Z')],
    [Date.parse('2026-10-19T12:12:00Z'), Date.parse('2026-10-19T12:15:00Z')],
  ])
  expect(summarize(events, { idleCapMs: 5 * MIN }).totalMs).toBe(5 * MIN)
  // a wait under the cap still counts, like the gap before a next prompt
  expect(summarize(events, { idleCapMs: 15 * MIN }).totalMs).toBe(15 * MIN)
})

test("a permission dialog on the turn row is stepped over the same way", () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt'),
    // 2 min of work, a dialog up 10 min, 3 more min; waits says when it opened
    at('2026-10-19T12:15:00Z', 'turn_end', { durationMs: 5 * MIN, waits: [[13 * MIN, 10 * MIN, 'Bash']] }),
  ]
  expect(activeIntervals(events, 5 * MIN)).toEqual([
    [Date.parse('2026-10-19T12:00:00Z'), Date.parse('2026-10-19T12:02:00Z')],
    [Date.parse('2026-10-19T12:12:00Z'), Date.parse('2026-10-19T12:15:00Z')],
  ])
})

test('a wait before the turn began is not stepped over', () => {
  const events = [
    at('2026-10-19T12:10:00Z', 'tool', { tool: 'AskUserQuestion', durationMs: 5 * MIN }),
    at('2026-10-19T12:20:00Z', 'turn_end', { durationMs: 3 * MIN }),
  ]
  expect(activeIntervals(events, 1 * MIN)).toEqual([
    [Date.parse('2026-10-19T12:10:00Z'), Date.parse('2026-10-19T12:10:00Z')],
    [Date.parse('2026-10-19T12:17:00Z'), Date.parse('2026-10-19T12:20:00Z')],
  ])
})

test('a subagent asking does not move the main turn', () => {
  const events = [
    at('2026-10-19T12:12:00Z', 'tool', { tool: 'AskUserQuestion', durationMs: 10 * MIN, agentId: 'a1' }),
    at('2026-10-19T12:15:00Z', 'turn_end', { durationMs: 5 * MIN }),
  ]
  expect(summarize(events, { idleCapMs: 1 * MIN }).totalMs).toBe(5 * MIN)
})

test('short idle gaps are bridged', () => {
  const events = [at('2026-10-19T12:00:00Z', 'tool'), at('2026-10-19T12:04:00Z', 'tool')]
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

test('a /compact between turns counts, a precompute does not', () => {
  const events = [
    at('2026-10-19T12:01:00Z', 'turn_end', { durationMs: 1 * MIN }),
    at('2026-10-19T12:20:00Z', 'compact', { trigger: 'manual', durationMs: 2 * MIN }),
    at('2026-10-19T12:40:00Z', 'compact', { trigger: 'precompute', durationMs: 2 * MIN }),
  ]
  expect(summarize(events, { idleCapMs: 5 * MIN }).totalMs).toBe(3 * MIN)
})

test('counts prompts sent mid-turn and interrupts that stopped a tool', () => {
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt', { origin: 'composer' }),
    at('2026-10-19T12:00:30Z', 'prompt', { origin: 'composer', midTurn: true }),
    at('2026-10-19T12:01:00Z', 'interrupt', { durationMs: MIN, answerChars: 40, toolsRunning: ['Bash'] }),
    at('2026-10-19T12:02:00Z', 'interrupt', { durationMs: MIN, answerChars: 12 }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.prompts.midTurn).toBe(1)
  expect(s.interrupts).toBe(2)
  expect(s.interruptsMidTool).toBe(1)
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
    at('2026-10-19T12:00:00Z', 'tool'),
    at('2026-10-19T12:02:00Z', 'tool'),
    at('2026-10-19T12:03:00Z', 'tool', { cwd: '/code/vxm', project: 'vxm' }),
    at('2026-10-19T12:06:00Z', 'tool', { cwd: '/code/vxm', project: 'vxm' }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.projects).toEqual([
    { project: 'vxm', ms: 3 * MIN },
    { project: 'terra', ms: 2 * MIN },
  ])
})

test('file order across sessions does not matter', () => {
  const a = at('2026-10-19T12:00:00Z', 'tool')
  const b = at('2026-10-19T12:01:00Z', 'tool', { sessionId: 's2' })
  const c = at('2026-10-19T12:02:00Z', 'tool')
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
    at('2026-10-19T12:01:00Z', 'tool', { tool: 'Bash', outcome: 'ok', durationMs: 100 }),
    at('2026-10-19T12:01:10Z', 'tool', { tool: 'Bash', outcome: 'error', durationMs: 300 }),
    at('2026-10-19T12:01:20Z', 'tool', { tool: 'Edit', outcome: 'denied', durationMs: 5 }),
    at('2026-10-19T12:01:30Z', 'file_changed', { path: '/code/terra/a.ts', via: 'tool' }),
    at('2026-10-19T12:01:31Z', 'file_changed', { path: '/code/terra/Makefile', via: 'bash-window' }),
    at('2026-10-19T12:02:00Z', 'interrupt', { durationMs: 1000, usage }),
    // the same Esc aborting a subagent doesn't count twice
    at('2026-10-19T12:02:00Z', 'interrupt', { durationMs: 500, agentId: 'sub' }),
    at('2026-10-19T12:03:00Z', 'turn_end', { durationMs: 1000, usage, agentId: 'sub' }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.prompts).toEqual({ count: 2, avgWords: 3, avgChars: 15, typed: 1, midTurn: 0 })
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

test('typing a prompt counts as active time, tea breaks do not', () => {
  const events = [
    // 10 minutes from first key to Enter, 2 of them actually typing
    at('2026-10-19T12:10:00Z', 'prompt', { origin: 'composer', composeMs: 10 * MIN, typingMs: 2 * MIN, typedChars: 300, pastedChars: 0 }),
    at('2026-10-19T12:15:00Z', 'turn_end', { durationMs: 5 * MIN }),
  ]
  const s = summarize(events, { idleCapMs: 1 * MIN })
  expect(s.totalMs).toBe(7 * MIN)
  expect(s.writing).toMatchObject({ typingMs: 2 * MIN, sent: 1, abandoned: 0, abandonedMs: 0, typedChars: 300, pastedChars: 0, measured: 0 })
})

test('an abandoned draft is placed by its own end, not its late line', () => {
  // given up at 23:50 in New York, but only logged at 01:00 when the next draft began
  const events = [
    at('2026-10-20T05:00:00Z', 'draft_abandoned', {
      startedAt: '2026-10-20T03:49:00Z',
      endedAt: '2026-10-20T03:50:00Z',
      typingMs: 1 * MIN,
      composeMs: 1 * MIN,
      typedChars: 40,
      how: 'clear',
    }),
  ]
  const s = summarize(events, { idleCapMs: 5 * MIN })
  expect(s.days).toEqual([{ day: '2026-10-19', ms: 1 * MIN, prompts: 0 }])
  expect(s.writing).toMatchObject({ abandoned: 1, abandonedMs: 1 * MIN, typingMs: 1 * MIN, sent: 0 })
})

test('fixes, rewrites and pauses add up over drafts that have them', () => {
  const fields = { origin: 'composer', typingMs: MIN, fixes: 2, rewrites: 1, rewrittenChars: 12, pauses: 3, breaks: 0, longestPauseMs: 9_000 }
  const events = [
    at('2026-10-19T12:00:00Z', 'prompt', fields),
    at('2026-10-19T12:05:00Z', 'draft_abandoned', { ...fields, endedAt: '2026-10-19T12:04:00Z', breaks: 1, longestPauseMs: 50_000 }),
    // from before these fields existed
    at('2026-10-19T12:10:00Z', 'prompt', { origin: 'composer', typingMs: MIN }),
  ]
  const { writing } = summarize(events, { idleCapMs: 5 * MIN })
  expect(writing).toMatchObject({ sent: 2, abandoned: 1, measured: 2, fixes: 4, rewrites: 2, rewrittenChars: 24, pauses: 6, breaks: 1, longestPauseMs: 50_000 })
})

test('languageOf', () => {
  expect(languageOf('/a/b/x.TSX')).toBe('TypeScript')
  expect(languageOf('/a/.env')).toBe('Other')
  expect(languageOf('/a/Dockerfile')).toBe('Docker')
  expect(languageOf('/a/noext')).toBe('Other')
})
