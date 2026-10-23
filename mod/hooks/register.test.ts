import type { On, PromptChangeInput, PromptEditInput, PromptEditResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { dialogWaits } from './register'

// What the mod leaves out at its usual value, put back the way the dashboard
// does (src/eventlog.ts), so tests read rows whole
const DEFAULTS: Record<string, Record<string, unknown>> = {
  tool: { outcome: 'ok' },
  turn_end: { reason: 'answer' },
  file_changed: { via: 'tool' },
  prompt: { origin: 'composer', isMeta: false },
  session_start: { isInteractive: true },
  compact: { outcome: 'compacted' },
}
const DRAFT_COUNTERS = [
  'pastedChars',
  'deletedChars',
  'fixes',
  'rewrites',
  'rewrittenChars',
  'pauses',
  'breaks',
  'longestPauseMs',
  'wordDeletes',
  'lineKills',
]
const restore = (row: Record<string, unknown>) => {
  const zeros = typeof row.typingMs === 'number' ? Object.fromEntries(DRAFT_COUNTERS.map(k => [k, 0])) : {}
  return { ...DEFAULTS[String(row.event)], ...zeros, ...row }
}

// Nothing sits beneath the plugin: these hooks stand for the engine, and the
// `tee -a` runs are where the log lines land.
const setup = (on: On) => {
  // rows as the dashboard reads them, and exactly as written
  const lines: Record<string, unknown>[] = []
  const raw: Record<string, unknown>[] = []
  const runs: string[][] = []
  // each session file's header row, kept apart from the rows after it
  const headers: Record<string, unknown>[] = []
  // the per-session draft timelines, by file
  const timelines: Record<string, unknown>[] = []
  const timelineFiles = new Set<string>()
  // what each file holds, so fs.exists / fs.read answer like a disk would
  const files = new Map<string, string>()
  let findOutput = ''
  // git roots by folder, for `git -C <dir> rev-parse --show-toplevel
  // --git-common-dir`: [folder, its toplevel, its common dir if not the
  // toplevel's .git]. Most specific first
  const gitRoots: [string, string, string?][] = [
    ['/proj/.claude/worktrees/w1', '/proj/.claude/worktrees/w1', '/proj/.git'],
    ['/proj', '/proj'],
    ['/code/hub', '/code/hub'],
    ['/tmp/scratch/ts-clone', '/tmp/scratch/ts-clone'],
  ]
  // origin urls by repo, for `git -C <root> remote get-url origin`
  const remotes: Record<string, string> = {
    '/proj': 'git@github.com:me/proj.git',
    '/tmp/scratch/ts-clone': 'https://github.com/hackclub/telescreen.git',
  }
  let sweepOutput = ''
  let cwd = '/proj'
  let now = 1_790_000_000_000
  on('clock.now', () => ({ value: now }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', () => ({ value: '/home/test' }))
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    runs.push([...e.argv])
    if (cmd === 'tee') {
      const path = e.argv[2] ?? ''
      const stdin = e.init?.stdin ?? ''
      files.set(path, (files.get(path) ?? '') + stdin)
      const drafts = path.includes('/analytics/drafts/')
      if (drafts) timelineFiles.add(path)
      for (const text of stdin.split('\n').filter(Boolean)) {
        const row = JSON.parse(text)
        if (drafts) timelines.push(row)
        else if (row.event === 'session') headers.push(row)
        else {
          raw.push(row)
          lines.push(restore(row))
        }
      }
    }
    let stdout = cmd === 'find' ? findOutput : ''
    // the upload's reads: a session file as one stream from a line on, then
    // at most so many lines and bytes; and the sweep's list of finished sessions
    if (cmd === 'sh' && e.argv[2]?.includes('tail -n')) {
      const [path, from, most, bytes] = e.argv.slice(4) as [string, string, string, string]
      const lines = ((files.get(`${path}.gz`) ?? '') + (files.get(path) ?? '')).split(/(?<=\n)/)
      const all = new TextEncoder().encode(lines.slice(Number(from), Number(from) + Number(most)).join(''))
      stdout = new TextDecoder().decode(all.subarray(0, Number(bytes)))
    }
    if (cmd === 'sh' && e.argv[2]?.includes('*.jsonl.gz')) stdout = sweepOutput
    // the config, written where only its owner can read it
    if (cmd === 'sh' && e.argv[2]?.includes('umask 077')) files.set(e.argv[4]!, e.init?.stdin ?? '')
    if (cmd === 'uname') stdout = 'miggys-laptop\n'
    let exitCode = 0
    if (cmd === 'git' && e.argv[3] === 'remote') {
      stdout = remotes[e.argv[2]!] ?? ''
      return { value: { exitCode: stdout ? 0 : 2, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (cmd === 'git') {
      const dir = e.argv[2]!
      const found = gitRoots.find(([root]) => dir === root || dir.startsWith(`${root}/`))
      stdout = found ? `${found[1]}\n${found[2] ?? `${found[1]}/.git`}\n` : ''
      exitCode = stdout ? 0 : 128
    }
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the box as the editor would leave it, and the submit going through
  on('prompt.edit', (_, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  // every write in order, a path again each time it's rewritten
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  // the plugin's store, kept across sessions
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  return {
    store,
    writes,
    runs,
    lines,
    raw,
    headers,
    files,
    timelines,
    timelineFiles,
    setFind: (out: string) => (findOutput = out),
    setSweep: (out: string) => (sweepOutput = out),
    cd: (dir: string) => (cwd = dir),
    tick: (ms: number) => (now += ms),
  }
}

test('a prompt logs its word and char counts, never its text', async ($, on) => {
  const { lines } = setup(on)

  await $.prompt.submit({ text: '  hello  wörld\nhow are you ', wait: false, origin: { kind: 'composer' } })

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ event: 'prompt', words: 5, chars: 27 })
  expect(JSON.stringify(lines[0])).not.toContain('hello')
})

test('an aborted turn is an interrupt, an answered one a turn_end', async ($, on) => {
  const { lines } = setup(on)
  on('turn.complete', () => ({ text: '' }))

  const base = { answer: '', durationMs: 1200, turnId: 't1' }
  await $.turn.complete({ ...base, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...base, reason: 'answer', isAborted: false })

  expect(lines.map(l => l.event)).toEqual(['interrupt', 'turn_end'])
  expect(lines[0]).toMatchObject({ durationMs: 1200, turnId: 't1' })
})

test('the permission mode is logged when the main loop changes it, never for a subagent', async ($, on) => {
  const { lines } = setup(on)
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))

  await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'default' })
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'u1', permission_mode: 'default' })
  await $.classic.PostToolUse({
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'u2',
    permission_mode: 'plan',
    agent_id: 'a1',
  })
  await $.classic.Stop({ stop_hook_active: false, permission_mode: 'auto' })
  await $.classic.UserPromptSubmit({ prompt: 'and again', permission_mode: 'auto' })

  expect(lines.filter(l => l.event === 'mode').map(l => l.mode)).toEqual(['default', 'auto'])
})

test('a tool call logs one row when it ends, then the file it edited', async ($, on) => {
  const { lines, tick } = setup(on)
  on('tool.call', () => (tick(250), { result: {} }))

  await $.tool.call({ tool: 'Write', file_path: '/proj/a.txt', content: 'x' })

  expect(lines.map(l => l.event)).toEqual(['tool', 'file_changed'])
  // paths under the cwd are written relative to it
  expect(lines[0]).toMatchObject({ tool: 'Write', outcome: 'ok', durationMs: 250, file: 'a.txt' })
  expect(lines[1]).toMatchObject({ path: 'a.txt', via: 'tool' })
  expect(lines[0]!.toolUseId).toBeUndefined()
})

test('files a Bash call touched show up through the find window', async ($, on) => {
  const { lines, setFind } = setup(on)
  setFind('/proj/out.json\n/proj/data/x.csv\n')
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Bash', command: 'python3 gen.py' })

  const changed = lines.filter(l => l.event === 'file_changed')
  expect(changed.map(l => l.path)).toEqual(['out.json', 'data/x.csv'])
  expect(changed[0]).toMatchObject({ via: 'bash-window', tool: 'Bash' })
  expect(lines.find(l => l.event === 'tool')).toMatchObject({ commandChars: 14 })
})

test('session start logs once across reloads, session end logs its reason', async ($, on) => {
  const { lines } = setup(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  const start = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const
  await $.session.start(start)
  await $.session.start(start)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { command: 'claude --resume sess-1' } as never })

  expect(lines.map(l => [l.event, l.reason ?? l.surface])).toEqual([
    ['session_start', 'terminal'],
    ['session_end', 'prompt_input_exit'],
  ])
})

test('a session file opens with a header, rows carry ms since it, and a cd gets a cwd_changed', async ($, on) => {
  const { lines, headers, files, cd, tick } = setup(on)
  on('turn.complete', () => ({ text: '' }))

  const turn = { answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false } as const
  await $.turn.complete(turn)
  tick(1_500)
  await $.turn.complete(turn)
  cd('/other')
  await $.turn.complete(turn)

  expect(headers).toEqual([{ v: 1, event: 'session', start: 1_790_000_000_000, cwd: '/proj' }])
  expect(lines.map(l => [l.event, l.t, l.cwd])).toEqual([
    ['turn_end', 0, undefined],
    ['turn_end', 1_500, undefined],
    ['cwd_changed', 1_500, '/other'],
    ['turn_end', 1_500, undefined],
  ])
  // no sessionId or ts on any row: the file name and the header carry them
  expect(lines.some(l => 'sessionId' in l || 'ts' in l)).toBe(false)
  expect([...files.keys()]).toEqual(['/home/test/.claude/analytics/events/sess-1.jsonl'])
})

// The person typing into the box: `type` adds at the cursor, `paste` adds
// without a key, `back` and `wipe` backspace, `edit` is any splice. Keys are
// `{ key, ctrl?, meta? }` as the terminal reports them.
type Key = { key: string; ctrl?: true; meta?: true }
const composer = ($: Engine, initial = '') => {
  // the engine raises these two at runtime, but its typed `$` doesn't list them
  const prompt = $.prompt as unknown as {
    edit: (e: PromptEditInput) => Promise<PromptEditResult>
    change: (e: PromptChangeInput) => Promise<unknown>
  }
  let box = initial
  let cursor = initial.length
  const edit = async (start: number, end: number, inputText: string, key?: Key) => {
    const r = await prompt.edit({ origin: { kind: 'composer' }, key: key as never, text: box, cursor, start, end, inputText })
    box = r.text
    cursor = r.cursor
  }
  return {
    edit,
    type: (s: string) => edit(cursor, cursor, s, { key: s.slice(-1) }),
    paste: (s: string) => edit(cursor, cursor, s),
    back: () => edit(cursor - 1, cursor, '', { key: 'backspace' }),
    wipe: () => edit(0, box.length, '', { key: 'backspace' }),
    // a bare cursor move: an edit that changes nothing but where the caret is
    move: (to: number) => edit(to, to, '', { key: to < cursor ? 'left' : 'right' }),
    // the box emptied or replaced by the engine, as a clear, stash or undo does
    clear: async (kind: 'clear' | 'undo' = 'clear') => {
      box = ''
      cursor = 0
      await prompt.change({ text: '', cursor: 0, origin: { kind } })
    },
    recall: async (text: string) => {
      box = text
      cursor = text.length
      await prompt.change({ text, cursor, origin: { kind: 'history' } })
    },
    get text() {
      return box
    },
    get cursor() {
      return cursor
    },
  }
}

const submit = ($: Engine, text: string, kind: 'composer' | 'task-notification' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } as never })

test('a sent prompt carries how long it took to write, minus long pauses', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('h')
  tick(2_000)
  await box.type('i')
  tick(45_000) // went to make tea
  await box.type('!')
  tick(1_000)
  await submit($, box.text)

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ event: 'prompt', composeMs: 48_000, typingMs: 3_000, edits: 3, typedChars: 3, pastedChars: 0 })
})

test('a long keyless insert counts as a paste', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('look: ')
  tick(1_000)
  await box.paste('x'.repeat(40))
  await submit($, box.text)

  expect(lines[0]).toMatchObject({ typedChars: 6, pastedChars: 40 })
})

// how the sent text carries a paste the box folded into a placeholder
const folded = (id: string, text: string) => `\n\n<pasted_content id="${id}">\n\n${text}\n</pasted_content id="${id}">\n\n`

test('a folded-up paste counts as pasted, without its tags', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('look x')
  tick(1_000)
  await box.back()
  // the box holds a placeholder; the sent text has the paste in full
  await submit($, `look ${folded('3fca', 'lorem '.repeat(20).trim())}`)

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ typedChars: 6, deletedChars: 1, pastedChars: 119 })
})

test('every folded block counts, ids shared or not, on top of a keyless insert', async ($, on) => {
  const { lines } = setup(on)
  const box = composer($)

  await box.type('fix these')
  await box.paste('x'.repeat(40))
  await submit($, `fix these${'x'.repeat(40)}${folded('9326', 'a\nb')}AND${folded('9326', 'cdé')}${folded('77', '\n  ef')}`)

  expect(lines[0]).toMatchObject({ typedChars: 9, pastedChars: 40 + 3 + 3 + 4 })
})

test('a prompt that was only a paste carries just its pasted chars', async ($, on) => {
  const { lines, timelines } = setup(on)

  await submit($, folded('7974', 'at NodePgPreparedQuery'))

  expect(lines[0]).toMatchObject({ event: 'prompt', origin: 'composer', pastedChars: 22 })
  expect(lines[0]).not.toHaveProperty('typingMs')
  expect(timelines).toHaveLength(0)
})

test('a recalled prompt is not a paste', async ($, on) => {
  const { lines } = setup(on)
  const box = composer($)

  await box.type('a')
  await box.recall('an older prompt from history')
  await submit($, box.text)

  expect(lines[0]).toMatchObject({ typedChars: 1, pastedChars: 0 })
})

test('pasted images and files are counted by kind, never named', async ($, on) => {
  const { lines, raw } = setup(on)

  const attachments = [
    { type: 'image', mediaType: 'image/png', id: 'i1' },
    { type: 'image', mediaType: 'image/jpeg', id: 'i2' },
    { type: 'document', mediaType: 'application/pdf', filename: 'secret-plans.pdf', id: 'd1' },
  ] as const
  await $.prompt.submit({ text: 'look [Image #1] [Image #2]', wait: false, attachments, origin: { kind: 'composer' } as never })
  await submit($, 'just words')

  expect(lines[0]).toMatchObject({ images: 2, documents: 1 })
  expect(lines[0]).not.toHaveProperty('audio')
  expect(JSON.stringify(raw)).not.toContain('secret-plans')
  expect(lines[1]).not.toHaveProperty('images')
})

test('tags in a prompt someone else sent are not counted', async ($, on) => {
  const { lines } = setup(on)

  await submit($, folded('1', 'quoted'), 'task-notification')

  expect(lines[0]).not.toHaveProperty('pastedChars')
})

test('a clear just before the submit still belongs to that prompt', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('hello')
  tick(3_000)
  const text = box.text
  await box.clear()
  tick(5)
  await submit($, text)

  expect(lines.map(l => l.event)).toEqual(['prompt'])
  expect(lines[0]).toMatchObject({ composeMs: 3_005, typedChars: 5 })
})

test('a cleared draft is logged as abandoned at the next submit', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('never mind')
  tick(4_000)
  await box.type('.')
  tick(1_000)
  await box.clear()
  expect(lines).toHaveLength(0)

  tick(60_000)
  await box.type('ok')
  // a new draft starting writes nothing; the submit does
  expect(lines).toHaveLength(0)
  await submit($, box.text)

  expect(lines.map(l => l.event)).toEqual(['draft_abandoned', 'prompt'])
  expect(lines[0]).toMatchObject({ how: 'clear', composeMs: 5_000, typingMs: 5_000, typedChars: 11, edits: 2 })
  // epoch ms; it began composeMs before
  expect(lines[0]!.endedAt).toBe(1_790_000_005_000)
  expect(lines[1]).toMatchObject({ typedChars: 2, composeMs: 0 })
  expect(JSON.stringify(lines)).not.toContain('never')
})

test('backspacing a draft away abandons it too', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('hmm')
  tick(2_000)
  await box.wipe()
  tick(10_000)
  await submit($, '/clear', 'composer')

  expect(lines.map(l => l.event)).toEqual(['draft_abandoned', 'prompt'])
  expect(lines[0]).toMatchObject({ how: 'deleted', typedChars: 3, deletedChars: 3 })
  expect(lines[1]!.composeMs).toBeUndefined()
})

test('a notification arriving mid-draft leaves the draft alone', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('still typing')
  tick(1_000)
  await submit($, 'task done', 'task-notification')
  tick(1_000)
  await box.type('!')
  await submit($, box.text)

  expect(lines.map(l => [l.event, l.origin, l.composeMs])).toEqual([
    ['prompt', 'task-notification', undefined],
    ['prompt', 'composer', 2_000],
  ])
})

test('a draft still in the box at exit is abandoned before the session ends', async ($, on) => {
  const { lines, tick } = setup(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const box = composer($)

  await box.type('brb')
  tick(1_000)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { command: 'claude --resume sess-1' } as never })

  expect(lines.map(l => l.event)).toEqual(['draft_abandoned', 'session_end'])
  expect(lines[0]).toMatchObject({ how: 'exit', composeMs: 1_000 })
})

test('typo fixes, rewrites and pauses', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('teh')
  await box.back()
  await box.back()
  await box.type('he') // a typo fix: 2 deleted, retyped
  tick(5_000) // thinking
  await box.type(' cat sat')
  for (let i = 0; i < 7; i++) await box.back() // " cat sat" down to " "
  tick(40_000) // a break
  await box.type('dog ran') // a rewrite of 7
  tick(3_000) // staring at it before Enter
  await box.back() // trimmed off the end, not retyped
  await submit($, box.text)

  expect(lines[0]).toMatchObject({
    fixes: 1,
    rewrites: 1,
    rewrittenChars: 7,
    pauses: 2,
    breaks: 1,
    longestPauseMs: 40_000,
  })
})

test('each draft gets a replay timeline in its session file, shapes only', async ($, on) => {
  const { lines, timelines, timelineFiles, tick } = setup(on)
  const box = composer($)

  await box.type('hi you')
  tick(500)
  await box.type('\n')
  tick(500)
  await box.back()
  await submit($, box.text)

  expect([...timelineFiles]).toEqual(['/home/test/.claude/analytics/drafts/sess-1.jsonl'])
  expect(timelines).toHaveLength(1)
  expect(timelines[0]).toMatchObject({
    draftId: lines[0]!.draftId,
    outcome: 'sent',
    v: 1,
    startedAt: 1_790_000_000_000,
    durationMs: 1_000,
    // all six letters in one edit, a newline 500ms (50 ticks) later, then a backspace
    steps: '0t+2a_3a,50n,50b',
  })
  // an empty box to start from, no truncation: left out
  expect(Object.keys(timelines[0]!)).not.toContain('initialShape')
  expect(Object.keys(timelines[0]!)).not.toContain('truncated')
  expect(JSON.stringify(timelines)).not.toContain('hi')
  expect(JSON.stringify(timelines)).not.toContain('you')
})

test('deletes are told apart by their span, the key only confirms', async ($, on) => {
  const { lines, timelines } = setup(on)
  const box = composer($, 'one two three\nfour five')
  // the cursor sits at the end of "five"

  await box.edit(19, 23, '', { key: 'w', ctrl: true }) // ctrl+w: "five"
  await box.edit(14, 19, '', { key: 'backspace' }) // ctrl+backspace sent as plain: "four " back to line start
  await box.move(4) // into "two"
  await box.edit(4, 5, '', { key: 'delete' }) // forward delete
  await box.edit(4, 7, '') // keyless, mid-line: a word
  await box.edit(0, 4, '', { key: 'u', ctrl: true }) // ctrl+u
  await box.edit(0, 0, 'x') // typed, keyless burst of one
  await box.edit(0, 1, 'yz') // over a selection
  await submit($, box.text)

  expect(timelines[0]!.steps).toBe('0w@19-4,0k@14-5,0m@4,0d,0w-3,0k@0-4,0a,0r@0-1+2a')
  expect(lines[0]).toMatchObject({ wordDeletes: 2, lineKills: 2 })
})

test('cursor moves go in the replay but leave the stats alone', async ($, on) => {
  const { lines, timelines, tick } = setup(on)
  const box = composer($)

  await box.type('abc')
  tick(5_000)
  await box.move(1)
  tick(40_000)
  await box.move(3)
  tick(1_000)
  await box.type('d')
  await submit($, box.text)

  expect(lines[0]).toMatchObject({ edits: 2, pauses: 0, breaks: 1, longestPauseMs: 46_000, typingMs: 0 })
  expect(timelines[0]!.steps).toBe('0t+3a,500m@1,4000m@3,100a')
})

test('a move alone never starts a draft', async ($, on) => {
  const { lines, timelines } = setup(on)
  const box = composer($, 'old text')

  await box.move(2)
  await submit($, box.text)

  expect(lines[0]!.draftId).toBeUndefined()
  expect(timelines).toHaveLength(0)
})

test('a draft starting on a full box records what was there, and a recall resets it', async ($, on) => {
  const { timelines } = setup(on)
  const box = composer($, 'ab cd')

  await box.back()
  await box.recall('xyz\nq')
  await box.type('!')
  await submit($, box.text)

  expect(timelines[0]).toMatchObject({ initialShape: '2a_2a', initialCursor: 5, steps: '0b,0c@5+3ana:history,0a' })
})

test('a huge draft stops its timeline and says so, the stats carry on', async ($, on) => {
  const { lines, timelines } = setup(on)
  const box = composer($)

  await box.type('hi')
  await box.paste('z'.repeat(60_000))
  await box.type('!')
  await submit($, box.text)

  expect(timelines[0]).toMatchObject({ truncated: true, steps: '0t+2a' })
  expect(lines[0]).toMatchObject({ edits: 3, pastedChars: 60_000, typedChars: 3 })
})

test('abandoned drafts write their timelines too, in the same batch', async ($, on) => {
  const { lines, timelines, tick } = setup(on)
  const box = composer($)

  await box.type('nope')
  await box.clear()
  tick(10_000)
  await box.type('yes')
  await submit($, box.text)

  expect(lines.map(l => l.event)).toEqual(['draft_abandoned', 'prompt'])
  expect(timelines.map(t => [t.outcome, t.draftId])).toEqual([
    ['abandoned', lines[0]!.draftId],
    ['sent', lines[1]!.draftId],
  ])
})

test('text already in the box when a draft starts is not counted as pasted', async ($, on) => {
  const { lines } = setup(on)
  // say the mod reloaded mid-draft: the box already holds "half a thought"
  const box = composer($, 'half a thought')

  await box.type(' done')
  await submit($, box.text)

  expect(lines[0]).toMatchObject({ chars: 19, typedChars: 5, pastedChars: 0 })
})

test('a compaction logs its trigger, sizes and how long it took', async ($, on) => {
  const { lines, tick } = setup(on)
  const summary = [{ role: 'user' as const, text: 'the summary', toolUses: [] }]
  on('session.compact', (_, e) =>
    e.trigger === 'plugin' ? { skip: 'off' } : (tick(42_000), { messages: summary, tokensBefore: 180_000, tokensAfter: 21_000 }),
  )

  await $.session.compact({ trigger: 'auto', messages: [...summary, ...summary] })
  await $.session.compact({ trigger: 'plugin', messages: summary })

  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({
    event: 'compact',
    trigger: 'auto',
    outcome: 'compacted',
    messages: 2,
    tokensBefore: 180_000,
    tokensAfter: 21_000,
    durationMs: 42_000,
  })
  expect(lines[1]).toMatchObject({ event: 'compact', trigger: 'plugin', outcome: 'skipped', durationMs: 0 })
})

test('a prompt sent while a turn runs is marked midTurn', async ($, on) => {
  const { lines } = setup(on)
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  const origin = { kind: 'composer' } as const

  await $.prompt.submit({ text: 'first', wait: false, origin })
  await $.turn.start({ text: 'first', turnId: 't1' })
  await $.prompt.submit({ text: 'oh and also', wait: false, origin })
  await $.turn.complete({ answer: '', durationMs: 900, turnId: 't1', reason: 'answer', isAborted: false })
  await $.prompt.submit({ text: 'next', wait: false, origin })

  expect(lines.filter(l => l.event === 'prompt').map(l => l.midTurn)).toEqual([undefined, true, undefined])
})

test('an interrupt records how much answer had shown and the tools cut off', async ($, on) => {
  const { lines } = setup(on)
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  const esc = { durationMs: 4000, turnId: 't1', reason: 'aborted', isAborted: true } as const
  // the Esc lands while Bash is still running
  on('tool.call', async () => {
    await $.turn.complete({ ...esc, answer: 'lemme check the ' })
    return { result: {} }
  })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 99' })
  await $.turn.start({ text: 'hi again', turnId: 't2' })
  await $.turn.complete({ ...esc, turnId: 't2', answer: 'só' })

  const cuts = lines.filter(l => l.event === 'interrupt')
  expect(cuts[0]).toMatchObject({ answerChars: 16, toolsRunning: ['Bash'] })
  expect(cuts[1]).toMatchObject({ answerChars: 2 })
  expect(cuts[1]!.toolsRunning).toBeUndefined()
  expect(JSON.stringify(lines)).not.toContain('lemme')
})

// Since Claude Code 2.1.307 the permission check runs when the mod's tool.call
// hook calls next, before any hook beneath it, and a test has nobody to answer
// an ask: it's refused there and the call ends at once. So a dialog's length
// is checked on dialogWaits itself (a real one was seen live on 2026-10-21,
// a 4.1 s dialog logged as a 4.1 s wait)
const clock = (asked: { tool: string; from: number; to: number }[], questionsMs = 0) => ({ turnId: 't1', startedMs: 0, questionsMs, asked })

test('a dialog is the time the engine left out of the turn', () => {
  // asked 2 s in, the call ended at 27 s, the turn at 30 s with 10 s counted
  expect(dialogWaits(clock([{ tool: 'Bash', from: 2_000, to: 27_000 }]), 30_000, 10_000)).toEqual([[28_000, 20_000, 'Bash']])
})

test('several dialogs share the left-out time by how long each call ran past its ask', () => {
  const asked = [
    { tool: 'Bash', from: 1_000, to: 11_000 },
    { tool: 'Edit', from: 20_000, to: 50_000 },
  ]
  expect(dialogWaits(clock(asked), 60_000, 40_000)).toEqual([
    [59_000, 5_000, 'Bash'],
    [40_000, 15_000, 'Edit'],
  ])
})

test('a question, a tiny gap or no ask at all is no dialog', () => {
  // the 40 s left out was a question being answered
  expect(dialogWaits(clock([{ tool: 'Bash', from: 0, to: 40_000 }], 40_000), 50_000, 10_000)).toBeUndefined()
  // under half a second left out is noise
  expect(dialogWaits(clock([{ tool: 'Bash', from: 0, to: 9_000 }]), 10_000, 9_700)).toBeUndefined()
  expect(dialogWaits(clock([]), 30_000, 10_000)).toBeUndefined()
})

test('an ask the test engine cannot answer is refused, and leaves no wait', async ($, on) => {
  const { lines, tick } = setup(on)
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', () => ({ decision: 'ask' }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  tick(2_000)
  await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'tu1' } as never)
  tick(3_000)
  await $.turn.complete({ answer: '', durationMs: 5_000, turnId: 't1', reason: 'answer', isAborted: false })

  // the engine answers it as a failed call, not a deny
  expect(lines.find(l => l.event === 'tool')).toMatchObject({ tool: 'Bash', outcome: 'error' })
  expect(lines.find(l => l.event === 'turn_end')!.waits).toBeUndefined()
})

test('a cwd below its repo root, or in a worktree, says which repo it is', async ($, on) => {
  const { lines, cd } = setup(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  const turn = { answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false } as const

  await $.turn.complete(turn)
  cd('/proj/packages/api')
  await $.turn.complete(turn)
  cd('/proj/.claude/worktrees/w1')
  await $.turn.complete(turn)
  cd('/nowhere')
  await $.turn.complete(turn)
  // a worktree of the cwd's own repo isn't another repo
  cd('/proj')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/.claude/worktrees/w1/a.ts', old_string: 'a', new_string: 'b' })

  expect(lines.filter(l => l.event === 'cwd_changed').map(l => [l.cwd, l.root])).toEqual([
    ['/proj/packages/api', '/proj'],
    ['/proj/.claude/worktrees/w1', '/proj'],
    ['/nowhere', undefined],
    ['/proj', undefined],
  ])
  expect(lines.find(l => l.event === 'tool')!.repo).toBeUndefined()
})

test('a repo cloned under another folder name goes by its origin', async ($, on) => {
  const { lines, cd } = setup(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Bash', command: 'cd /tmp/scratch/ts-clone && bun test' })
  cd('/tmp/scratch/ts-clone/server')
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false })

  const tool = lines.find(l => l.event === 'tool')!
  expect([tool.repo, tool.repoName]).toEqual(['/tmp/scratch/ts-clone', 'telescreen'])
  const moved = lines.find(l => l.event === 'cwd_changed')!
  expect([moved.root, moved.rootName]).toEqual(['/tmp/scratch/ts-clone', 'telescreen'])
  // the origin matching the folder adds nothing
  await $.tool.call({ tool: 'Bash', command: 'cd /proj && ls' })
  expect(lines.filter(l => l.event === 'tool')[1]!.repoName).toBeUndefined()
})

test('a call working in another repo logs that repo, never the command', async ($, on) => {
  const { lines, runs } = setup(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Bash', command: 'cd ../code/hub && make deploy' })
  await $.tool.call({ tool: 'Edit', file_path: '/code/hub/src/a.ts', old_string: 'a', new_string: 'b' })
  // inside the cwd, in no repo at all, or a Bash with no cd: no repo
  await $.tool.call({ tool: 'Bash', command: 'cd src && ls' })
  await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' })
  await $.tool.call({ tool: 'Bash', command: 'make' })

  const tools = lines.filter(l => l.event === 'tool')
  expect(tools.map(l => l.repo)).toEqual(['/code/hub', '/code/hub', undefined, undefined, undefined])
  expect(JSON.stringify(lines)).not.toContain('deploy')
  // the Bash window looks in the repo it cd'd into too
  expect(runs.filter(r => r[0] === 'find').map(r => r[1])).toContain('/code/hub')
})

test('a working dir in no repo is only looked at two folders deep', async ($, on) => {
  const { runs, cd } = setup(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Bash', command: 'make' })
  cd('/home/test/Documents')
  await $.tool.call({ tool: 'Bash', command: 'make' })

  const finds = runs.filter(r => r[0] === 'find')
  expect(finds.map(r => r.slice(1, 4))).toEqual([
    ['/proj', '(', '-name'],
    ['/home/test/Documents', '-maxdepth', '2'],
  ])
})

test("an MCP tool's file_path argument is never logged", async ($, on) => {
  const { lines } = setup(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__drive__upload', file_path: '/home/me/secret-plans.pdf' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/elsewhere/a.txt' })

  expect(JSON.stringify(lines)).not.toContain('secret-plans')
  // outside the cwd, a path stays absolute
  expect(lines.find(l => l.event === 'tool' && l.tool === 'Read')).toMatchObject({ file: '/elsewhere/a.txt' })
})

test('after a reload the start is read back from the header, and the cwd is written again', async ($, on) => {
  const { lines, headers, files } = setup(on)
  on('turn.complete', () => ({ text: '' }))
  const start = 1_790_000_000_000 - 60_000
  files.set(
    '/home/test/.claude/analytics/events/sess-1.jsonl',
    `${JSON.stringify({ v: 1, event: 'session', start, cwd: '/proj' })}\n{"t":5,"event":"turn_end"}\n`,
  )

  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false })

  expect(headers).toEqual([])
  expect(lines.map(l => [l.event, l.t, l.cwd])).toEqual([
    ['cwd_changed', 60_000, '/proj'],
    ['turn_end', 60_000, undefined],
  ])
})

test('rows leave out fields at their usual value', async ($, on) => {
  const { raw } = setup(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Write', file_path: '/proj/a.txt', content: 'x' })
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false })

  expect(raw.map(r => Object.keys(r).sort())).toEqual([
    ['durationMs', 'event', 'file', 't', 'tool'],
    ['event', 'path', 't', 'tool'],
    ['durationMs', 'event', 't', 'turnId'],
  ])
})

test('the config file keeps excluded paths out, and limits to included ones', async ($, on) => {
  const { lines, files, setFind } = setup(on)
  on('tool.call', () => ({ result: {} }))
  const config = (rules: unknown) => files.set('/home/test/.claude/analytics/config.json', JSON.stringify({ files: rules }))
  const logged = () => lines.filter(l => l.event === 'file_changed').map(l => l.path)

  config({ exclude: ['fixtures', '*.log', 'src/gen/**', '~/secret'] })
  setFind('/proj/fixtures/a.json\n/proj/app.log\n/proj/src/gen/x.ts\n/proj/src/main.ts\n/proj/notes/fixtures.md\n')
  await $.tool.call({ tool: 'Bash', command: 'make' })
  await $.tool.call({ tool: 'Write', file_path: '/home/test/secret/plan.md', content: 'x' })
  // a folder name matches the folder, never a file that only starts the same
  expect(logged()).toEqual(['src/main.ts', 'notes/fixtures.md'])
  expect(lines.find(l => l.event === 'tool' && l.tool === 'Write')!.file).toBeUndefined()

  lines.length = 0
  config({ include: ['src/**/*.ts'], exclude: ['src/gen'] })
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(logged()).toEqual(['src/main.ts'])

  // a broken config logs everything rather than nothing
  lines.length = 0
  files.set('/home/test/.claude/analytics/config.json', '{nope')
  await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(logged()).toHaveLength(5)
})

test('a session ending gzips its files behind the last row', async ($, on) => {
  const { lines, runs } = setup(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { command: 'claude --resume sess-1' } as never })

  expect(lines.map(l => l.event)).toEqual(['session_end'])
  const pack = runs.find(argv => argv[0] === 'sh')!
  expect(pack.slice(4)).toEqual(['/home/test/.claude/analytics/events/sess-1.jsonl', '/home/test/.claude/analytics/drafts/sess-1.jsonl'])
  // after every tee, never before
  expect(runs.findIndex(argv => argv[0] === 'sh')).toBeGreaterThan(runs.findLastIndex(argv => argv[0] === 'tee'))
})

// A hub that follows the real one's rules (src/lib/server/ingest.ts in
// claude-hours): each run holds a contiguous prefix of its rows, a send that
// starts past it is a gap, and a new events run needs its header
const hub = (on: On, { down = false } = {}) => {
  const stored = new Map<string, unknown[]>()
  const requests: { url: string; path: string; method: string; headers: Record<string, string>; body?: any }[] = []
  // release: the mod it hands out, by /v1/hello and /install/mod/<file>
  // gone: files it lists there but answers 404 for
  const state = {
    token: 'tok',
    pending: 0,
    denied: false,
    release: undefined as { version: string; files: string[] } | undefined,
    gone: [] as string[],
  }
  // the upload's 10 s timeout never fires; the login's poll waits no time
  on('clock.sleep', (_, e) => (e.ms === 10_000 ? new Promise(() => {}) : { value: undefined }))
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    const headers = e.init?.headers ?? {}
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    requests.push({ url: url.href, path: url.pathname, method: e.init?.method ?? 'GET', headers, body })
    const reply = (status: number, value: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } })
    if (down) return { value: { status: 503, ok: false, headers: {}, text: 'down' } }
    // SvelteKit's origin check: anything but GET that could be a form needs a JSON type
    if (e.init?.method && e.init.method !== 'GET' && headers['content-type'] !== 'application/json') return reply(403, { message: 'cross-site form' })
    if (url.pathname === '/v1/hello') return reply(200, { protocols: [1], ...(state.release && { mod: state.release }) })
    if (url.pathname.startsWith('/install/mod/')) {
      const file = url.pathname.slice('/install/mod/'.length)
      if (!state.release?.files.includes(file) || state.gone.includes(file)) return reply(404, { message: 'Not a file the installer needs' })
      const text = file.endsWith('release.json') ? JSON.stringify({ version: state.release.version }) : `${file} at ${state.release.version}`
      return { value: { status: 200, ok: true, headers: {}, text } }
    }
    if (url.pathname === '/v1/device/code')
      return reply(200, {
        device_code: 'dc',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://elsewhere.test/device',
        expires_in: 600,
        interval: 5,
      })
    if (url.pathname === '/v1/device/token') {
      if (state.pending-- > 0) return reply(400, { error: 'authorization_pending' })
      return state.denied ? reply(400, { error: 'access_denied' }) : reply(200, { access_token: (state.token = 'hct_new'), token_type: 'Bearer' })
    }
    if (headers.authorization !== `Bearer ${state.token}`) return reply(401, { error: 'invalid_token' })
    if (url.pathname === '/v1/me') return reply(200, e.init?.method === 'DELETE' ? {} : { name: 'Miggy', email: 'miggy@example.com' })
    if (url.pathname === '/v1/stats')
      return reply(200, {
        today: { ms: 134 * 60_000, sessions: 3 },
        week: {
          ms: 662 * 60_000,
          projects: [
            { project: 'claude-hours', ms: 370 * 60_000 },
            { project: 'terra', ms: 9 * 60_000 },
          ],
        },
        allTime: { ms: 5200 * 60_000 },
        dashboard: url.origin,
      })
    const runs: Record<string, { status: string; acked: number }> = {}
    for (const r of body.runs) {
      const key = `${r.session}/${r.stream}/${r.run}`
      let held = stored.get(key)
      if (!held) {
        if (r.stream === 'events' && (r.header?.event !== 'session' || r.header.start !== r.run)) {
          runs[key] = { status: 'invalid', acked: 0 }
          continue
        }
        stored.set(key, (held = []))
      }
      if (r.from > held.length) runs[key] = { status: 'gap', acked: held.length }
      else {
        held.push(...r.rows.slice(held.length - r.from))
        runs[key] = { status: 'ok', acked: held.length }
      }
    }
    return reply(200, { runs, quarantined: 0 })
  })
  const posts = () => requests.filter(r => r.path === '/v1/events')
  return { stored, requests, posts, state }
}

// a file's runs the way the hub keys them: by the header's start, rows in order
const runsIn = (text: string) => {
  const out = new Map<number, unknown[]>()
  let run: number | undefined
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line)
    if (row.event === 'session') out.set((run = row.start), [])
    else if (run !== undefined) out.get(run)!.push(row)
  }
  return out
}

// uploads run behind the hook, so give them a moment (the test runner has
// timers; the mod's own types don't list them)
declare const setTimeout: (run: () => void, ms: number) => unknown
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(r => setTimeout(() => r(), 5))
}

const DIR = '/home/test/.claude/analytics'
const CONFIG = `${DIR}/config.json`
const SERVER = { server: { url: 'https://hub.test/', token: 'tok' } }
const EVENTS = `${DIR}/events/sess-1.jsonl`
const DRAFTS = `${DIR}/drafts/sess-1.jsonl`
const SENT = `${DIR}/sent/sess-1.json`

const endTurn = ($: { turn: { complete: (e: never) => Promise<unknown> } }) =>
  $.turn.complete({ answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false } as never)

const logged = (on: On) => {
  const logs: string[] = []
  const toasts: string[] = []
  on('ui.log', (_, e) => {
    logs.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  return { logs, toasts }
}

test('with no server in the config nothing is sent', async ($, on) => {
  setup(on)
  const { requests } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  await endTurn($)
  await settle()
  expect(requests).toEqual([])
})

test('a turn sends each run past what the hub holds, and remembers how far it got', async ($, on) => {
  const { files } = setup(on)
  const { stored, posts } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))

  await endTurn($)
  await settle()
  const [first] = posts()
  expect(first!.headers).toMatchObject({ authorization: 'Bearer tok', 'x-protocol': '1', 'content-type': 'application/json' })
  expect(first!.headers['user-agent']).toStartWith('time-track/')
  const [start, rows] = [...runsIn(files.get(EVENTS)!)][0]!
  expect(first!.body.runs).toEqual([
    { session: 'sess-1', stream: 'events', run: start, header: expect.objectContaining({ event: 'session', start }), from: 0, rows },
  ])
  expect(stored.get(`sess-1/events/${start}`)).toEqual(rows)
  expect(JSON.parse(files.get(SENT)!)).toMatchObject({
    v: 2,
    url: 'https://hub.test',
    events: { lines: files.get(EVENTS)!.split('\n').length - 1, run: start, acked: rows!.length },
  })

  // the next turn sends only the new rows, numbered on from there
  await endTurn($)
  await settle()
  const last = posts().at(-1)!.body.runs[0]
  expect(last.from).toBe(rows!.length)
  expect(stored.get(`sess-1/events/${start}`)).toEqual(runsIn(files.get(EVENTS)!).get(start))
})

test('a resume starts a new run, and rows before any header belong to none', async ($, on) => {
  const { files } = setup(on)
  const { stored } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  files.set(
    EVENTS,
    [
      '{"t":1,"event":"orphan"}',
      '{"v":1,"event":"session","start":100,"cwd":"/p"}',
      '{"t":1,"event":"prompt"}',
      '{"v":1,"event":"session","start":200,"cwd":"/p"}',
      '{"t":2,"event":"prompt"}',
      '',
    ].join('\n'),
  )

  await endTurn($)
  await settle()
  expect(stored.get('sess-1/events/100')).toEqual([{ t: 1, event: 'prompt' }])
  expect(stored.get('sess-1/events/200')![0]).toEqual({ t: 2, event: 'prompt' })
  expect([...stored.keys()].filter(k => k.includes('/events/'))).toEqual(['sess-1/events/100', 'sess-1/events/200'])
})

test('draft timelines go as run 0, a row per line', async ($, on) => {
  const { files } = setup(on)
  const { stored } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  files.set(DRAFTS, '{"v":1,"draftId":"a","outcome":"sent"}\n{"v":1,"draftId":"b","outcome":"sent"}\n')
  await endTurn($)
  await settle()
  expect(stored.get('sess-1/drafts/0')).toEqual([
    { v: 1, draftId: 'a', outcome: 'sent' },
    { v: 1, draftId: 'b', outcome: 'sent' },
  ])
})

test('a hub that lost rows answers with a gap, and the mod starts that stream over', async ($, on) => {
  const { files } = setup(on)
  const { stored, posts } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  await endTurn($)
  await settle()
  stored.clear()
  const before = posts().length
  await endTurn($)
  await settle()
  expect(
    posts()
      .slice(before)
      .map(p => p.body.runs[0].from),
  ).toEqual([JSON.parse(files.get(SENT)!).events.acked - 1, 0])
  const [start, rows] = [...runsIn(files.get(EVENTS)!)][0]!
  expect(stored.get(`sess-1/events/${start}`)).toEqual(rows)
})

test('only whole lines go up', async ($, on) => {
  const { files } = setup(on)
  const { stored } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  // a timeline half written when the upload reads
  files.set(DRAFTS, '{"v":1,"draftId":"a"}\n{"v":1,"draf')
  await endTurn($)
  await settle()
  expect(stored.get('sess-1/drafts/0')).toEqual([{ v: 1, draftId: 'a' }])
  expect(JSON.parse(files.get(SENT)!).drafts).toEqual({ lines: 1, acked: 1 })
  // once it's whole it goes too, numbered after the first
  files.set(DRAFTS, '{"v":1,"draftId":"a"}\n{"v":1,"draftId":"b"}\n')
  await endTurn($)
  await settle()
  expect(stored.get('sess-1/drafts/0')).toEqual([
    { v: 1, draftId: 'a' },
    { v: 1, draftId: 'b' },
  ])
})

test('a long stream goes up a request at a time', async ($, on) => {
  const { files } = setup(on)
  const { stored, posts } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  const rows = Array.from({ length: 9_000 }, (_, i) => `{"t":${i},"event":"tool","tool":"Read"}`)
  files.set(`${EVENTS}.gz`, `${['{"v":1,"event":"session","start":5,"cwd":"/p"}', ...rows].join('\n')}\n`)
  await endTurn($)
  await settle()
  expect(posts().length).toBeGreaterThan(2)
  expect(posts().every(p => p.body.runs.reduce((n: number, r: { rows: unknown[] }) => n + r.rows.length, 0) <= 5_000)).toBe(true)
  expect(stored.get('sess-1/events/5')!.slice(0, 9_000)).toEqual(rows.map(r => JSON.parse(r)))
})

test('a hub that is down is mentioned once, not every turn', async ($, on) => {
  const { logs } = logged(on)
  const { files } = setup(on)
  hub(on, { down: true })
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  await endTurn($)
  await endTurn($)
  await settle()
  expect(logs.filter(l => l.includes('upload paused'))).toHaveLength(1)
})

test('a revoked token says to log in again, once', async ($, on) => {
  const { logs } = logged(on)
  const { files } = setup(on)
  const { state } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  state.token = 'someone-else'
  files.set(CONFIG, JSON.stringify(SERVER))
  await endTurn($)
  await endTurn($)
  await settle()
  expect(logs.filter(l => l.includes('/time-track login'))).toHaveLength(1)
})

test('the sweep sends finished sessions once, and skips ones already in', async ($, on) => {
  const { files, setSweep } = setup(on)
  const { stored, posts } = hub(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  files.set(CONFIG, JSON.stringify(SERVER))
  files.set(`${DIR}/events/old-1.jsonl.gz`, '{"v":1,"event":"session","start":1,"cwd":"/p"}\n{"t":0,"event":"prompt"}\n')
  files.set(`${DIR}/sent/done-1.json`, JSON.stringify({ v: 2, url: 'https://hub.test', events: { lines: 2, run: 1, acked: 1 }, gz: [40, 0] }))
  setSweep('old-1 70 0\ndone-1 40 0\n')

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await settle()
  expect(posts().map(p => p.body.runs[0].session)).toEqual(['old-1'])
  expect(stored.get('old-1/events/1')).toEqual([{ t: 0, event: 'prompt' }])
  expect(JSON.parse(files.get(`${DIR}/sent/old-1.json`)!)).toMatchObject({ v: 2, gz: [70, 0] })
})

test('a session sent to another hub, or by the old uploads, is sent again', async ($, on) => {
  const { files, setSweep } = setup(on)
  const { stored } = hub(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  files.set(CONFIG, JSON.stringify(SERVER))
  for (const id of ['other-1', 'bytes-1'])
    files.set(`${DIR}/events/${id}.jsonl.gz`, '{"v":1,"event":"session","start":1,"cwd":"/p"}\n{"t":0,"event":"prompt"}\n')
  files.set(`${DIR}/sent/other-1.json`, JSON.stringify({ v: 2, url: 'http://127.0.0.1:4749', events: { lines: 2, run: 1, acked: 1 }, gz: [70, 0] }))
  // the byte-offset uploads' manifest, all in by its reckoning
  files.set(`${DIR}/sent/bytes-1.json`, JSON.stringify({ url: 'https://hub.test', events: 70, gz: [70, 0] }))
  setSweep('other-1 70 0\nbytes-1 70 0\n')

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await settle()
  expect(stored.get('other-1/events/1')).toEqual([{ t: 0, event: 'prompt' }])
  expect(stored.get('bytes-1/events/1')).toEqual([{ t: 0, event: 'prompt' }])
  expect(JSON.parse(files.get(`${DIR}/sent/bytes-1.json`)!)).toMatchObject({ v: 2, url: 'https://hub.test', gz: [70, 0] })
})

const command = ($: Engine, args: string) => $.command.run({ command: 'time-track', args } as never)

test('login answers at once, and saves the token once the code is approved', async ($, on) => {
  const { files, runs } = setup(on)
  const { toasts } = logged(on)
  const { requests, posts, state } = hub(on)
  state.pending = 2
  files.set(CONFIG, JSON.stringify({ files: { exclude: ['**/.env'] } }))
  files.set(EVENTS, '{"v":1,"event":"session","start":7,"cwd":"/proj"}\n{"t":1,"event":"prompt","words":3}\n')

  const { text } = await command($, 'login https://hub.test/')
  expect(text).toContain('https://hub.test/device?code=ABCD-EFGH')
  expect(text).not.toContain('hct_')
  expect(requests.find(r => r.path === '/v1/device/code')!.body).toEqual({ device_name: 'miggys-laptop' })
  await settle()
  expect(requests.filter(r => r.path === '/v1/device/token')).toHaveLength(3)
  expect(JSON.parse(files.get(CONFIG)!)).toEqual({ files: { exclude: ['**/.env'] }, server: { url: 'https://hub.test', token: 'hct_new' } })
  expect(runs.find(argv => argv[2]?.includes('umask 077'))).toBeDefined()
  expect(toasts.at(-1)).toContain('logged in to https://hub.test as Miggy')
  // and this session's rows go up straight away, with the new token
  expect(posts()[0]!.headers.authorization).toBe('Bearer hct_new')
  expect(posts()[0]!.body.runs[0]).toMatchObject({ run: 7, from: 0, rows: [{ t: 1, event: 'prompt', words: 3 }] })
})

test('stats asks the hub in the time zone of this computer, and lays the numbers out', async ($, on) => {
  const { files } = setup(on)
  const { requests } = hub(on)
  expect((await command($, 'stats')).text).toContain('not logged in')

  files.set(CONFIG, JSON.stringify(SERVER))
  const { text } = await command($, 'stats')
  const asked = new URL(requests.at(-1)!.url)
  expect(asked.pathname).toBe('/v1/stats')
  expect(asked.searchParams.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(text).toBe(
    [
      '',
      'today        2h 14m (3 sessions)',
      'last 7 days  11h 02m',
      'all time     86h 40m',
      'top this week: claude-hours 6h 10m, terra 9m',
      `dashboard: ${asked.origin}`,
    ].join('\n'),
  )
})

test('a denied login says so and saves nothing', async ($, on) => {
  const { files } = setup(on)
  const { toasts } = logged(on)
  const { state } = hub(on)
  state.denied = true
  await command($, 'login https://hub.test')
  await settle()
  expect(toasts.at(-1)).toContain('denied')
  expect(files.has(CONFIG)).toBe(false)
})

test('login checks it found a hub that speaks its protocol', async ($, on) => {
  setup(on)
  hub(on, { down: true })
  expect((await command($, 'login https://not-a-hub.test')).text).toContain("doesn't answer like a claude-hours hub")
  expect((await command($, 'login')).text).toContain('which hub?')
})

test('status says who this computer is logged in as, logout forgets it here and on the hub', async ($, on) => {
  const { files } = setup(on)
  const { requests } = hub(on)
  expect((await command($, 'status')).text).toContain('not logged in')
  files.set(CONFIG, JSON.stringify({ ...SERVER, files: { include: ['src/**'] } }))
  expect((await command($, 'status')).text).toBe('logged in to https://hub.test as Miggy')
  expect((await command($, 'logout')).text).toBe('logged out of https://hub.test')
  expect(requests.at(-1)).toMatchObject({ path: '/v1/me', method: 'DELETE', headers: { authorization: 'Bearer tok' } })
  expect(JSON.parse(files.get(CONFIG)!)).toEqual({ files: { include: ['src/**'] } })
})

test('ignore leaves the repo out of the log, files in it too, until it is run again', async ($, on) => {
  const { lines, headers, files, cd } = setup(on)
  on('tool.call', () => ({ result: {} }))
  files.set(CONFIG, JSON.stringify({ files: { exclude: ['*.log'] } }))
  cd('/proj/src')

  expect((await command($, 'ignore')).text).toContain('ignoring /proj:')
  expect(JSON.parse(files.get(CONFIG)!)).toEqual({ files: { exclude: ['*.log'] }, ignore: ['/proj'] })
  await $.prompt.submit({ text: 'secret plans', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  expect(lines).toEqual([])
  expect(headers).toEqual([])

  // from another repo, a call into the ignored one keeps its row but not the file
  cd('/code/hub')
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.ts', content: 'x' })
  expect(lines.map(l => l.event)).toEqual(['tool'])
  expect(lines[0]).toMatchObject({ tool: 'Write' })
  expect(lines[0]!.file).toBeUndefined()
  expect(lines[0]!.repo).toBeUndefined()

  cd('/proj')
  expect((await command($, 'ignore')).text).toBe('logging /proj again')
  expect(JSON.parse(files.get(CONFIG)!)).toEqual({ files: { exclude: ['*.log'] } })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(lines.at(-1)).toMatchObject({ event: 'prompt', words: 1 })
})

test('status tells how uploads are going and what is ignored', async ($, on) => {
  const { files, setSweep, tick, cd } = setup(on)
  const { state } = hub(on)
  on('turn.complete', () => ({ text: '' }))
  files.set(CONFIG, JSON.stringify(SERVER))
  await endTurn($)
  await settle()
  tick(3 * 60_000)
  expect((await command($, 'status')).text).toBe(['', 'logged in to https://hub.test as Miggy', 'last synced 3m ago'].join('\n'))

  // a finished session not all in, and a token the hub stopped taking
  files.set(`${DIR}/events/old-1.jsonl.gz`, '{"v":1,"event":"session","start":1,"cwd":"/p"}\n')
  setSweep('old-1 50 0\n')
  state.token = 'someone-else'
  await endTurn($)
  await settle()
  tick(60_000)
  cd('/code/hub')
  await command($, 'ignore')
  const { text } = await command($, 'status')
  expect(text!.split('\n')).toEqual([
    '',
    "https://hub.test turned down this computer's token, run /time-track login",
    'last synced 4m ago',
    '1 finished session waiting to send',
    "last problem 1m ago: https://hub.test turned down this computer's token, run /time-track login",
    'ignoring /code/hub',
  ])
})

// the mod's folder, as a clone's update answer names it (the test engine
// has no $.plugin)
const pluginRoot = async ($: Engine) => /runs from (\S+), not/.exec(String((await command($, 'update')).text))![1]!

test('a downloaded mod hears about a newer one, and update swaps it in whole', async ($, on) => {
  const { files, writes } = setup(on)
  const { toasts } = logged(on)
  const { state, requests } = hub(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const root = await pluginRoot($)
  const RELEASE = `${root}/.claude-plugin/release.json`
  files.set(CONFIG, JSON.stringify(SERVER))
  files.set(RELEASE, JSON.stringify({ version: 'old' }))
  state.release = { version: 'new', files: ['.claude-plugin/release.json', 'hooks/register.ts', '.claude-plugin/plugin.json'] }

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await settle()
  expect(toasts).toContain('time-track has an update, run /time-track update')

  expect((await command($, 'update')).text).toBe('updated time-track. new sessions load it')
  expect(files.get(`${root}/hooks/register.ts`)).toBe('hooks/register.ts at new')
  expect(JSON.parse(files.get(RELEASE)!)).toEqual({ version: 'new' })
  // every file down before any is written, the release last
  expect(writes.filter(f => f.startsWith(`${root}/`))).toEqual([`${root}/hooks/register.ts`, `${root}/.claude-plugin/plugin.json`, RELEASE])
  expect(requests.filter(r => r.path.startsWith('/install/'))).toHaveLength(3)
  expect((await command($, 'update')).text).toBe('already up to date')
})

test('update leaves a clone alone, and changes nothing when the hub hands out something odd', async ($, on) => {
  const { files } = setup(on)
  const { state } = hub(on)
  const root = await pluginRoot($)
  const RELEASE = `${root}/.claude-plugin/release.json`
  files.set(CONFIG, JSON.stringify(SERVER))
  state.release = { version: 'new', files: ['hooks/register.ts'] }
  expect((await command($, 'update')).text).toBe(`this mod runs from ${root}, not from a hub's download: update it with git pull`)

  files.set(RELEASE, JSON.stringify({ version: 'old' }))
  state.release = { version: 'new', files: ['hooks/register.ts', '../../.bashrc'] }
  expect((await command($, 'update')).text).toContain('named a file outside the mod (../../.bashrc)')

  // a file it lists but won't hand out: nothing is written
  state.release = { version: 'new', files: ['hooks/register.ts', 'hooks/gone.ts'] }
  state.gone = ['hooks/gone.ts']
  expect((await command($, 'update')).text).toContain("couldn't download the update")
  expect(files.has(`${root}/hooks/register.ts`)).toBe(false)
  expect(JSON.parse(files.get(RELEASE)!)).toEqual({ version: 'old' })
})
