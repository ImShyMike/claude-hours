import type { On, PromptChangeInput, PromptEditInput, PromptEditResult } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

// Nothing sits beneath the plugin: these hooks stand for the engine, and the
// `tee -a` runs are where the log lines land.
const setup = (on: On) => {
  const lines: Record<string, unknown>[] = []
  // each session file's header row, kept apart from the rows after it
  const headers: Record<string, unknown>[] = []
  // the per-session draft timelines, by file
  const timelines: Record<string, unknown>[] = []
  const timelineFiles = new Set<string>()
  // what each file holds, so fs.exists / fs.read answer like a disk would
  const files = new Map<string, string>()
  let findOutput = ''
  let cwd = '/proj'
  let now = 1_790_000_000_000
  on('clock.now', () => ({ value: now }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', () => ({ value: '/home/test' }))
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    if (cmd === 'tee') {
      const path = e.argv[2] ?? ''
      const stdin = e.init?.stdin ?? ''
      files.set(path, (files.get(path) ?? '') + stdin)
      const drafts = path.includes('/analytics/drafts/')
      if (drafts) timelineFiles.add(path)
      for (const text of stdin.split('\n').filter(Boolean)) {
        const row = JSON.parse(text)
        ;(drafts ? timelines : row.event === 'session' ? headers : lines).push(row)
      }
    }
    const stdout = cmd === 'find' ? findOutput : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the box as the editor would leave it, and the submit going through
  on('prompt.edit', (_, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return {
    lines,
    headers,
    files,
    timelines,
    timelineFiles,
    setFind: (out: string) => (findOutput = out),
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

test('text the edits never brought, like a folded-up paste, counts as pasted', async ($, on) => {
  const { lines, tick } = setup(on)
  const box = composer($)

  await box.type('look x')
  tick(1_000)
  await box.back()
  // the box holds a placeholder; the sent text has the paste in full
  await submit($, `look ${'lorem '.repeat(20)}`)

  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ chars: 125, typedChars: 6, deletedChars: 1, pastedChars: 120 })
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
  expect(lines[0]!.endedAt).toBe(new Date(1_790_000_005_000).toISOString())
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
    initialShape: '',
    initialCursor: 0,
    truncated: false,
    // all six letters in one edit, a newline 500ms later, then a backspace
    steps: '0t+2a_3a,500n,500b',
  })
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
  expect(timelines[0]!.steps).toBe('0t+3a,5000m@1,40000m@3,1000a')
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
  expect(lines[0]).toMatchObject({ event: 'compact', trigger: 'auto', outcome: 'compacted', messages: 2, tokensBefore: 180_000, tokensAfter: 21_000, durationMs: 42_000 })
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
  files.set('/home/test/.claude/analytics/events/sess-1.jsonl', `${JSON.stringify({ v: 1, event: 'session', start, cwd: '/proj' })}\n{"t":5,"event":"turn_end"}\n`)

  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't', reason: 'answer', isAborted: false })

  expect(headers).toEqual([])
  expect(lines.map(l => [l.event, l.t, l.cwd])).toEqual([
    ['cwd_changed', 60_000, '/proj'],
    ['turn_end', 60_000, undefined],
  ])
})
