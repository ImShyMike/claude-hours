import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEvents, projectFor } from './load'

const scratch = () => mkdtempSync(join(tmpdir(), 'hackatime-test-'))

test('projectFor names the git root, not the subdir', () => {
  const home = scratch()
  mkdirSync(join(home, 'code/terra/.git'), { recursive: true })
  mkdirSync(join(home, 'code/terra/packages/db'), { recursive: true })
  expect(projectFor(join(home, 'code/terra/packages/db'), home)).toBe('terra')
  expect(projectFor(join(home, 'code/loose'), home)).toBe('loose')
})

test('projectFor gives ~/.claude a friendly name', () => {
  const home = scratch()
  mkdirSync(join(home, '.claude/mods/x'), { recursive: true })
  expect(projectFor(join(home, '.claude/mods/x'), home)).toBe('~/.claude')
})

test('loadEvents reads every events*.jsonl and skips other files', async () => {
  const dir = scratch()
  const line = (event: string) => `${JSON.stringify({ ts: '2026-10-19T12:00:00Z', sessionId: 's', cwd: '/nowhere/proj', event })}\n`
  writeFileSync(join(dir, 'events.jsonl'), line('a'))
  writeFileSync(join(dir, 'events-2026-09.jsonl'), line('b') + '{"torn')
  writeFileSync(join(dir, 'notes.txt'), line('c'))
  const events = await loadEvents(dir)
  expect(events.map(e => e.event).sort()).toEqual(['a', 'b'])
  expect(events[0]!.project).toBe('proj')
})

test('loadEvents on a missing dir is empty', async () => {
  expect(await loadEvents(join(scratch(), 'nope'))).toEqual([])
})
