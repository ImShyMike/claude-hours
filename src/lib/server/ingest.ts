// POST /v1/events: what the mod's session files hold, run by run (the sync
// protocol in docs/how-it-works.md). Every run keeps a contiguous prefix of its
// rows, so a repeated, reordered or interrupted send never doubles or skips
// one
import { and, eq, sql } from 'drizzle-orm'
import type { Table } from 'drizzle-orm'
import { draftTimelines, eventTables, otherEvents, quarantine, runs, type Db } from './db/index'
import { SESSION_ID } from '../analytics/load'
import { splitRow, type Row } from './rows'

export const PROTOCOLS = [1]
export const MAX_ROWS = 5000
export const MAX_BYTES = 4 * 1024 * 1024

export type RunIn = { session: string; stream: 'events' | 'drafts'; run: number; header?: Row; from: number; rows: unknown[] }
export type RunResult = { status: 'ok' | 'gap' | 'invalid'; acked: number; error?: string }

const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0

export const runKey = (r: Pick<RunIn, 'session' | 'stream' | 'run'>) => `${r.session}/${r.stream}/${r.run}`

// the body's runs, or what's wrong with it
export function parseBatch(body: unknown): { runs: RunIn[] } | { error: string; status: 400 | 413 } {
  if (!isObject(body) || !Array.isArray(body.runs)) return { error: 'expected { runs: [...] }', status: 400 }
  const out: RunIn[] = []
  let rows = 0
  for (const r of body.runs) {
    if (!isObject(r)) return { error: 'every run must be an object', status: 400 }
    const { session, stream, run, header, from } = r
    if (typeof session !== 'string' || !SESSION_ID.test(session)) return { error: 'bad session id', status: 400 }
    if (stream !== 'events' && stream !== 'drafts') return { error: 'stream must be events or drafts', status: 400 }
    if (!count(run) || (stream === 'drafts' && run !== 0)) return { error: 'bad run', status: 400 }
    if (!count(from) || !Array.isArray(r.rows)) return { error: 'every run needs from and rows', status: 400 }
    if (header !== undefined && !isObject(header)) return { error: 'header must be an object', status: 400 }
    rows += r.rows.length
    out.push({ session, stream, run: run as number, header: header as Row | undefined, from: from as number, rows: r.rows })
  }
  if (rows > MAX_ROWS) return { error: `at most ${MAX_ROWS} rows per request`, status: 413 }
  return { runs: out }
}

// the header's own fields go in the run's columns, the rest in header_extra
function headerColumns(header: Row) {
  const { event: _event, start: _start, v, cwd, root, rootName, ...rest } = header
  const text = (value: unknown) => (typeof value === 'string' && !value.includes('\0') ? value : undefined)
  const extra: Row = { ...rest }
  if (v !== undefined && !Number.isInteger(v)) extra.v = v
  for (const [key, value] of Object.entries({ cwd, root, rootName })) if (value !== undefined && text(value) === undefined) extra[key] = value
  return {
    v: Number.isInteger(v) ? (v as number) : null,
    cwd: text(cwd) ?? null,
    root: text(root) ?? null,
    rootName: text(rootName) ?? null,
    headerExtra: Object.keys(extra).length ? extra : null,
  }
}

type Placed = { table: Table; values: Row } | { reason: string }

// Postgres jsonb can't hold a NUL either, anywhere in the row
const hasNul = (row: unknown) => JSON.stringify(row).includes('\\u0000')

function placeEvent(row: unknown): Placed {
  if (!isObject(row)) return { reason: 'not a JSON object' }
  if (typeof row.event !== 'string') return { reason: 'no event' }
  if (hasNul(row)) return { reason: 'holds a NUL character' }
  const table = (eventTables as Record<string, Table>)[row.event]
  return table ? { table, values: splitRow(table, row, ['event']) } : { table: otherEvents, values: splitRow(otherEvents, row) }
}

function placeTimeline(row: unknown): Placed {
  if (!isObject(row)) return { reason: 'not a JSON object' }
  if (typeof row.draftId !== 'string') return { reason: 'no draftId' }
  if (hasNul(row)) return { reason: 'holds a NUL character' }
  return { table: draftTimelines, values: splitRow(draftTimelines, row) }
}

// one insert per table, in slices that stay well under Postgres' 65535
// parameters (the widest table has about 30 columns)
const SLICE = 500

async function storeRun(db: Db, personId: number, r: RunIn, now: Date, deviceId?: number): Promise<{ result: RunResult; quarantined: number }> {
  return db.transaction(async tx => {
    const where = and(eq(runs.personId, personId), eq(runs.session, r.session), eq(runs.stream, r.stream), eq(runs.start, r.run))
    let [run] = await tx.select({ id: runs.id, acked: runs.acked }).from(runs).where(where).for('update')
    if (!run) {
      if (r.stream === 'events' && (r.header?.event !== 'session' || r.header.start !== r.run))
        return { result: { status: 'invalid', acked: 0, error: 'a new run needs its header, with start equal to run' }, quarantined: 0 }
      await tx
        .insert(runs)
        .values({ personId, deviceId, session: r.session, stream: r.stream, start: r.run, ...(r.header ? headerColumns(r.header) : {}) })
        .onConflictDoNothing()
      ;[run] = await tx.select({ id: runs.id, acked: runs.acked }).from(runs).where(where).for('update')
    }
    const { id, acked } = run!
    if (r.from > acked) return { result: { status: 'gap', acked }, quarantined: 0 }
    const fresh = r.rows.slice(acked - r.from)
    if (!fresh.length) return { result: { status: 'ok', acked }, quarantined: 0 }

    const byTable = new Map<Table, Row[]>()
    const bad: (typeof quarantine.$inferInsert)[] = []
    fresh.forEach((row, i) => {
      const n = acked + i
      const placed = r.stream === 'events' ? placeEvent(row) : placeTimeline(row)
      if ('reason' in placed) {
        bad.push({ personId, session: r.session, stream: r.stream, start: r.run, n, row: hasNul(row) ? null : row, reason: placed.reason })
        return
      }
      byTable.set(placed.table, [...(byTable.get(placed.table) ?? []), { ...placed.values, runId: id, n }])
    })
    for (const [table, rows] of byTable) {
      for (let i = 0; i < rows.length; i += SLICE)
        await tx
          .insert(table)
          .values(rows.slice(i, i + SLICE))
          .onConflictDoNothing()
    }
    if (bad.length) await tx.insert(quarantine).values(bad)
    const next = acked + fresh.length
    await tx.update(runs).set({ acked: next, updatedAt: now }).where(eq(runs.id, id))
    return { result: { status: 'ok', acked: next }, quarantined: bad.length }
  })
}

// Runs one at a time, each in its own transaction, so a long batch never
// holds many locks at once. deviceId: the device sending, kept on runs it starts
export async function ingest(db: Db, personId: number, batch: RunIn[], { now = new Date(), deviceId }: { now?: Date; deviceId?: number } = {}) {
  const results: Record<string, RunResult> = {}
  let quarantined = 0
  for (const r of batch) {
    const stored = await storeRun(db, personId, r, now, deviceId)
    results[runKey(r)] = stored.result
    quarantined += stored.quarantined
  }
  return { runs: results, quarantined }
}

// how many rows of each run the hub holds, for a person (the settings page)
export async function rowsHeld(db: Db, personId: number) {
  const [row] = await db
    .select({ runs: sql<number>`count(*)::int`, rows: sql<number>`coalesce(sum(${runs.acked}), 0)::int` })
    .from(runs)
    .where(eq(runs.personId, personId))
  return row ?? { runs: 0, rows: 0 }
}
