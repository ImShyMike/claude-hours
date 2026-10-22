import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { loadEvents, sessionParts } from '../analytics/load'
import { rowsOf, splitRuns } from '../analytics/runs'
import { people, quarantine, type Db } from './db/index'
import { testDb } from './db/testing'
import { draftsText, eventsOf, sessionTexts } from './history'
import { ingest, parseBatch, type RunIn } from './ingest'

async function withPerson() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ sub: 'ident!ana' }).returning()
  return { db, person: p!.id }
}

// a session's files as the runs the mod would send, all from row 0
async function runsOf(dir: string, session: string): Promise<RunIn[]> {
  const events = (await sessionParts(join(dir, 'events', `${session}.jsonl`))).join('')
  const drafts = (await sessionParts(join(dir, 'drafts', `${session}.jsonl`))).join('')
  return [
    ...splitRuns(events).map(r => ({ session, stream: 'events' as const, run: r.start, header: r.header, from: 0, rows: r.rows })),
    ...(drafts ? [{ session, stream: 'drafts' as const, run: 0, from: 0, rows: rowsOf(drafts) }] : []),
  ]
}

async function importDir(db: Db, person: number, dir: string) {
  const sessions = readdirSync(join(dir, 'events')).map(name => name.replace(/\.jsonl(\.gz)?$/, ''))
  for (const session of new Set(sessions)) {
    const result = await ingest(db, person, await runsOf(dir, session))
    for (const r of Object.values(result.runs)) expect(r.status).toBe('ok')
  }
  return [...new Set(sessions)]
}

// every row of every file comes back exactly, and so the dashboard's events
// are the ones the old local dashboard read off the same files
async function expectRoundTrip(dir: string) {
  const { db, person } = await withPerson()
  const sessions = await importDir(db, person, dir)
  const texts = await sessionTexts(db, person)
  for (const session of sessions) {
    const original = splitRuns((await sessionParts(join(dir, 'events', `${session}.jsonl`))).join(''))
    expect(splitRuns(texts.get(session) ?? '')).toEqual(original)
    const drafts = (await sessionParts(join(dir, 'drafts', `${session}.jsonl`))).join('')
    expect(rowsOf(await draftsText(db, person, session))).toEqual(rowsOf(drafts))
  }
  const events = await eventsOf(db, person)
  expect(events.length).toBeGreaterThan(sessions.length)
  expect(events).toEqual(await loadEvents(dir, { remote: true }))
}

describe('round trip', () => {
  let fixtures: string
  beforeAll(() => {
    fixtures = mkdtempSync(join(tmpdir(), 'claude-hours-fixtures-'))
    execFileSync('bun', [join(import.meta.dirname, '../../../scripts/fixtures.ts')], { cwd: fixtures, stdio: 'ignore' })
    fixtures = join(fixtures, 'fixtures')
  })

  test('the demo fixtures come back row for row', async () => {
    await expectRoundTrip(fixtures)
  }, 60_000)

  // ANALYTICS_DIR=~/.claude/analytics to check real data too (read only)
  test.skipIf(!process.env.ANALYTICS_DIR)(
    'real data comes back row for row',
    async () => {
      await expectRoundTrip(process.env.ANALYTICS_DIR!)
    },
    600_000,
  )
})

const header = { v: 1, event: 'session', start: 1000, cwd: '/code/terra' }
const run = (from: number, rows: unknown[], extra: Partial<RunIn> = {}): RunIn => ({
  session: 's1',
  stream: 'events',
  run: 1000,
  header,
  from,
  rows,
  ...extra,
})
const tool = (t: number) => ({ t, event: 'tool', tool: 'Read', durationMs: 5 })

describe('acks', () => {
  test('a repeat or an overlap stores each row once', async () => {
    const { db, person } = await withPerson()
    expect((await ingest(db, person, [run(0, [tool(1), tool(2)])])).runs['s1/events/1000']).toEqual({ status: 'ok', acked: 2 })
    expect((await ingest(db, person, [run(0, [tool(1), tool(2)])])).runs['s1/events/1000']).toEqual({ status: 'ok', acked: 2 })
    expect((await ingest(db, person, [run(1, [tool(2), tool(3)])])).runs['s1/events/1000']).toEqual({ status: 'ok', acked: 3 })
    expect(splitRuns((await sessionTexts(db, person)).get('s1')!)[0]!.rows).toEqual([tool(1), tool(2), tool(3)])
  })

  test('rows past what the hub holds are a gap, and nothing is stored', async () => {
    const { db, person } = await withPerson()
    await ingest(db, person, [run(0, [tool(1)])])
    expect((await ingest(db, person, [run(5, [tool(9)])])).runs['s1/events/1000']).toEqual({ status: 'gap', acked: 1 })
  })

  test('a new run needs its header', async () => {
    const { db, person } = await withPerson()
    const { runs } = await ingest(db, person, [run(0, [tool(1)], { header: undefined }), run(0, [tool(1)], { run: 2000 })])
    expect(runs['s1/events/1000']!.status).toBe('invalid')
    expect(runs['s1/events/2000']!.status).toBe('invalid')
  })

  test('a bad row is quarantined and still counted, so the run goes on', async () => {
    const { db, person } = await withPerson()
    const result = await ingest(db, person, [run(0, [tool(1), 'not json', { t: 3 }, tool(4)])])
    expect(result).toMatchObject({ runs: { 's1/events/1000': { status: 'ok', acked: 4 } }, quarantined: 2 })
    expect((await db.select().from(quarantine)).map(q => [q.n, q.reason])).toEqual([
      [1, 'not a JSON object'],
      [2, 'no event'],
    ])
  })

  test('values that fit no column, and events nobody knows, come back as sent', async () => {
    const { db, person } = await withPerson()
    const odd = [
      { t: 1, event: 'tool', tool: 'Read', durationMs: '12', outcome: null, brandNew: { a: [1] } },
      { t: 1.5, event: 'mystery', anything: true },
      { at: 1792472272642, event: 'prompt', words: 3 },
    ]
    await ingest(db, person, [run(0, odd)])
    expect(splitRuns((await sessionTexts(db, person)).get('s1')!)).toEqual([{ start: 1000, header, rows: odd }])
  })

  test('people only ever see their own rows', async () => {
    const { db, person } = await withPerson()
    const [bo] = await db.insert(people).values({ sub: 'ident!bo' }).returning()
    await ingest(db, person, [run(0, [tool(1)])])
    await ingest(db, bo!.id, [run(0, [tool(1), tool(2)])])
    expect(splitRuns((await sessionTexts(db, person)).get('s1')!)[0]!.rows).toHaveLength(1)
  })
})

describe('parseBatch', () => {
  test('turns down what the protocol says it should', () => {
    expect(parseBatch({ runs: [run(0, [])] })).toMatchObject({ runs: [{ session: 's1' }] })
    expect(parseBatch({})).toMatchObject({ status: 400 })
    expect(parseBatch({ runs: [{ ...run(0, []), session: '../etc' }] })).toMatchObject({ status: 400 })
    expect(parseBatch({ runs: [{ ...run(0, []), stream: 'drafts', run: 5 }] })).toMatchObject({ status: 400 })
    expect(parseBatch({ runs: [run(0, Array(5001).fill(tool(1)))] })).toMatchObject({ status: 413 })
  })
})
