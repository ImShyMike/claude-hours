// What a person sent, read back as the session files the mod wrote: each
// run's header and rows rebuilt exactly, so the dashboard decodes them with
// the same code the old local one used (analytics/load's tagSession)
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Table } from 'drizzle-orm'
import { draftTimelines, eventTables, otherEvents, runs, type Db } from './db/index'
import type { Event } from '../analytics/aggregate'
import { tagSession } from '../analytics/load'
import { parseTimelines, type Timeline } from '../analytics/replay'
import { joinRow, type Row } from './rows'

type RunRow = typeof runs.$inferSelect

const headerOf = (run: RunRow): Row => ({
  v: run.v ?? undefined,
  event: 'session',
  start: run.start,
  ...(run.cwd !== null && { cwd: run.cwd }),
  ...(run.root !== null && { root: run.root }),
  ...(run.rootName !== null && { rootName: run.rootName }),
  ...run.headerExtra,
})

const lines = (rows: Row[]) => rows.map(row => `${JSON.stringify(row)}\n`).join('')

const eventRuns = (personId: number) => and(eq(runs.personId, personId), eq(runs.stream, 'events'))

// sessions in the order the old loader read them (a plain sort, where the
// database's collation would skip the dashes), runs oldest first
const inOrder = (rows: RunRow[]) => rows.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : a.start - b.start))

// these runs as file text per session, each run's header then its rows
async function textsOf(db: Db, runRows: RunRow[]): Promise<Map<string, string>> {
  const rowsByRun = new Map<number, [n: number, row: Row][]>()
  const tables: [string | undefined, Table][] = [...Object.entries(eventTables), [undefined, otherEvents]]
  // a few hundred runs a query, well under the parameter limit
  for (let i = 0; i < runRows.length; i += 500) {
    const ids = runRows.slice(i, i + 500).map(r => r.id)
    // the tables side by side; each run's rows are put back in order below
    const found = await Promise.all(
      tables.map(async ([event, table]) => {
        const t = table as typeof otherEvents
        return { event, table, rows: await db.select().from(t).where(inArray(t.runId, ids)) }
      }),
    )
    for (const { event, table, rows } of found) {
      for (const row of rows) {
        const list = rowsByRun.get(row.runId) ?? []
        list.push([row.n, joinRow(table, row, event ? { event } : {})])
        rowsByRun.set(row.runId, list)
      }
    }
  }
  const texts = new Map<string, string>()
  for (const run of inOrder(runRows)) {
    const rows = (rowsByRun.get(run.id) ?? []).sort((a, b) => a[0] - b[0]).map(([, row]) => row)
    texts.set(run.session, (texts.get(run.session) ?? '') + lines([headerOf(run), ...rows]))
  }
  return texts
}

// every events run of a person's, as file text per session, runs in order
export async function sessionTexts(db: Db, personId: number): Promise<Map<string, string>> {
  return textsOf(db, await db.select().from(runs).where(eventRuns(personId)))
}

// The flat, project-tagged events of each session, kept between requests: a
// session is read and decoded again only once one of its runs has new rows
// (acked and updated_at move with every batch), so a dashboard refreshing
// while someone works re-reads just the session they're in
type Loaded = { key: string; events: Event[] }
// what's kept is bounded by events, not people, since one busy person can
// outweigh dozens of quiet ones; the person just asked for always stays
const MAX_EVENTS = 200_000
const cache = new WeakMap<Db, Map<number, Map<string, Loaded>>>()

// Where a request's time went, for its Server-Timing header: each step's ms,
// and a note on how much it did
export type Timing = Map<string, { ms: number; note?: string }>

export function timed<T>(timing: Timing | undefined, step: string, work: () => T): T {
  const at = performance.now()
  const done = () => {
    const was = timing?.get(step)
    timing?.set(step, { ...was, ms: (was?.ms ?? 0) + performance.now() - at })
  }
  const out = work()
  // a drizzle query is a thenable, not a Promise, and runs once awaited
  if (typeof (out as PromiseLike<unknown> | undefined)?.then === 'function') return Promise.resolve(out).finally(done) as T
  done()
  return out
}

export const serverTiming = (timing: Timing) =>
  [...timing].map(([step, { ms, note }]) => `${step};dur=${ms.toFixed(1)}${note ? `;desc="${note}"` : ''}`).join(', ')

const keyOf = (rows: RunRow[]) => rows.map(r => `${r.id}:${r.acked}:${r.updatedAt.getTime()}`).join(',')

// A person's sessions in order. version changes whenever any of them does,
// for caching what's worked out from them
export async function sessionsOf(db: Db, personId: number, timing?: Timing) {
  const people = cache.get(db) ?? new Map<number, Map<string, Loaded>>()
  cache.set(db, people)
  const known = people.get(personId) ?? new Map<string, Loaded>()
  // most recently used last, so the least recent goes first
  people.delete(personId)
  people.set(personId, known)

  const runRows = inOrder(await timed(timing, 'runs', () => db.select().from(runs).where(eventRuns(personId))))
  const bySession = new Map<string, RunRow[]>()
  for (const run of runRows) bySession.set(run.session, [...(bySession.get(run.session) ?? []), run])
  const changed = [...bySession].filter(([session, rows]) => known.get(session)?.key !== keyOf(rows))
  const reread = changed.flatMap(([, rows]) => rows)
  const texts = await timed(timing, 'rows', () => textsOf(db, reread))
  timing?.set('rows', { ms: timing.get('rows')!.ms, note: `${changed.length} of ${bySession.size} sessions, ${reread.length} runs` })
  timed(timing, 'decode', () => {
    for (const [session, rows] of changed) {
      known.set(session, { key: keyOf(rows), events: tagSession([texts.get(session) ?? ''], session, { remote: true }) })
    }
  })
  // sessions deleted since
  for (const session of known.keys()) if (!bySession.has(session)) known.delete(session)
  const count = (m: Map<string, Loaded>) => [...m.values()].reduce((n, l) => n + l.events.length, 0)
  let held = [...people.values()].reduce((n, m) => n + count(m), 0)
  for (const [other, m] of people) {
    if (held <= MAX_EVENTS || other === personId) break
    held -= count(m)
    people.delete(other)
  }

  const sessions = new Map([...bySession.keys()].map(session => [session, known.get(session)!.events]))
  return { sessions, version: keyOf(runRows) }
}

// the flat, project-tagged events the dashboard works on
export async function eventsOf(db: Db, personId: number): Promise<Event[]> {
  return [...(await sessionsOf(db, personId)).sessions.values()].flat()
}

export async function draftsText(db: Db, personId: number, session: string) {
  const stored = await db
    .select({ row: draftTimelines })
    .from(draftTimelines)
    .innerJoin(runs, eq(runs.id, draftTimelines.runId))
    .where(and(eq(runs.personId, personId), eq(runs.session, session), eq(runs.stream, 'drafts')))
    .orderBy(asc(draftTimelines.n))
  return lines(stored.map(({ row }) => joinRow(draftTimelines, row)))
}

export async function timelinesOf(db: Db, personId: number, session: string): Promise<Timeline[]> {
  return parseTimelines(await draftsText(db, personId, session))
}
