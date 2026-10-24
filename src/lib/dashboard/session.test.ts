import { expect, test } from 'vitest'
import { projectSpans, summarize, type Event } from '../analytics/aggregate'
import { laneRows, mostlyQuiet, projectSplit } from './session'
import { palette } from './shared'

const MIN = 60_000
const START = Date.parse('2026-10-19T12:00:00Z')
const at = (ms: number, event: string, extra: Partial<Event> = {}): Event => ({
  ts: new Date(START + ms).toISOString(),
  sessionId: 's1',
  cwd: '/code/terra',
  event,
  ...extra,
})
const rows = (events: Event[]) => laneRows({ events, drafts: [], tracks: [], colors: palette([]), onpick: () => {} }).rows
const opus = { input_tokens: 1, output_tokens: 1, model: 'claude-opus-5-5' }

test('subagents get a track apiece, shared by ones that never overlap, and their calls leave the Tools lane', () => {
  const events = [
    at(1 * MIN, 'tool', { tool: 'Read', durationMs: 1_000, file: '/code/terra/src/a.ts' }),
    // a and b run side by side, c after a is done
    at(2 * MIN, 'tool', { tool: 'Grep', durationMs: 1_000, agentId: 'a' }),
    at(5 * MIN, 'turn_end', { durationMs: 4 * MIN, agentId: 'a', usage: opus }),
    at(3 * MIN, 'tool', { tool: 'Bash', durationMs: 1_000, agentId: 'b' }),
    at(8 * MIN, 'turn_end', { durationMs: 6 * MIN, agentId: 'b', usage: opus }),
    // c never ended a turn, so its calls are its run
    at(6 * MIN, 'tool', { tool: 'Read', durationMs: 30_000, agentId: 'c' }),
    at(7 * MIN, 'tool', { tool: 'Read', durationMs: 30_000, agentId: 'c' }),
    at(10 * MIN, 'turn_end', { durationMs: 10 * MIN, usage: opus }),
  ]
  const lanes = rows(events)
  expect(lanes.map(r => r.key)).toEqual(['you', 'claude', 'agents', 'tools', 'projects'])
  const agents = lanes.find(r => r.key === 'agents')!
  expect(agents.sub).toBe('3 ran')
  const runs = agents.bars.filter(b => !b.plain)
  expect(runs.map(b => [b.group, b.top, b.from - START, b.to - START])).toEqual([
    ['a', 0, 1 * MIN, 5 * MIN],
    ['b', 15, 2 * MIN, 8 * MIN],
    ['c', 0, 5.5 * MIN, 7 * MIN],
  ])
  expect(runs[0]!.tip).toContain('Opus 5.5')
  expect(agents.bars.filter(b => b.plain)).toHaveLength(4)
  const tools = lanes.find(r => r.key === 'tools')!.bars
  expect(tools).toHaveLength(1)
  expect(tools[0]!.tip).toContain('src/a.ts')
  expect(tools[0]!.tip).not.toContain('/code/terra')
})

test("a main-thread compaction stands taller than the turns, with the context's sizes in its card", () => {
  const events = [
    at(1 * MIN, 'turn_end', { durationMs: 1 * MIN, usage: opus }),
    at(3 * MIN, 'compact', { trigger: 'auto', tokensBefore: 368_000, tokensAfter: 34_000, durationMs: 60_000 }),
    at(5 * MIN, 'compact', { trigger: 'precompute', tokensBefore: 90_000, tokensAfter: 20_000, durationMs: 30_000 }),
  ]
  const claude = rows(events).find(r => r.key === 'claude')!
  const [auto, precompute] = claude.bars.filter(b => b.tip?.includes('Compaction'))
  expect(auto!.tip).toContain('context 368K → 34K tokens, 91% smaller')
  expect(auto!.height).toBeGreaterThan(claude.height)
  expect(precompute!.height).toBe(claude.height)
  expect(claude.marks).toEqual([])
  expect(rows(events).some(r => r.key === 'agents')).toBe(false)
})

test('a session is mostly quiet when gaps over 5 minutes are more than half its length', () => {
  // an hour of work, a night away, and another hour
  expect(
    mostlyQuiet([
      [0, 60 * MIN],
      [10 * 60 * MIN, 11 * 60 * MIN],
    ]),
  ).toBe(true)
  // short pauses don't count, however many
  expect(
    mostlyQuiet([
      [0, 10 * MIN],
      [14 * MIN, 20 * MIN],
      [24 * MIN, 30 * MIN],
    ]),
  ).toBe(false)
  // nor does a long gap in a long day of work
  expect(
    mostlyQuiet([
      [0, 4 * 60 * MIN],
      [5 * 60 * MIN, 9 * 60 * MIN],
    ]),
  ).toBe(false)
  expect(mostlyQuiet([])).toBe(false)
})

test("a session's split by project is the one its row on the overview gets", () => {
  const events = [
    at(0, 'prompt', { typingMs: 20_000 }),
    // the main thread moves to hub and back, while a fork works in docs
    at(2 * MIN, 'tool', { tool: 'Edit', durationMs: 1 * MIN, workProject: 'hub' }),
    at(3 * MIN, 'tool', { agentId: 'a1', tool: 'Edit', durationMs: 1000, workProject: 'docs' }),
    at(9 * MIN, 'turn_end', { agentId: 'a1', durationMs: 7 * MIN }),
    at(7 * MIN, 'tool', { tool: 'Bash', durationMs: 1 * MIN, workProject: 'terra' }),
    at(10 * MIN, 'turn_end', { durationMs: 10 * MIN }),
    // a quiet hour, then a quick one back in terra
    at(70 * MIN, 'prompt', { typingMs: 5000 }),
    at(72 * MIN, 'turn_end', { durationMs: 2 * MIN }),
  ]
  const split = projectSplit(projectSpans(events, 5 * MIN))
  expect(split.map(p => p.project)).toEqual(['terra', 'docs', 'hub'])
  expect(split).toEqual(summarize(events, { idleCapMs: 5 * MIN }).sessions[0]!.projects)
})
