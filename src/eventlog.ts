// hook-analytics' event log: one file per session, events/<sessionId>.jsonl.
// The first row is a header, {"v":1,"event":"session","start":<epoch ms>,
// "cwd":...}. Later rows carry `t`, ms since that start (or `at`, epoch ms,
// when the mod couldn't read the header back), and no cwd: a cwd_changed row
// moves it, and `file` / `path` under it are relative to it.
//
// decodeSession turns a file back into the flat events the dashboard works
// on; encodeSession goes the other way, for the demo fixtures and the tests.

import type { Event } from './aggregate'

export const FORMAT = 1

const PATH_FIELDS = ['file', 'path'] as const

const absolute = (path: unknown, cwd: string) =>
  typeof path === 'string' && path && !path.startsWith('/') ? `${cwd}/${path}` : path

export function decodeSession(text: string, sessionId: string): Event[] {
  const events: Event[] = []
  let start: number | undefined
  let cwd = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    if (row.event === 'session') {
      // a file in some other format is skipped whole
      if (row.v !== FORMAT || typeof row.start !== 'number') return []
      start = row.start
      if (typeof row.cwd === 'string') cwd = row.cwd
      continue
    }
    const at = typeof row.at === 'number' ? row.at : start !== undefined && typeof row.t === 'number' ? start + row.t : undefined
    if (at === undefined || typeof row.event !== 'string') continue
    if (typeof row.cwd === 'string') cwd = row.cwd
    const { t: _t, at: _at, ...rest } = row
    const e: Event = { ...rest, ts: new Date(at).toISOString(), sessionId, cwd, event: row.event }
    for (const key of PATH_FIELDS) if (key in e) e[key] = absolute(e[key], cwd)
    events.push(e)
  }
  return events
}

const relative = (path: unknown, cwd: string) =>
  typeof path === 'string' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

// One session's events, in time order, as the mod would have written them
export function encodeSession(events: Event[]): string {
  if (!events.length) return ''
  const start = Date.parse(events[0]!.ts)
  let cwd = events[0]!.cwd
  const rows: Record<string, unknown>[] = [{ v: FORMAT, event: 'session', start, cwd }]
  for (const e of events) {
    const t = Date.parse(e.ts) - start
    if (e.cwd !== cwd) {
      cwd = e.cwd
      rows.push({ t, event: 'cwd_changed', cwd })
    }
    const { ts: _ts, sessionId: _s, cwd: _c, project: _p, event, ...rest } = e
    if (event === 'cwd_changed') continue
    const row: Record<string, unknown> = { t, event, ...rest }
    for (const key of PATH_FIELDS) if (key in row) row[key] = relative(row[key], cwd)
    rows.push(row)
  }
  return rows.map(row => `${JSON.stringify(row)}\n`).join('')
}
