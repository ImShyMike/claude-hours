// Turns the raw hook-analytics lines into dashboard numbers. Pure, and it runs
// in the browser so days are the viewer's local days, not UTC ones.

export type Event = {
  ts: string
  sessionId: string
  cwd: string
  event: string
  // added by the server: the git root's name, else the cwd's
  project?: string
  [field: string]: unknown
}

export type Options = {
  // window start/end in epoch ms; omit for everything
  from?: number
  to?: number
  // idle gaps up to this long between activity count as active time
  idleCapMs: number
}

type Interval = [start: number, end: number]

export type Summary = {
  totalMs: number
  days: { day: string; ms: number; prompts: number }[]
  // active ms per local hour of day (0-23), summed over the window
  hours: number[]
  projects: { project: string; ms: number }[]
  languages: { language: string; edits: number }[]
  tools: { tool: string; calls: number; errors: number; denied: number; avgMs: number }[]
  prompts: { count: number; avgWords: number; avgChars: number; typed: number }
  turns: number
  interrupts: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  sessions: { sessionId: string; project: string; start: number; end: number; activeMs: number; prompts: number }[]
}

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', lua: 'Lua', sh: 'Shell', bash: 'Shell', fish: 'Shell',
  zsh: 'Shell', html: 'HTML', css: 'CSS', scss: 'CSS', svelte: 'Svelte', vue: 'Vue', md: 'Markdown',
  mdx: 'Markdown', json: 'JSON', jsonl: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', sql: 'SQL',
  ipynb: 'Jupyter', gd: 'GDScript', zig: 'Zig', nix: 'Nix', txt: 'Text',
}

export function languageOf(path: string) {
  const name = path.split('/').pop() ?? ''
  if (name === 'Dockerfile') return 'Docker'
  if (name === 'Makefile') return 'Make'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'Other'
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? 'Other'
}

const time = (e: Event) => Date.parse(e.ts)
const projectOf = (e: Event) => e.project ?? (e.cwd.split('/').filter(Boolean).pop() || '/')
// subagent turns overlap the main thread's, so only main-thread turns make spans
const isMainTurn = (e: Event) => (e.event === 'turn_end' || e.event === 'interrupt') && !e.agentId

// YYYY-MM-DD in local time
export function dayKey(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nextMidnight(ms: number) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

function nextHour(ms: number) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()
}

// Each event is a moment of activity and each main-thread turn is a span, so a
// long Bash call or a long think counts in full. Moments and spans closer than
// idleCapMs merge; anything further apart is idle and doesn't count.
export function activeIntervals(events: Event[], idleCapMs: number): Interval[] {
  const raw: Interval[] = events.map(e => {
    const end = time(e)
    const span = isMainTurn(e) && typeof e.durationMs === 'number' ? e.durationMs : 0
    return [end - span, end]
  })
  raw.sort((a, b) => a[0] - b[0])
  const merged: Interval[] = []
  for (const [start, end] of raw) {
    const last = merged[merged.length - 1]
    if (last && start - last[1] <= idleCapMs) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

function clip([start, end]: Interval, from: number, to: number): Interval | undefined {
  const s = Math.max(start, from)
  const e = Math.min(end, to)
  return e > s ? [s, e] : undefined
}

// splits an interval at local midnights
function* byDay([start, end]: Interval): Generator<[string, number]> {
  let at = start
  while (at < end) {
    const cut = Math.min(end, nextMidnight(at))
    yield [dayKey(at), cut - at]
    at = cut
  }
}

function* byHour([start, end]: Interval): Generator<[number, number]> {
  let at = start
  while (at < end) {
    const cut = Math.min(end, nextHour(at))
    yield [new Date(at).getHours(), cut - at]
    at = cut
  }
}

function dayRange(from: number, to: number) {
  const days: string[] = []
  for (let at = from; at < to; at = nextMidnight(at)) days.push(dayKey(at))
  return days
}

const inc = <K>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by)

export function summarize(all: Event[], { from, to, idleCapMs }: Options): Summary {
  const valid = all.filter(e => e && typeof e.ts === 'string' && !Number.isNaN(time(e)) && e.sessionId)
  // a turn's span starts before its own line, so the default window does too.
  // A loop, not Math.min(...xs), which overflows the stack on a big log
  let first = Infinity, last = -Infinity
  for (const e of valid) {
    first = Math.min(first, time(e) - (isMainTurn(e) ? Number(e.durationMs) || 0 : 0))
    last = Math.max(last, time(e))
  }
  const lo = from ?? first
  const hi = to ?? last + 1
  const inWindow = (e: Event) => time(e) >= lo && time(e) < hi

  // time: per session and project, so a cd between repos doesn't bridge them
  const groups = new Map<string, Event[]>()
  for (const e of valid) {
    const key = `${e.sessionId}\u0000${projectOf(e)}`
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }

  const dayMs = new Map<string, number>()
  const hours: number[] = Array(24).fill(0)
  const projectMs = new Map<string, number>()
  const sessionMs = new Map<string, number>()
  let totalMs = 0
  for (const [key, events] of groups) {
    const [sessionId, project] = key.split('\u0000') as [string, string]
    for (const interval of activeIntervals(events, idleCapMs)) {
      const kept = valid.length ? clip(interval, lo, hi) : undefined
      if (!kept) continue
      for (const [day, ms] of byDay(kept)) inc(dayMs, day, ms)
      for (const [hour, ms] of byHour(kept)) hours[hour]! += ms
      const ms = kept[1] - kept[0]
      totalMs += ms
      inc(projectMs, project, ms)
      inc(sessionMs, sessionId, ms)
    }
  }

  const windowed = valid.filter(inWindow)
  const dayPrompts = new Map<string, number>()
  const languages = new Map<string, number>()
  const tools = new Map<string, { calls: number; errors: number; denied: number; totalMs: number }>()
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const sessions = new Map<string, Summary['sessions'][number]>()
  let promptCount = 0, words = 0, chars = 0, typed = 0, turns = 0, interrupts = 0

  for (const e of windowed) {
    const at = time(e)
    const s = sessions.get(e.sessionId) ?? { sessionId: e.sessionId, project: projectOf(e), start: at, end: at, activeMs: 0, prompts: 0 }
    s.start = Math.min(s.start, at)
    s.end = Math.max(s.end, at)
    sessions.set(e.sessionId, s)

    switch (e.event) {
      case 'prompt':
        promptCount++
        s.prompts++
        words += Number(e.words) || 0
        chars += Number(e.chars) || 0
        if (e.origin === 'composer') typed++
        inc(dayPrompts, dayKey(at))
        break
      case 'turn_end':
      case 'interrupt': {
        if (e.event === 'interrupt') interrupts++
        else if (!e.agentId) turns++
        const u = e.usage as Record<string, number> | undefined
        if (u) {
          tokens.input += u.input_tokens || 0
          tokens.output += u.output_tokens || 0
          tokens.cacheRead += u.cache_read_input_tokens || 0
          tokens.cacheWrite += u.cache_creation_input_tokens || 0
        }
        break
      }
      case 'tool_end': {
        const t = tools.get(String(e.tool)) ?? { calls: 0, errors: 0, denied: 0, totalMs: 0 }
        t.calls++
        if (e.outcome === 'error' || e.outcome === 'threw') t.errors++
        if (e.outcome === 'denied') t.denied++
        t.totalMs += Number(e.durationMs) || 0
        tools.set(String(e.tool), t)
        break
      }
      case 'file_changed':
        if (typeof e.path === 'string') inc(languages, languageOf(e.path))
        break
    }
  }
  for (const s of sessions.values()) s.activeMs = sessionMs.get(s.sessionId) ?? 0

  const sorted = <K>(map: Map<K, number>) => [...map].sort((a, b) => b[1] - a[1])
  return {
    totalMs,
    days: valid.length ? dayRange(lo, hi).map(day => ({ day, ms: dayMs.get(day) ?? 0, prompts: dayPrompts.get(day) ?? 0 })) : [],
    hours,
    projects: sorted(projectMs).map(([project, ms]) => ({ project, ms })),
    languages: sorted(languages).map(([language, edits]) => ({ language, edits })),
    tools: [...tools]
      .map(([tool, t]) => ({ tool, calls: t.calls, errors: t.errors, denied: t.denied, avgMs: t.totalMs / t.calls }))
      .sort((a, b) => b.calls - a.calls),
    prompts: {
      count: promptCount,
      avgWords: promptCount ? words / promptCount : 0,
      avgChars: promptCount ? chars / promptCount : 0,
      typed,
    },
    turns,
    interrupts,
    tokens,
    sessions: [...sessions.values()].sort((a, b) => b.start - a.start),
  }
}

// Parses JSONL defensively: concurrent sessions append to the same file, so a
// torn or half-written line is skipped instead of failing the whole read.
export function parseLines(text: string): Event[] {
  const events: Event[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && typeof row.ts === 'string') events.push(row)
    } catch {}
  }
  return events
}
