// Writes fake but plausible hook-analytics events to fixtures/events.jsonl, so
// the dashboard has something to draw while the real log is still tiny.
// Deterministic: the same seed gives the same file (relative to today).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Event } from '../src/aggregate'
import { encodeSession } from '../src/eventlog'
import { encodeSteps } from '../src/replay'

const DAYS = 45
const PROJECTS = ['terra', 'vxm', 'hackathon-site', 'scrapbook', 'claude-hours']
const TOOLS = ['Read', 'Bash', 'Edit', 'Grep', 'Write', 'Glob', 'Agent']
const FILES = ['src/index.ts', 'src/app.tsx', 'README.md', 'main.py', 'style.css', 'schema.sql', 'Makefile', 'config.toml']

let seed = 42
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
const between = (lo: number, hi: number) => lo + rand() * (hi - lo)

const lines: string[] = []
// draft timelines, one file per session like the real thing
const drafts: string[] = []

type Step = [number, string, number, number?, string?]

// Types out `words` words of shapes: letters at a human pace, the odd typo
// fixed with backspace, now and then a word deleted and redone, thinking
// pauses between sentences and sometimes a paste
function simulate(words: number) {
  const steps: Step[] = []
  let t = 0
  let len = 0
  let last = 0
  const stats = {
    typingMs: 0, edits: 0, typedChars: 0, pastedChars: 0, deletedChars: 0, fixes: 0, rewrites: 0,
    rewrittenChars: 0, pauses: 0, breaks: 0, longestPauseMs: 0, wordDeletes: 0, lineKills: 0,
  }
  const step = (gap: number, st: [string, number, number?, string?]) => {
    t += gap
    if (gap > 30_000) stats.breaks++
    else if (gap >= 2_000) stats.pauses++
    stats.longestPauseMs = Math.max(stats.longestPauseMs, t - last)
    if (t - last <= 30_000) stats.typingMs += t - last
    last = t
    stats.edits++
    steps.push([Math.round(t), ...st])
  }
  const typeWord = (n: number) => {
    for (let i = 0; i < n; i++) {
      step(between(70, 260), ['t', len, 0, 'a'])
      len++
      stats.typedChars++
    }
  }
  for (let w = 0; w < words; w++) {
    const n = Math.floor(between(2, 9))
    if (w && rand() < 0.12) step(between(2_000, 9_000), ['m', len]) // a think, then the cursor nudged
    typeWord(n)
    if (rand() < 0.1) {
      // a typo: two wrong letters, backspaced, retyped
      typeWord(2)
      for (let i = 0; i < 2; i++) {
        step(between(90, 200), ['b', len - 1, 1])
        len--
        stats.deletedChars++
      }
      stats.fixes++
      typeWord(2)
    }
    if (rand() < 0.05) {
      // rethink the whole word
      step(between(400, 1500), ['w', len - n, n])
      len -= n
      stats.deletedChars += n
      stats.wordDeletes++
      stats.rewrites++
      stats.rewrittenChars += n
      typeWord(n)
    }
    if (rand() < 0.02) {
      const size = Math.floor(between(40, 400))
      step(between(500, 3000), ['p', len, 0, ' ' + 'a'.repeat(size)])
      len += size + 1
      stats.pastedChars += size + 1
    }
    if (w < words - 1) {
      step(between(60, 200), ['t', len, 0, rand() < 0.04 ? '\n' : ' '])
      len++
      stats.typedChars++
    }
  }
  const durationMs = Math.round(t + between(300, 2500))
  return { steps, stats, durationMs }
}
const midnight = new Date()
midnight.setHours(0, 0, 0, 0)

for (let back = DAYS; back >= 0; back--) {
  const day = midnight.getTime() - back * 86_400_000
  // some days off, some busy days
  const sessions = rand() < 0.2 ? 0 : Math.floor(between(1, 4))
  for (let n = 0; n < sessions; n++) {
    const sessionId = `demo-${back}-${n}`
    const project = pick(PROJECTS)
    const cwd = `/home/demo/code/${project}`
    let at = day + between(9, 23) * 3_600_000
    const row = (event: string, extra: Record<string, unknown> = {}) =>
      lines.push(JSON.stringify({ ts: new Date(at).toISOString(), sessionId, cwd, event, ...extra }))

    row('session_start', { surface: 'terminal', isInteractive: true })
    const prompts = Math.floor(between(2, 14))
    for (let p = 0; p < prompts; p++) {
      const words = Math.floor(between(3, 80))
      // now and then a draft typed and thrown away first
      if (rand() < 0.12) {
        const typingMs = Math.round(between(5, 90) * 1000)
        const endedAt = at - between(30, 300) * 1000
        lines.push(JSON.stringify({
          ts: new Date(at).toISOString(), sessionId, cwd, event: 'draft_abandoned',
          startedAt: new Date(endedAt - typingMs * 1.4).toISOString(), endedAt: new Date(endedAt).toISOString(),
          composeMs: Math.round(typingMs * 1.4), typingMs, edits: Math.floor(typingMs / 900), typedChars: Math.floor(typingMs / 220),
          pastedChars: 0, deletedChars: 4, how: rand() < 0.6 ? 'clear' : 'deleted',
        }))
      }
      const composer = rand() < 0.9
      const typed = composer ? simulate(words) : undefined
      const draftId = `demo-${lines.length}`
      if (typed) {
        drafts.push(JSON.stringify({
          sessionId, v: 1, draftId, outcome: 'sent',
          startedAt: at - typed.durationMs, durationMs: typed.durationMs, steps: encodeSteps(typed.steps, 0),
        }))
      }
      row('prompt', {
        words,
        chars: words * 6,
        origin: composer ? 'composer' : 'task-notification',
        // a screenshot every few prompts, and once in a while a file (no
        // rand() here, so the rest of the demo stays as it was)
        images: composer && p % 5 === 2 ? 1 + (p % 2) : undefined,
        documents: composer && p % 11 === 7 ? 1 : undefined,
        ...(typed && { ...typed.stats, composeMs: typed.durationMs, draftId }),
      })
      const turnStart = at
      const calls = Math.floor(between(0, 9))
      for (let c = 0; c < calls; c++) {
        at += between(2, 25) * 1000
        const tool = pick(TOOLS)
        const durationMs = Math.round(tool === 'Bash' || tool === 'Agent' ? between(200, 90_000) : between(5, 400))
        at += durationMs
        const outcome = rand() < 0.06 ? 'error' : rand() < 0.03 ? 'denied' : 'ok'
        row('tool', { tool, outcome, durationMs })
        // sometimes a thought arrives while Claude is busy
        if (rand() < 0.05) row('prompt', { words: Math.floor(between(3, 30)), chars: 60, origin: 'composer', midTurn: true })
        if (outcome === 'ok' && (tool === 'Edit' || tool === 'Write')) {
          row('file_changed', { tool, path: `${cwd}/${pick(FILES)}`, via: 'tool' })
        }
      }
      // now and then the context fills up mid-turn
      if (rand() < 0.06) {
        const durationMs = Math.round(between(20, 90) * 1000)
        at += durationMs
        const tokensBefore = Math.round(between(150_000, 190_000))
        row('compact', { trigger: 'auto', messages: Math.floor(between(80, 400)), outcome: 'compacted', tokensBefore, tokensAfter: Math.round(tokensBefore * 0.12), durationMs })
      }
      at += between(3, 40) * 1000
      const aborted = rand() < 0.07
      const output = Math.floor(between(200, 4000))
      row(aborted ? 'interrupt' : 'turn_end', {
        turnId: `turn-${lines.length}`,
        reason: aborted ? 'aborted' : 'answer',
        durationMs: at - turnStart,
        ...(aborted && { answerChars: Math.floor(between(0, 900)), toolsRunning: rand() < 0.4 ? ['Bash'] : undefined }),
        usage: { input_tokens: 20, output_tokens: output, cache_read_input_tokens: output * 30, cache_creation_input_tokens: output * 2, model: 'claude-opus-5-5' },
      })
      // reading, thinking, sometimes wandering off
      at += rand() < 0.15 ? between(20, 90) * 60_000 : between(20, 300) * 1000
    }
    row('session_end', { reason: 'prompt_input_exit' })
  }
}

rmSync('fixtures', { recursive: true, force: true })
mkdirSync('fixtures/events', { recursive: true })
// one file per session, in the mod's own format
const events = new Map<string, Event[]>()
for (const line of lines) {
  const e = JSON.parse(line) as Event
  events.set(e.sessionId, [...(events.get(e.sessionId) ?? []), e])
}
for (const [id, list] of events) {
  list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  writeFileSync(`fixtures/events/${id}.jsonl`, encodeSession(list))
}
mkdirSync('fixtures/drafts', { recursive: true })
const bySession = new Map<string, string[]>()
for (const row of drafts) {
  const { sessionId, ...rest } = JSON.parse(row)
  bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), JSON.stringify(rest)])
}
for (const [id, rows] of bySession) writeFileSync(`fixtures/drafts/${id}.jsonl`, `${rows.join('\n')}\n`)
console.log(`wrote ${lines.length} fake events to fixtures/events/ (${events.size} sessions)`)
