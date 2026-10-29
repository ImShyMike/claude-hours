// time-track' event log: one file per session, events/<sessionId>.jsonl.
// The first row is a header, {"v":1,"event":"session","start":<epoch ms>,
// "cwd":...}. Later rows carry `t`, ms since that start (or `at`, epoch ms,
// when the mod couldn't read the header back), and no cwd: a cwd_changed row
// moves it, and `file` / `path` under it are relative to it. The header and
// a cwd_changed carry `root` too when the cwd is below its repo's root (or in
// a worktree of it), the repo's own folder, and `rootName` when the repo's
// origin remote names it something other than its folder. A field at its
// usual value (DEFAULTS) is left out, and so is a typed draft's 0 counter.
// draft_abandoned says when it ended, as epoch ms; it began composeMs before.
// A run whose header says `backfill` was rebuilt from Claude Code's
// transcript by the mod's backfill.py, for a session from before the mod.
//
// decodeSession turns a file back into the flat events the dashboard works
// on; encodeSession goes the other way, for the demo fixtures and the tests.

import type { Event } from './aggregate'

// a mod loaded mid-session opens its log with the prompt that woke it, which
// a transcript stamped a moment before (backfill.py's OVERLAP_MS)
const BACKFILL_OVERLAP_MS = 2_000

export const FORMAT = 1

const PATH_FIELDS = ['file', 'path'] as const

// kept in step with the mod's own copy
export const DEFAULTS: Record<string, Record<string, unknown>> = {
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

const absolute = (path: unknown, cwd: string) => (typeof path === 'string' && path && !path.startsWith('/') ? `${cwd}/${path}` : path)

function rowsOf(text: string) {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
    } catch {}
  }
  return rows
}

export function decodeSession(text: string, sessionId: string): Event[] {
  const rows = rowsOf(text)
  // A session the mod logged too is cut where its log begins, wherever the
  // backfill was made: one made after the mod's own files were deleted
  // (uninstall --purge) has its whole run, and the hub the mod's
  const logged = rows.filter(row => row.event === 'session' && !row.backfill && typeof row.start === 'number').map(row => row.start as number)
  const cut = logged.length ? Math.min(...logged) - BACKFILL_OVERLAP_MS : Infinity
  const events: Event[] = []
  let start: number | undefined
  let cwd = ''
  let root: string | undefined
  let rootName: string | undefined
  let backfill = false
  for (const row of rows) {
    if (row.event === 'session') {
      // a file in some other format is skipped whole
      if (row.v !== FORMAT || typeof row.start !== 'number') return []
      start = row.start
      if (typeof row.cwd === 'string') cwd = row.cwd
      root = typeof row.root === 'string' ? row.root : undefined
      rootName = typeof row.rootName === 'string' ? row.rootName : undefined
      backfill = !!row.backfill
      continue
    }
    const at = typeof row.at === 'number' ? row.at : start !== undefined && typeof row.t === 'number' ? start + row.t : undefined
    if (at === undefined || typeof row.event !== 'string') continue
    if (backfill && at >= cut) continue
    if (typeof row.cwd === 'string') {
      cwd = row.cwd
      root = typeof row.root === 'string' ? row.root : undefined
      rootName = typeof row.rootName === 'string' ? row.rootName : undefined
    }
    const { t: _t, at: _at, ...rest } = row
    const zeros = typeof row.typingMs === 'number' ? Object.fromEntries(DRAFT_COUNTERS.map(key => [key, 0])) : {}
    const e: Event = { ...DEFAULTS[row.event], ...zeros, ...rest, ts: new Date(at).toISOString(), sessionId, cwd, event: row.event }
    if (row.event === 'draft_abandoned' && typeof row.endedAt === 'number') {
      e.endedAt = new Date(row.endedAt).toISOString()
      e.startedAt = new Date(row.endedAt - (Number(row.composeMs) || 0)).toISOString()
    }
    for (const key of PATH_FIELDS) if (key in e) e[key] = absolute(e[key], cwd)
    if (root) e.root = root
    if (rootName) e.rootName = rootName
    if (backfill) e.backfill = true
    events.push(e)
  }
  return events
}

const relative = (path: unknown, cwd: string) => (typeof path === 'string' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

// One session's events, in time order, as the mod would have written them
// (or backfill.py, when they say backfill)
export function encodeSession(events: Event[]): string {
  if (!events.length) return ''
  const start = Date.parse(events[0]!.ts)
  let cwd = events[0]!.cwd
  const rooted = (e: Event) => ({
    ...(typeof e.root === 'string' ? { root: e.root } : {}),
    ...(typeof e.rootName === 'string' ? { rootName: e.rootName } : {}),
  })
  const rows: Record<string, unknown>[] = [
    { v: FORMAT, event: 'session', start, cwd, ...rooted(events[0]!), ...(events[0]!.backfill ? { backfill: 2 } : {}) },
  ]
  for (const e of events) {
    const t = Date.parse(e.ts) - start
    if (e.cwd !== cwd) {
      cwd = e.cwd
      rows.push({ t, event: 'cwd_changed', cwd, ...rooted(e) })
    }
    const { ts: _ts, sessionId: _s, cwd: _c, root: _r, rootName: _rn, project: _p, workProject: _w, backfill: _b, event, ...rest } = e
    if (event === 'cwd_changed') continue
    const row: Record<string, unknown> = { t, event }
    const usual = DEFAULTS[event] ?? {}
    const draft = typeof rest.typingMs === 'number'
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || usual[key] === value) continue
      if (draft && value === 0 && DRAFT_COUNTERS.includes(key)) continue
      row[key] = value
    }
    if (event === 'draft_abandoned' && typeof row.endedAt === 'string') {
      row.endedAt = Date.parse(row.endedAt)
      delete row.startedAt
    }
    for (const key of PATH_FIELDS) if (key in row) row[key] = relative(row[key], cwd)
    rows.push(row)
  }
  return rows.map(row => `${JSON.stringify(row)}\n`).join('')
}
