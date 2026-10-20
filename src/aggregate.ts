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

export type Interval = [start: number, end: number]

export type Summary = {
  totalMs: number
  // projects: the day's ms split by project. A stretch two projects share is
  // split evenly between them, so a day's projects add up to its ms
  days: { day: string; ms: number; prompts: number; projects: Record<string, number> }[]
  // active ms per local hour of day (0-23), summed over the window, and the
  // same split by project the way days are
  hours: number[]
  hourProjects: Record<string, number>[]
  projects: { project: string; ms: number }[]
  languages: { language: string; edits: number }[]
  tools: { tool: string; calls: number; errors: number; denied: number; avgMs: number }[]
  // midTurn: sent while Claude was still working
  prompts: { count: number; avgWords: number; avgChars: number; typed: number; midTurn: number }
  // time spent typing prompts (from hook-analytics' prompt.edit tracking)
  writing: {
    typingMs: number
    sent: number
    abandoned: number
    abandonedMs: number
    typedChars: number
    pastedChars: number
    // drafts carrying the fields below (older lines don't), for averages
    measured: number
    fixes: number
    rewrites: number
    rewrittenChars: number
    pauses: number
    breaks: number
    longestPauseMs: number
  }
  turns: number
  interrupts: number
  // interrupts that stopped a tool call, not just text
  interruptsMidTool: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  // projects: each one's time in the session, counted in full like `projects`
  sessions: {
    sessionId: string
    project: string
    start: number
    end: number
    activeMs: number
    prompts: number
    projects: { project: string; ms: number }[]
  }[]
  // every active stretch in the window, by session and project
  spans: { sessionId: string; project: string; from: number; to: number }[]
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

// prompt origins that are a person: Enter at the terminal (typed or queued),
// Remote Control, or `claude -p`. Notifications, peers and schedules are
// still activity, but they aren't prompts anyone wrote
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

// a draft_abandoned line is written late, so it carries its own end
const time = (e: Event) => Date.parse(typeof e.endedAt === 'string' ? e.endedAt : e.ts)
const projectOf = (e: Event) => e.project ?? (e.cwd.split('/').filter(Boolean).pop() || '/')
// subagent turns overlap the main thread's, so only main-thread turns make spans
const isMainTurn = (e: Event) => (e.event === 'turn_end' || e.event === 'interrupt') && !e.agentId
const isAgentTurn = (e: Event) => (e.event === 'turn_end' || e.event === 'interrupt') && !!e.agentId

// How long before its own line an event's activity began: a main-thread
// turn's whole run, or the typing that went into a prompt (sent or not).
// Typing uses typingMs, not composeMs, so a tea break mid-draft isn't counted.
// A main-thread compaction is time spent waiting too; a precompute runs ahead
// in the background, so it isn't
const isWaitedCompact = (e: Event) => e.event === 'compact' && !e.agentId && e.trigger !== 'precompute'

function leadMs(e: Event) {
  if (isMainTurn(e) || isWaitedCompact(e)) return Number(e.durationMs) || 0
  if (e.event === 'prompt' || e.event === 'draft_abandoned') return Number(e.typingMs) || 0
  return 0
}

// Waiting on the person isn't Claude working, and the engine already leaves it
// out of a turn's durationMs: a main-thread question or plan to approve (its
// whole call), and a permission dialog (hook-analytics puts those on the turn
// row as `waits`: [ms before the turn's end it opened, ms open, tool]). So a
// turn with one in it began earlier than end - durationMs, and the wait is a
// gap like any other: the idle cap decides it
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const isQuestion = (e: Event) => e.event === 'tool' && !e.agentId && QUESTION_TOOLS.has(String(e.tool))

export type Wait = { from: number; to: number; tool: string; kind: 'question' | 'permission' }

export function waitsOf(events: Event[]): Wait[] {
  const waits: Wait[] = []
  for (const e of events) {
    if (isQuestion(e)) waits.push({ from: time(e) - (Number(e.durationMs) || 0), to: time(e), tool: String(e.tool), kind: 'question' })
    if (!isMainTurn(e) || !Array.isArray(e.waits)) continue
    for (const w of e.waits) {
      if (!Array.isArray(w) || typeof w[0] !== 'number' || typeof w[1] !== 'number') continue
      const from = time(e) - w[0]
      waits.push({ from, to: from + w[1], tool: String(w[2] ?? ''), kind: 'permission' })
    }
  }
  return waits
}

// The stretches a turn of workMs ending at `end` worked in: back from its end,
// stepping over the waits, until workMs is used up
export function turnPieces(end: number, workMs: number, waits: Wait[]): Interval[] {
  const pieces: Interval[] = []
  let at = end
  let left = workMs
  for (const { from, to } of [...waits].sort((a, b) => b.to - a.to)) {
    if (to > end || from >= at) continue
    if (to < at) {
      if (at - to >= left) break
      pieces.push([to, at])
      left -= at - to
    }
    at = from
  }
  if (left > 0 || !pieces.length) pieces.push([at - left, at])
  return pieces.reverse()
}

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
// long Bash call or a long think counts in full, around any wait on the person.
// Moments and spans closer than idleCapMs merge; anything further apart is
// idle and doesn't count.
export function activeIntervals(events: Event[], idleCapMs: number): Interval[] {
  return mergeWithin([...projectSpans(events, idleCapMs).values()].flat(), 0)
}

// Overlapping intervals join, and so do ones up to capMs apart, unless the
// gap between them is busy with something else (`busy`: another project's
// work isn't an idle gap in this one)
function mergeWithin(intervals: Interval[], capMs: number, busy: Interval[] = []): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const others = busy.length ? mergeWithin(busy, 0) : []
  // gaps come in time order, so one pointer walks the busy stretches
  let j = 0
  const quiet = (from: number, to: number) => {
    while (j < others.length && others[j]![1] <= from) j++
    return !(j < others.length && others[j]![0] < to)
  }
  const merged: Interval[] = []
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1]
    if (last && (start <= last[1] || (start - last[1] <= capMs && quiet(last[1], start)))) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

// Where each thread (the main one, or a subagent by agentId) is working: it
// starts in the cwd's project, and a tool call that says where it ran (the
// server's workProject: a file's repo, a Bash cd) moves it there from the
// call's start until another one moves it again
type Move = { at: number; away?: string }
const threadOf = (e: Event) => (typeof e.agentId === 'string' ? e.agentId : '')

function movesOf(events: Event[]) {
  const moves = new Map<string, Move[]>()
  for (const e of events) {
    if (typeof e.workProject !== 'string') continue
    const at = time(e) - (e.event === 'tool' ? Number(e.durationMs) || 0 : 0)
    const list = moves.get(threadOf(e)) ?? []
    list.push({ at, away: e.workProject === projectOf(e) ? undefined : e.workProject })
    moves.set(threadOf(e), list)
  }
  for (const list of moves.values()) list.sort((a, b) => a.at - b.at)
  return moves
}

// a span cut where its thread moved, each piece with its project
function placed([start, end]: Interval, moves: Move[] | undefined, home: string): [string, Interval][] {
  let away: string | undefined
  const cuts: Move[] = []
  for (const m of moves ?? []) {
    if (m.at <= start) away = m.away
    else if (m.at < end) cuts.push(m)
  }
  const pieces: [string, Interval][] = []
  let from = start
  for (const m of cuts) {
    pieces.push([away ?? home, [from, m.at]])
    from = m.at
    away = m.away
  }
  pieces.push([away ?? home, [from, end]])
  return pieces
}

// One session's active time by project. The main thread's spans count
// wherever it was working. A subagent's turn counts only where it worked
// away from the main thread's project: alongside it, the main turn already
// covers that time. So two projects can share a stretch (each gets it in
// full), and activeIntervals' total counts it once
export function projectSpans(events: Event[], idleCapMs: number): Map<string, Interval[]> {
  const waits = waitsOf(events)
  const moves = movesOf(events)
  const raw = new Map<string, Interval[]>()
  const add = (project: string, interval: Interval) => {
    const list = raw.get(project)
    if (list) list.push(interval)
    else raw.set(project, [interval])
  }
  for (const e of events) {
    const end = time(e)
    const home = projectOf(e)
    const thread = moves.get(threadOf(e))
    const spans: Interval[] = isMainTurn(e) ? turnPieces(end, leadMs(e), waits) : [[end - leadMs(e), end]]
    for (const span of spans) for (const [project, piece] of placed(span, thread, home)) add(project, piece)
    if (isAgentTurn(e)) {
      for (const [project, piece] of placed([end - (Number(e.durationMs) || 0), end], thread, home)) {
        if (project !== home) add(project, piece)
      }
    }
  }
  const elsewhere = (project: string) => [...raw].flatMap(([p, intervals]) => (p === project ? [] : intervals))
  return new Map([...raw].map(([project, intervals]) => [project, mergeWithin(intervals, idleCapMs, elsewhere(project))]))
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

// Cuts one session's project intervals where they overlap, each piece with the
// share it gets: a stretch k projects worked at once gives each of them 1/k
function* shares(byProject: [string, Interval[]][]): Generator<[string, Interval, number]> {
  const edges: [number, string, 1 | -1][] = []
  for (const [project, intervals] of byProject) {
    for (const [start, end] of intervals) edges.push([start, project, 1], [end, project, -1])
  }
  edges.sort((a, b) => a[0] - b[0])
  const open = new Map<string, number>()
  let prev = -Infinity
  for (const [at, project, step] of edges) {
    if (at > prev && open.size) for (const p of open.keys()) yield [p, [prev, at], 1 / open.size]
    prev = at
    const n = (open.get(project) ?? 0) + step
    if (n) open.set(project, n)
    else open.delete(project)
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
    first = Math.min(first, time(e) - leadMs(e))
    last = Math.max(last, time(e))
  }
  const lo = from ?? first
  const hi = to ?? last + 1
  const inWindow = (e: Event) => time(e) >= lo && time(e) < hi

  // time: per session, and within it per project, so a cd between repos
  // doesn't bridge them. A stretch two projects share counts in full for
  // each, and once for the total, days and hours
  const sessionsOf = new Map<string, Event[]>()
  for (const e of valid) {
    const list = sessionsOf.get(e.sessionId)
    if (list) list.push(e)
    else sessionsOf.set(e.sessionId, [e])
  }

  const dayMs = new Map<string, number>()
  const dayProjects = new Map<string, Record<string, number>>()
  const hours: number[] = Array(24).fill(0)
  const hourProjects: Record<string, number>[] = hours.map(() => ({}))
  const spans: Summary['spans'] = []
  const sessionProjects = new Map<string, Map<string, number>>()
  const projectMs = new Map<string, number>()
  const sessionMs = new Map<string, number>()
  let totalMs = 0
  const kept = (interval: Interval) => (valid.length ? clip(interval, lo, hi) : undefined)
  for (const [sessionId, events] of sessionsOf) {
    const byProject = projectSpans(events, idleCapMs)
    const inside: [string, Interval[]][] = []
    const mine = new Map<string, number>()
    for (const [project, intervals] of byProject) {
      const k = intervals.map(kept).filter((i): i is Interval => !!i)
      for (const [start, end] of k) {
        inc(projectMs, project, end - start)
        inc(mine, project, end - start)
        spans.push({ sessionId, project, from: start, to: end })
      }
      if (k.length) inside.push([project, k])
    }
    sessionProjects.set(sessionId, mine)
    for (const [project, interval, share] of shares(inside)) {
      for (const [day, ms] of byDay(interval)) {
        const split = dayProjects.get(day) ?? {}
        split[project] = (split[project] ?? 0) + ms * share
        dayProjects.set(day, split)
      }
      for (const [hour, ms] of byHour(interval)) hourProjects[hour]![project] = (hourProjects[hour]![project] ?? 0) + ms * share
    }
    for (const interval of mergeWithin([...byProject.values()].flat(), 0)) {
      const k = kept(interval)
      if (!k) continue
      for (const [day, ms] of byDay(k)) inc(dayMs, day, ms)
      for (const [hour, ms] of byHour(k)) hours[hour]! += ms
      totalMs += k[1] - k[0]
      inc(sessionMs, sessionId, k[1] - k[0])
    }
  }

  const windowed = valid.filter(inWindow)
  const dayPrompts = new Map<string, number>()
  const languages = new Map<string, number>()
  const tools = new Map<string, { calls: number; errors: number; denied: number; totalMs: number }>()
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const sessions = new Map<string, Summary['sessions'][number]>()
  let promptCount = 0, words = 0, chars = 0, typed = 0, midTurn = 0, turns = 0, interrupts = 0, interruptsMidTool = 0
  const writing: Summary['writing'] = {
    typingMs: 0, sent: 0, abandoned: 0, abandonedMs: 0, typedChars: 0, pastedChars: 0,
    measured: 0, fixes: 0, rewrites: 0, rewrittenChars: 0, pauses: 0, breaks: 0, longestPauseMs: 0,
  }
  const countTyping = (e: Event) => {
    writing.typingMs += Number(e.typingMs) || 0
    writing.typedChars += Number(e.typedChars) || 0
    writing.pastedChars += Number(e.pastedChars) || 0
    if (typeof e.fixes !== 'number') return
    writing.measured++
    writing.fixes += e.fixes
    writing.rewrites += Number(e.rewrites) || 0
    writing.rewrittenChars += Number(e.rewrittenChars) || 0
    writing.pauses += Number(e.pauses) || 0
    writing.breaks += Number(e.breaks) || 0
    writing.longestPauseMs = Math.max(writing.longestPauseMs, Number(e.longestPauseMs) || 0)
  }

  for (const e of windowed) {
    const at = time(e)
    const s = sessions.get(e.sessionId) ?? { sessionId: e.sessionId, project: projectOf(e), start: at, end: at, activeMs: 0, prompts: 0, projects: [] }
    s.start = Math.min(s.start, at)
    s.end = Math.max(s.end, at)
    sessions.set(e.sessionId, s)

    switch (e.event) {
      case 'prompt':
        if (e.isMeta || (typeof e.origin === 'string' && !HUMAN_ORIGINS.has(e.origin))) break
        promptCount++
        s.prompts++
        words += Number(e.words) || 0
        chars += Number(e.chars) || 0
        if (e.origin === 'composer') typed++
        if (e.midTurn) midTurn++
        inc(dayPrompts, dayKey(at))
        if (typeof e.typingMs === 'number') {
          writing.sent++
          countTyping(e)
        }
        break
      case 'draft_abandoned':
        writing.abandoned++
        writing.abandonedMs += Number(e.typingMs) || 0
        countTyping(e)
        break
      case 'turn_end':
      case 'interrupt': {
        // one Esc can abort a subagent's turn and the main one, so count the main
        if (!e.agentId) e.event === 'interrupt' ? interrupts++ : turns++
        if (!e.agentId && Array.isArray(e.toolsRunning) && e.toolsRunning.length) interruptsMidTool++
        const u = e.usage as Record<string, number> | undefined
        if (u) {
          tokens.input += u.input_tokens || 0
          tokens.output += u.output_tokens || 0
          tokens.cacheRead += u.cache_read_input_tokens || 0
          tokens.cacheWrite += u.cache_creation_input_tokens || 0
        }
        break
      }
      case 'tool': {
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
  const sorted = <K>(map: Map<K, number>) => [...map].sort((a, b) => b[1] - a[1])
  for (const s of sessions.values()) {
    s.activeMs = sessionMs.get(s.sessionId) ?? 0
    s.projects = sorted(sessionProjects.get(s.sessionId) ?? new Map()).map(([project, ms]) => ({ project, ms }))
  }
  return {
    totalMs,
    days: valid.length
      ? dayRange(lo, hi).map(day => ({ day, ms: dayMs.get(day) ?? 0, prompts: dayPrompts.get(day) ?? 0, projects: dayProjects.get(day) ?? {} }))
      : [],
    hours,
    hourProjects,
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
      midTurn,
    },
    writing,
    turns,
    interrupts,
    interruptsMidTool,
    tokens,
    sessions: [...sessions.values()].sort((a, b) => b.start - a.start),
    spans: spans.sort((a, b) => a.from - b.from),
  }
}
