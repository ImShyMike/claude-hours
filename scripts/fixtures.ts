// Writes fake but plausible hook-analytics events to fixtures/events.jsonl, so
// the dashboard has something to draw while the real log is still tiny.
// Deterministic: the same seed gives the same file (relative to today).
import { mkdirSync, writeFileSync } from 'node:fs'

const DAYS = 45
const PROJECTS = ['terra', 'vxm', 'hackathon-site', 'scrapbook', 'claude-hackatime']
const TOOLS = ['Read', 'Bash', 'Edit', 'Grep', 'Write', 'Glob', 'Agent']
const FILES = ['src/index.ts', 'src/app.tsx', 'README.md', 'main.py', 'style.css', 'schema.sql', 'Makefile', 'config.toml']

let seed = 42
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
const between = (lo: number, hi: number) => lo + rand() * (hi - lo)

const lines: string[] = []
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
      const typingMs = Math.round(words * 6 * between(180, 320))
      const pasted = rand() < 0.15 ? Math.floor(between(40, 2000)) : 0
      row('prompt', {
        words,
        chars: words * 6 + pasted,
        origin: composer ? 'composer' : 'task-notification',
        ...(composer && {
          composeMs: Math.round(typingMs * between(1, 2.5)),
          typingMs,
          edits: Math.floor(typingMs / 700),
          typedChars: words * 6,
          pastedChars: pasted,
          deletedChars: Math.floor(words * between(0, 2)),
          fixes: Math.floor(words * between(0, 0.3)),
          rewrites: Math.floor(between(0, 3)),
          rewrittenChars: Math.floor(between(0, 60)),
          pauses: Math.floor(between(0, 6)),
          breaks: rand() < 0.15 ? 1 : 0,
          longestPauseMs: Math.round(between(1, rand() < 0.15 ? 120 : 25) * 1000),
        }),
      })
      const turnStart = at
      const calls = Math.floor(between(0, 9))
      for (let c = 0; c < calls; c++) {
        at += between(2, 25) * 1000
        const tool = pick(TOOLS)
        const toolUseId = `t${lines.length}`
        row('tool_start', { tool, toolUseId })
        const durationMs = Math.round(tool === 'Bash' || tool === 'Agent' ? between(200, 90_000) : between(5, 400))
        at += durationMs
        const outcome = rand() < 0.06 ? 'error' : rand() < 0.03 ? 'denied' : 'ok'
        row('tool_end', { tool, toolUseId, outcome, durationMs })
        if (outcome === 'ok' && (tool === 'Edit' || tool === 'Write')) {
          row('file_changed', { tool, toolUseId, path: `${cwd}/${pick(FILES)}`, via: 'tool' })
        }
      }
      at += between(3, 40) * 1000
      const aborted = rand() < 0.07
      const output = Math.floor(between(200, 4000))
      row(aborted ? 'interrupt' : 'turn_end', {
        turnId: `turn-${lines.length}`,
        reason: aborted ? 'aborted' : 'answer',
        durationMs: at - turnStart,
        usage: { input_tokens: 20, output_tokens: output, cache_read_input_tokens: output * 30, cache_creation_input_tokens: output * 2, model: 'claude-opus-5-5' },
      })
      // reading, thinking, sometimes wandering off
      at += rand() < 0.15 ? between(20, 90) * 60_000 : between(20, 300) * 1000
    }
    row('session_end', { reason: 'prompt_input_exit' })
  }
}

mkdirSync('fixtures', { recursive: true })
writeFileSync('fixtures/events.jsonl', `${lines.join('\n')}\n`)
console.log(`wrote ${lines.length} fake events to fixtures/events.jsonl`)
