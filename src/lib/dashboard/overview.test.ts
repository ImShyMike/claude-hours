import { expect, test } from 'vitest'
import { streaks, toolName, weekdays } from './overview'

test('MCP tools read as their server and tool, prefixes dropped', () => {
  expect(toolName('mcp__helium-devtools__take_screenshot')).toBe('helium-devtools · take screenshot')
  expect(toolName('mcp__plugin_engineering_slack__slack_read_thread')).toBe('slack · read thread')
  expect(toolName('mcp__claude_ai_Airtable__list_bases')).toBe('Airtable · list bases')
  expect(toolName('mcp__claude_ai_Claude_Docs__batch')).toBe('Claude Docs · batch')
  expect(toolName('mcp__hackclub-documentation__getPage')).toBe('hackclub-documentation · getPage')
  expect(toolName('Bash')).toBe('Bash')
})

test('streaks count days in a row with active time, the current one alive through a quiet today', () => {
  const days = [3, 0, 1, 1, 1, 0, 1, 1].map((ms, i) => ({ day: `2026-10-${String(10 + i).padStart(2, '0')}`, ms, prompts: 0, projects: {} }))
  expect(streaks(days, '2026-10-17')).toEqual({ longest: 3, current: 2 })
  expect(streaks(days, '2026-10-18')).toEqual({ longest: 3, current: 2 })
  expect(streaks(days, '2026-10-19')).toEqual({ longest: 3, current: 0 })
  expect(streaks(days.slice(0, 6), '2026-10-16')).toEqual({ longest: 3, current: 0 })
  // a today with no active time yet, only a prompt, doesn't break it either
  expect(streaks([...days, { day: '2026-10-18', ms: 0, prompts: 1, projects: {} }], '2026-10-18')).toEqual({ longest: 3, current: 2 })
  expect(streaks([], '2026-10-15')).toEqual({ longest: 0, current: 0 })
})

test('weekdays average each weekday over how many the range has, Monday first', () => {
  // Mon Oct 5 to Mon Oct 12 2026: two Mondays, one of each other day
  const days = [60, 0, 0, 0, 0, 0, 30, 20].map((m, i) => ({
    day: `2026-10-${String(5 + i).padStart(2, '0')}`,
    ms: m * 60_000,
    prompts: 0,
    projects: (m ? { terra: m * 60_000 } : {}) as Record<string, number>,
  }))
  const w = weekdays(days)
  expect(w.map(d => d.count)).toEqual([2, 1, 1, 1, 1, 1, 1])
  expect(w[0]).toMatchObject({ ms: 40 * 60_000, projects: { terra: 40 * 60_000 } })
  expect(w[6]).toMatchObject({ ms: 30 * 60_000 })
  expect(w[1]!.ms).toBe(0)
})
