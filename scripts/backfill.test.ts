import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { decodeSession } from '../src/lib/analytics/eventlog'

// runs the mod's backfill.py against a throwaway home
const SCRIPT = join(import.meta.dir, '../mod/backfill.py')

const start = Date.parse('2026-10-19T12:00:00Z')
const at = (sec: number) => new Date(start + sec * 1000).toISOString()
const file = (...rows: unknown[]) => rows.map(row => `${JSON.stringify(row)}\n`).join('')

function setup(config?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'claude-hours-backfill-'))
  const terra = join(home, 'code/terra')
  const hub = join(home, 'code/hub')
  // two repos, the hub's origin calling it claude-hours
  for (const [repo, origin] of [
    [terra, ''],
    [hub, 'git@github.com:hackclub/claude-hours.git'],
  ] as const) {
    mkdirSync(join(repo, 'web/src'), { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', repo])
    if (origin) Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', origin])
  }
  if (config !== undefined) {
    mkdirSync(join(home, '.claude/analytics'), { recursive: true })
    writeFileSync(join(home, '.claude/analytics/config.json'), JSON.stringify(config))
  }
  // a transcript, finished long enough ago not to be live
  const transcript = (session: string, text: string, agents: Record<string, string> = {}) => {
    const folder = join(home, '.claude/projects/-code-terra')
    const paths = [join(folder, `${session}.jsonl`), ...Object.keys(agents).map(id => join(folder, session, 'subagents', `agent-${id}.jsonl`))]
    for (const [i, path] of paths.entries()) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, i ? Object.values(agents)[i - 1]! : text)
      utimesSync(path, new Date(start), new Date(start))
    }
    return paths[0]!
  }
  const run = () => {
    const r = Bun.spawnSync(['python3', SCRIPT], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' } })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return JSON.parse(r.stdout.toString())
  }
  const out = join(home, '.claude/analytics/backfill/events')
  const written = (session: string) => readFileSync(join(out, `${session}.jsonl`), 'utf8')
  const events = (session: string) => decodeSession(written(session), session)
  return { home, terra, hub, transcript, run, out, written, events }
}

const typed = (cwd: string, sec: number, content: unknown, extra = {}) => ({
  type: 'user',
  timestamp: at(sec),
  cwd,
  entrypoint: 'cli',
  origin: { kind: 'human' },
  promptSource: 'typed',
  message: { role: 'user', content },
  ...extra,
})
const assistant = (cwd: string, sec: number, id: string, content: unknown[], usage = { input_tokens: 1, output_tokens: 10 }) => ({
  type: 'assistant',
  timestamp: at(sec),
  cwd,
  message: { id, model: 'claude-opus-5-5', content, usage },
})
const useTool = (cwd: string, sec: number, id: string, name: string, input: unknown) =>
  assistant(cwd, sec, `m-${id}`, [{ type: 'tool_use', id, name, input }])
const result = (cwd: string, sec: number, id: string, extra = {}) => ({
  type: 'user',
  timestamp: at(sec),
  cwd,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'secret output' }] },
  ...extra,
})
const turnEnd = (cwd: string, sec: number, durationMs: number) => ({ type: 'system', subtype: 'turn_duration', timestamp: at(sec), cwd, durationMs })
const turns = (events: ReturnType<typeof decodeSession>) => events.filter(e => (e.event === 'interrupt' || e.event === 'turn_end') && !e.agentId)

test('a turn: its prompt, tool calls, edits and the turn with its tokens', () => {
  const { terra, hub, transcript, run, written, events } = setup()
  const cwd = join(terra, 'web')
  transcript(
    's1',
    file(
      typed(cwd, 0, 'fix the db please', { permissionMode: 'auto' }),
      assistant(cwd, 2, 'm1', [{ type: 'thinking' }], { input_tokens: 1, output_tokens: 5 }),
      // the same message again, done streaming: its usage is the whole of it
      assistant(cwd, 3, 'm1', [{ type: 'text', text: 'on it' }], { input_tokens: 1, output_tokens: 40 }),
      useTool(cwd, 4, 't1', 'Edit', { file_path: join(cwd, 'src/db.ts'), old_string: 'a', new_string: 'b' }),
      result(cwd, 5, 't1'),
      useTool(cwd, 6, 't2', 'Bash', { command: 'cd ../../hub && bun test' }),
      result(cwd, 16, 't2'),
      turnEnd(cwd, 20, 19_000),
    ),
  )
  expect(run()).toMatchObject({ written: 1, logged: 0, live: 0, sessions: ['s1'] })
  expect(JSON.parse(written('s1').split('\n')[0]!)).toEqual({ v: 1, event: 'session', start, cwd, root: terra, backfill: 2 })
  const all = events('s1')
  expect(all.map(e => e.event)).toEqual(['session_start', 'mode', 'prompt', 'tool', 'file_changed', 'tool', 'turn_end'])
  const [opened, mode, prompt, edit, changed, bash, turn] = all
  expect(opened).toMatchObject({ ts: at(0), cwd, root: terra, surface: 'terminal', isInteractive: true, backfill: true })
  expect(mode).toMatchObject({ mode: 'auto' })
  expect(prompt).toMatchObject({ words: 4, chars: 17, origin: 'composer', isMeta: false })
  expect(prompt!.midTurn).toBeUndefined()
  expect(edit).toMatchObject({ ts: at(5), tool: 'Edit', file: join(cwd, 'src/db.ts'), outcome: 'ok', durationMs: 1000 })
  expect(changed).toMatchObject({ tool: 'Edit', path: join(cwd, 'src/db.ts'), via: 'tool' })
  // a cd into another repo moves the call there, by its origin's name
  expect(bash).toMatchObject({ tool: 'Bash', repo: hub, repoName: 'claude-hours', commandChars: 24, durationMs: 10_000 })
  expect(turn).toMatchObject({
    ts: at(20),
    reason: 'answer',
    durationMs: 19_000,
    usage: { input_tokens: 3, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
  })
})

test('only counts leave the transcript, never text, commands or output', () => {
  const { terra, transcript, run, written } = setup()
  transcript(
    's1',
    file(
      typed(terra, 0, 'my password is hunter2'),
      useTool(terra, 1, 't1', 'Bash', { command: 'echo hunter2' }),
      result(terra, 2, 't1'),
      turnEnd(terra, 3, 3000),
    ),
  )
  run()
  expect(written('s1')).not.toMatch(/hunter2|password|echo|secret output/)
})

test("config.json's ignored folders write nothing, and its excluded files lose their path", () => {
  const writes = (cwd: string) =>
    file(
      typed(cwd, 0, 'hi'),
      useTool(cwd, 1, 't1', 'Write', { file_path: join(cwd, '.env'), content: 'x' }),
      result(cwd, 2, 't1'),
      turnEnd(cwd, 3, 3000),
    )
  const ignored = setup()
  ignored.transcript('s1', writes(ignored.terra))
  mkdirSync(join(ignored.home, '.claude/analytics'), { recursive: true })
  writeFileSync(join(ignored.home, '.claude/analytics/config.json'), JSON.stringify({ ignore: [ignored.terra] }))
  expect(ignored.run()).toMatchObject({ written: 0, empty: 1, sessions: [] })

  const excluded = setup({ files: { exclude: ['.env'] } })
  excluded.transcript('s1', writes(excluded.terra))
  excluded.run()
  const all = excluded.events('s1')
  expect(all.find(e => e.event === 'tool')?.file).toBeUndefined()
  expect(all.some(e => e.event === 'file_changed')).toBe(false)
})

test('denied and failed calls', () => {
  const { terra, transcript, run, events } = setup()
  const failed = { ...result(terra, 4, 't2'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } }
  transcript(
    's1',
    file(
      typed(terra, 0, 'go'),
      useTool(terra, 1, 't1', 'Bash', { command: 'rm -rf /' }),
      result(terra, 2, 't1', { toolDenialKind: 'user-rejected' }),
      useTool(terra, 3, 't2', 'Read', { file_path: 'nope.ts' }),
      failed,
      turnEnd(terra, 5, 5000),
    ),
  )
  run()
  expect(
    events('s1')
      .filter(e => e.event === 'tool')
      .map(e => e.outcome),
  ).toEqual(['denied', 'error'])
})

test('a turn that never ends is an interrupt, up to its last work before a long silence', () => {
  const { terra, transcript, run, events } = setup()
  transcript(
    's1',
    file(
      typed(terra, 0, 'first'),
      useTool(terra, 10, 't1', 'Bash', { command: 'ls' }),
      result(terra, 12, 't1'),
      // a request that hung for an hour
      assistant(terra, 3600, 'm2', [{ type: 'text', text: 'API Error' }]),
      typed(terra, 3700, 'seems like you got interrupted'),
      turnEnd(terra, 3710, 9000),
    ),
  )
  run()
  expect(turns(events('s1')).map(e => [e.event, e.ts, e.durationMs])).toEqual([
    ['interrupt', at(12), 12_000],
    ['turn_end', at(3710), 9000],
  ])
})

test('an Esc says so, and the turn_duration after it is the same turn', () => {
  const { terra, transcript, run, events } = setup()
  const esc = typed(terra, 5, [{ type: 'text', text: '[Request interrupted by user]' }], { origin: undefined, promptSource: undefined })
  transcript('s1', file(typed(terra, 0, 'go'), assistant(terra, 2, 'm1', [{ type: 'text', text: 'hm' }]), esc, turnEnd(terra, 5, 4000)))
  run()
  expect(turns(events('s1')).map(e => [e.event, e.durationMs])).toEqual([['interrupt', 5000]])
})

test('an Esc after a long silence ends the turn at its last work, not days later', () => {
  const { terra, transcript, run, events } = setup()
  const esc = (sec: number) =>
    typed(terra, sec, [{ type: 'text', text: '[Request interrupted by user]' }], { origin: undefined, promptSource: undefined })
  transcript(
    's1',
    file(
      typed(terra, 0, 'go'),
      useTool(terra, 10, 't1', 'Bash', { command: 'ls' }),
      result(terra, 12, 't1'),
      // the laptop slept with the request open, and the Esc came days later,
      // a background task's notification landing as it woke
      {
        type: 'attachment',
        timestamp: at(5 * 86_400),
        cwd: terra,
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'task done', origin: { kind: 'task-notification' } },
      },
      esc(5 * 86_400),
      typed(terra, 5 * 86_400 + 60, 'again'),
      useTool(terra, 5 * 86_400 + 70, 't2', 'Bash', { command: 'ls' }),
      // a call whose result only came back after a sleep
      result(terra, 6 * 86_400, 't2'),
      esc(6 * 86_400 + 1),
    ),
  )
  run()
  expect(turns(events('s1')).map(e => [e.event, e.ts, e.durationMs])).toEqual([
    ['interrupt', at(12), 12_000],
    ['interrupt', at(5 * 86_400 + 70), 10_000],
  ])
})

test('slash commands count once Claude answers them, local ones never', () => {
  const { terra, transcript, run, events } = setup()
  const plain = { origin: undefined, promptSource: undefined }
  const command = (sec: number, name: string, args = '') =>
    typed(
      terra,
      sec,
      `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
      plain,
    )
  transcript(
    's1',
    file(
      command(0, 'model'),
      typed(terra, 1, '<local-command-stdout>Set model to opus</local-command-stdout>', plain),
      command(10, 'goal', 'ship it'),
      assistant(terra, 12, 'm1', [{ type: 'text', text: 'ok' }]),
      turnEnd(terra, 14, 4000),
    ),
  )
  run()
  expect(
    events('s1')
      .filter(e => e.event === 'prompt')
      .map(e => [e.command, e.words]),
  ).toEqual([['goal', 3]])
})

test('prompts sent mid-turn, and notifications that are no prompt of the mod', () => {
  const { terra, transcript, run, events } = setup()
  const queued = (sec: number, commandMode: string, origin: unknown) => ({
    type: 'attachment',
    timestamp: at(sec),
    cwd: terra,
    attachment: { type: 'queued_command', commandMode, prompt: 'also this', origin },
  })
  transcript(
    's1',
    file(
      typed(terra, 0, 'go'),
      queued(3, 'prompt', { kind: 'human' }),
      queued(4, 'task-notification', { kind: 'task-notification' }),
      turnEnd(terra, 6, 6000),
    ),
  )
  run()
  expect(
    events('s1')
      .filter(e => e.event === 'prompt')
      .map(e => [e.ts, e.origin, e.midTurn]),
  ).toEqual([
    [at(0), 'composer', undefined],
    [at(3), 'composer', true],
  ])
})

test('a subagent is one turn of its own, its calls tagged with it', () => {
  const { terra, hub, transcript, run, events } = setup()
  const side = (entry: object) => ({ ...entry, isSidechain: true })
  transcript('s1', file(typed(terra, 0, 'go'), turnEnd(terra, 30, 29_000)), {
    ab12: file(
      side(useTool(terra, 5, 'a1', 'Read', { file_path: join(hub, 'web/src/x.ts') })),
      side(result(terra, 6, 'a1')),
      side(assistant(terra, 20, 'm9', [{ type: 'text', text: 'done' }])),
    ),
  })
  run()
  expect(
    events('s1')
      .filter(e => e.agentId)
      .map(e => [e.agentId, e.event, e.ts, e.durationMs, e.repo]),
  ).toEqual([
    ['ab12', 'tool', at(6), 1000, hub],
    ['ab12', 'turn_end', at(20), 15_000, undefined],
  ])
})

test("a subagent's turn ends at its last work before a long silence", () => {
  const { terra, transcript, run, events } = setup()
  const side = (entry: object) => ({ ...entry, isSidechain: true })
  transcript('s1', file(typed(terra, 0, 'go'), turnEnd(terra, 30, 29_000)), {
    ab12: file(
      side(useTool(terra, 5, 'a1', 'Bash', { command: 'bun run dev' })),
      // a dev server it waited on until the laptop slept, its line days later
      side(result(terra, 3 * 86_400, 'a1')),
      side(assistant(terra, 3 * 86_400 + 10, 'm9', [{ type: 'text', text: 'done' }])),
    ),
  })
  run()
  expect(
    events('s1')
      .filter(e => e.agentId && e.event === 'turn_end')
      .map(e => [e.ts, e.durationMs]),
  ).toEqual([[at(5), 0]])
})
test("stops where the mod's own log begins, and skips sessions it has whole, can't read, or are still going", () => {
  const { home, terra, transcript, run, out, written, events } = setup()
  const twice = file(typed(terra, 0, 'one'), turnEnd(terra, 10, 9000), typed(terra, 100, 'two'), turnEnd(terra, 110, 9000))
  const mod = join(home, '.claude/analytics/events')
  mkdirSync(mod, { recursive: true })
  // joined at the second prompt: the one before is the backfill's, and the
  // prompt that woke the mod (stamped a moment later) is the mod's
  transcript('late', twice)
  writeFileSync(join(mod, 'late.jsonl.gz'), gzipSync(file({ v: 1, event: 'session', start: start + 100_400, cwd: terra }, { t: 0, event: 'prompt' })))
  // logged from its first moment
  const opened = { type: 'attachment', timestamp: at(0), cwd: terra, entrypoint: 'cli', attachment: { type: 'date' } }
  transcript('whole', file(opened, typed(terra, 1, 'one'), turnEnd(terra, 9, 8000)))
  writeFileSync(join(mod, 'whole.jsonl'), file({ v: 1, event: 'session', start: start + 500, cwd: terra }))
  // a pack cut short
  transcript('broken', twice)
  writeFileSync(join(mod, 'broken.jsonl.gz'), gzipSync(file({ v: 1, event: 'session', start, cwd: terra })).subarray(0, 20))
  // still being written
  utimesSync(transcript('live', twice), new Date(), new Date())

  expect(run()).toMatchObject({ written: 1, logged: 2, live: 1, sessions: ['late'] })
  expect(
    events('late')
      .filter(e => e.event === 'prompt')
      .map(e => e.ts),
  ).toEqual([at(0)])
  expect(readdirSync(out)).toEqual(['late.jsonl'])
  // the same transcripts give the same rows
  const first = written('late')
  run()
  expect(written('late')).toBe(first)
})
