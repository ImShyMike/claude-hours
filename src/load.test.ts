import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { loadEvents, loadTimelines, projectFor, repoName } from './load'

const scratch = () => mkdtempSync(join(tmpdir(), 'claude-hours-test-'))

test('projectFor names the git root, not the subdir', () => {
  const home = scratch()
  mkdirSync(join(home, 'code/terra/.git'), { recursive: true })
  mkdirSync(join(home, 'code/terra/packages/db'), { recursive: true })
  expect(projectFor(join(home, 'code/terra/packages/db'), home)).toBe('terra')
  expect(projectFor(join(home, 'code/loose'), home)).toBe('loose')
})

test('a worktree is named after the repo it was made from', () => {
  const home = scratch()
  const tree = join(home, 'code/terra/.claude/worktrees/agent-1')
  mkdirSync(join(home, 'code/terra/.git/worktrees/agent-1'), { recursive: true })
  mkdirSync(join(tree, 'src'), { recursive: true })
  writeFileSync(join(tree, '.git'), `gitdir: ${join(home, 'code/terra/.git/worktrees/agent-1')}\n`)
  expect(projectFor(join(tree, 'src'), home)).toBe('terra')
  // the hub only has the path to go on
  expect(repoName('/u/code/terra/.claude/worktrees/agent-1/src')).toBe('terra')
  expect(repoName('/u/.claude/.claude/worktrees/agent-1')).toBe('~/.claude')
  expect(repoName('/u/code/terra')).toBe('terra')
})

test('projectFor gives ~/.claude a friendly name', () => {
  const home = scratch()
  mkdirSync(join(home, '.claude/mods/x'), { recursive: true })
  expect(projectFor(join(home, '.claude/mods/x'), home)).toBe('~/.claude')
})

test('loadEvents reads every session file in events/ and skips other files', async () => {
  const dir = scratch()
  mkdirSync(join(dir, 'events'))
  const session = (event: string) =>
    `${JSON.stringify({ v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z'), cwd: '/nowhere/proj' })}\n${JSON.stringify({ t: 0, event })}\n`
  writeFileSync(join(dir, 'events', 'abc-1.jsonl'), session('a'))
  writeFileSync(join(dir, 'events', 'abc-2.jsonl'), session('b') + '{"torn')
  writeFileSync(join(dir, 'events', 'notes.txt'), session('c'))
  writeFileSync(join(dir, 'events.jsonl'), session('d'))
  const events = await loadEvents(dir)
  expect(events.map(e => [e.event, e.sessionId])).toEqual([
    ['a', 'abc-1'],
    ['b', 'abc-2'],
  ])
  expect(events[0]!.project).toBe('proj')
})

test('loadEvents says which repo a tool call really worked in', async () => {
  const dir = scratch()
  const code = scratch()
  mkdirSync(join(dir, 'events'))
  mkdirSync(join(code, 'terra/.git'), { recursive: true })
  mkdirSync(join(code, 'hub/.git'), { recursive: true })
  mkdirSync(join(code, 'loose'), { recursive: true })
  const rows = [
    { v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z'), cwd: join(code, 'terra') },
    // the mod's repo, a file outside the cwd, one in no repo, one inside it,
    // a Bash with no repo, and a tool that says nothing
    { t: 1, event: 'tool', tool: 'Bash', repo: join(code, 'hub') },
    { t: 2, event: 'tool', tool: 'Edit', file: join(code, 'hub/src/a.ts') },
    { t: 3, event: 'tool', tool: 'Read', file: join(code, 'loose/notes.txt') },
    { t: 4, event: 'file_changed', path: 'src/b.ts' },
    { t: 5, event: 'tool', tool: 'Bash' },
    { t: 6, event: 'tool', tool: 'WebFetch' },
  ]
  writeFileSync(join(dir, 'events', 'abc-1.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))
  const events = await loadEvents(dir)
  expect(events.map(e => e.workProject)).toEqual(['hub', 'hub', undefined, 'terra', 'terra', undefined])
  // on the hub, only what the mod said counts: someone else's disk can't be read
  const remote = await loadEvents(dir, { remote: true })
  expect(remote.map(e => e.workProject)).toEqual(['hub', undefined, undefined, 'terra', 'terra', undefined])
})

test('on the hub a project is the root the mod sent, else the cwd folder', async () => {
  const dir = scratch()
  mkdirSync(join(dir, 'events'))
  const rows = [
    { v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z'), cwd: '/u/terra/packages/api', root: '/u/terra' },
    { t: 1, event: 'prompt' },
    { t: 2, event: 'cwd_changed', cwd: '/u/terra/.claude/worktrees/agent-1' },
    { t: 3, event: 'cwd_changed', cwd: '/u/loose/notes' },
  ]
  writeFileSync(join(dir, 'events', 'abc-1.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))
  const events = await loadEvents(dir, { remote: true })
  expect(events.map(e => e.project)).toEqual(['terra', 'terra', 'notes'])
})

test('a folder with no repo to be found under the session start is part of its project', async () => {
  const dir = scratch()
  const code = scratch()
  mkdirSync(join(dir, 'events'))
  const rows = [
    // renamed away since, so nothing on disk says which repo it was
    { v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z'), cwd: join(code, 'hours') },
    { t: 0, event: 'prompt' },
    { t: 1, event: 'cwd_changed', cwd: join(code, 'hours/mod/hooks') },
    { t: 2, event: 'cwd_changed', cwd: join(code, 'elsewhere') },
  ]
  writeFileSync(join(dir, 'events', 'abc-1.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))
  expect((await loadEvents(dir)).map(e => e.project)).toEqual(['hours', 'hours', 'elsewhere'])
})

test('a repo the mod named by its origin goes by that name', async () => {
  const dir = scratch()
  mkdirSync(join(dir, 'events'))
  const rows = [
    { v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z'), cwd: '/u/terra' },
    { t: 1, event: 'tool', tool: 'Bash', repo: '/tmp/scratch/ts-clone', repoName: 'telescreen' },
    { t: 2, event: 'cwd_changed', cwd: '/tmp/scratch/ts-clone/server', root: '/tmp/scratch/ts-clone', rootName: 'telescreen' },
  ]
  writeFileSync(join(dir, 'events', 'abc-1.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))
  for (const remote of [false, true]) {
    const events = await loadEvents(dir, { remote })
    expect(events.map(e => [e.project, e.workProject])).toEqual([
      ['terra', 'telescreen'],
      ['telescreen', undefined],
    ])
  }
})

test('loadEvents on a missing dir is empty', async () => {
  expect(await loadEvents(join(scratch(), 'nope'))).toEqual([])
})

test('loadTimelines reads one session and refuses odd ids', async () => {
  const dir = scratch()
  mkdirSync(join(dir, 'drafts'))
  const row = { v: 1, draftId: 'd1', outcome: 'sent', startedAt: 1_790_000_000_000, durationMs: 0, steps: '' }
  writeFileSync(join(dir, 'drafts', 'abc-123.jsonl'), `${JSON.stringify(row)}\n`)
  writeFileSync(join(dir, 'secret.jsonl'), `${JSON.stringify(row)}\n`)
  expect(await loadTimelines(dir, 'abc-123')).toHaveLength(1)
  expect(await loadTimelines(dir, 'nope')).toEqual([])
  expect(await loadTimelines(dir, '../secret')).toEqual([])
  expect(await loadTimelines(dir, '../drafts/abc-123')).toEqual([])
})

test('a session in both .jsonl.gz and .jsonl reads both, every gzip member too', async () => {
  const dir = scratch()
  mkdirSync(join(dir, 'events'))
  mkdirSync(join(dir, 'drafts'))
  const part = (sec: number, event: string) =>
    `${JSON.stringify({ v: 1, event: 'session', start: Date.parse('2026-10-19T12:00:00Z') + sec * 1000, cwd: '/nowhere/proj' })}\n${JSON.stringify({ t: 0, event })}\n`
  // two packs appended to one .gz, then a resume that hasn't been packed yet
  writeFileSync(join(dir, 'events', 'abc.jsonl.gz'), Buffer.concat([gzipSync(part(0, 'prompt')), gzipSync(part(60, 'turn_end'))]))
  writeFileSync(join(dir, 'events', 'abc.jsonl'), part(120, 'prompt'))
  expect((await loadEvents(dir)).map(e => [e.sessionId, e.event, e.ts])).toEqual([
    ['abc', 'prompt', '2026-10-19T12:00:00.000Z'],
    ['abc', 'turn_end', '2026-10-19T12:01:00.000Z'],
    ['abc', 'prompt', '2026-10-19T12:02:00.000Z'],
  ])
  const row = (draftId: string) => `${JSON.stringify({ v: 1, draftId, outcome: 'sent', startedAt: 1_790_000_000_000, durationMs: 0, steps: '' })}\n`
  writeFileSync(join(dir, 'drafts', 'abc.jsonl.gz'), gzipSync(row('old')))
  writeFileSync(join(dir, 'drafts', 'abc.jsonl'), row('new'))
  expect((await loadTimelines(dir, 'abc')).map(t => t.draftId)).toEqual(['old', 'new'])
})
