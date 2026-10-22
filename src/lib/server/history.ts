// What a person sent, read back as the session files the mod wrote: each
// run's header and rows rebuilt exactly, so the dashboard decodes them with
// the same code the old local one used (analytics/load's tagSession)
import { and, asc, eq } from 'drizzle-orm'
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

// every events run of a person's, as file text per session, runs in order
export async function sessionTexts(db: Db, personId: number): Promise<Map<string, string>> {
  const mine = and(eq(runs.personId, personId), eq(runs.stream, 'events'))
  // sessions in the order the old loader read them (a plain sort, where the
  // database's collation would skip the dashes), runs oldest first
  const runRows = (await db.select().from(runs).where(mine).orderBy(asc(runs.start))).sort((a, b) =>
    a.session < b.session ? -1 : a.session > b.session ? 1 : 0,
  )
  const rowsByRun = new Map<number, [n: number, row: Row][]>()
  const tables: [string | undefined, Table][] = [...Object.entries(eventTables), [undefined, otherEvents]]
  for (const [event, table] of tables) {
    const t = table as typeof otherEvents
    const stored = await db.select({ row: t }).from(t).innerJoin(runs, eq(runs.id, t.runId)).where(mine)
    for (const { row } of stored) {
      const list = rowsByRun.get(row.runId) ?? []
      list.push([row.n, joinRow(table, row, event ? { event } : {})])
      rowsByRun.set(row.runId, list)
    }
  }
  const texts = new Map<string, string>()
  for (const run of runRows) {
    const rows = (rowsByRun.get(run.id) ?? []).sort((a, b) => a[0] - b[0]).map(([, row]) => row)
    texts.set(run.session, (texts.get(run.session) ?? '') + lines([headerOf(run), ...rows]))
  }
  return texts
}

// the flat, project-tagged events the dashboard works on
export async function eventsOf(db: Db, personId: number): Promise<Event[]> {
  const events: Event[] = []
  for (const [session, text] of await sessionTexts(db, personId)) events.push(...tagSession([text], session, { remote: true }))
  return events
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
