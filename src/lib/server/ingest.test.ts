import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { firstAt, lastAt, projectSpans, summarize } from '../analytics/aggregate'
import { loadEvents, sessionParts } from '../analytics/load'
import { rowsOf, splitRuns } from '../analytics/runs'
import { deviceTokens, people, quarantine, type Db } from './db/index'
import { testDb } from './db/testing'
import { digest } from './digest'
import { revokeDevice, sessionDevices } from './devices'
import { draftsText, eventsOf, serverTiming, sessionTexts, type Timing } from './history'
import { ingest, parseBatch, type RunIn } from './ingest'
import { setIdleCap } from './settings'
import { quickStats } from './stats'

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
  const local = await loadEvents(dir, { remote: true })
  expect(events).toEqual(local)

  // and the hub's summary is the one the browser worked out from them, in
  // another zone than this machine's too
  for (const tz of [undefined, 'Asia/Kolkata']) {
    const ever = summarize(local, { idleCapMs: 5 * 60_000, tz })
    const from = ever.sessions.at(-1)!.start
    const to = from + 3 * 24 * 3600_000
    const got = await digest(db, person, { from, to, tz, spans: true })
    expect(got.range).toEqual(summarize(local, { from, to, idleCapMs: 5 * 60_000, tz }))
    expect(got.days).toEqual(ever.days)
    expect(got.projects).toEqual(ever.projects)
    expect(got.before).toBeUndefined()
    // without spans it also sums the 3 days before, to compare against:
    // the 3 days after these have these as theirs
    const shift = 3 * 24 * 3600_000
    expect(got.range.totalMs).toBeGreaterThan(0)
    expect((await digest(db, person, { from: from + shift, to: to + shift, tz })).before).toBe(got.range.totalMs)
    // which leaves out the sessions that began after it: none of a
    // session's spans start before its firstAt or end after its lastAt
    for (const s of ever.sessions) {
      const events = local.filter(e => e.sessionId === s.sessionId)
      for (const [start, end] of [...projectSpans(events, 5 * 60_000).values()].flat()) {
        expect(start).toBeGreaterThanOrEqual(firstAt(events))
        expect(end).toBeLessThanOrEqual(lastAt(events))
      }
    }
    // and check it where sessions start and end too
    for (const s of ever.sessions.slice(0, 20)) {
      for (const at of [s.start - 3600_000, s.start + 60_000, s.end - 60_000]) {
        const earlier = { from: at - shift, to: at, idleCapMs: 5 * 60_000, tz }
        expect((await digest(db, person, { from: at, to: at + shift, tz })).before).toBe(summarize(local, earlier).totalMs)
      }
    }
    // a late window skips the sessions over before it, an empty one past
    // everything still has its days, and both sum as all of history would
    const newest = ever.sessions[0]!.start
    for (const late of [newest - 2 * 24 * 3600_000, newest + 30 * 24 * 3600_000]) {
      const window = { from: late, to: late + 3 * 24 * 3600_000 }
      expect((await digest(db, person, { ...window, tz, spans: true })).range).toEqual(summarize(local, { ...window, idleCapMs: 5 * 60_000, tz }))
    }
  }
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

  test('a backfill from before backfill.py ended answered turns outside the terminal is turned down', async () => {
    const { db, person } = await withPerson()
    const { runs } = await ingest(db, person, [
      run(0, [tool(1)], { header: { ...header, backfill: 1 } }),
      run(0, [tool(1)], { session: 's2', header: { ...header, backfill: 2 } }),
      run(0, [tool(1)], { session: 's3', header: { ...header, backfill: 3 } }),
    ])
    expect(runs['s1/events/1000']).toEqual({ status: 'invalid', acked: 0, error: expect.stringContaining('/time-track update') })
    expect(runs['s2/events/1000']).toEqual({ status: 'invalid', acked: 0, error: expect.stringContaining('/time-track update') })
    expect(runs['s3/events/1000']).toEqual({ status: 'ok', acked: 1 })
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

  test('a run keeps the device that started it, after that device is revoked too', async () => {
    const { db, person } = await withPerson()
    const device = (name: string) =>
      db
        .insert(deviceTokens)
        .values({ tokenHash: name, personId: person, name })
        .returning()
        .then(([d]) => d!.id)
    const [laptop, desktop] = [await device('laptop'), await device('desktop')]
    await ingest(db, person, [run(0, [tool(1)])], { deviceId: laptop })
    // more of the same run from elsewhere doesn't move it
    await ingest(db, person, [run(1, [tool(2)])], { deviceId: desktop })
    await ingest(db, person, [run(0, [tool(1)], { run: 2000, header: { ...header, start: 2000 } })], { deviceId: desktop })
    await ingest(db, person, [run(0, [tool(1)], { session: 's2' })])
    expect(await sessionDevices(db, person, 's1')).toEqual(['laptop', 'desktop'])
    expect(await sessionDevices(db, person, 's2')).toEqual([])
    await revokeDevice(db, person, laptop)
    expect(await sessionDevices(db, person, 's1')).toEqual(['laptop', 'desktop'])
  })
})

describe('digest', () => {
  const prompt = (t: number) => ({ t, event: 'prompt', words: 3 })

  test('follows new rows, new sessions and the idle cap', async () => {
    const { db, person } = await withPerson()
    await ingest(db, person, [run(0, [prompt(1), tool(2)])])
    const timing: Timing = new Map()
    const first = await digest(db, person, {}, timing)
    expect(first.range.prompts.count).toBe(1)
    expect(serverTiming(timing)).toMatch(
      /^runs;dur=[\d.]+, rows;dur=[\d.]+;desc="1 of 1 sessions, 1 runs", decode;dur=[\d.]+, ever;dur=[\d.]+, sum;dur=[\d.]+;desc="2 events"$/,
    )
    expect(first.idleCapMs).toBe(5 * 60_000)
    // all of it again, with nothing new, is the summary already summed
    const again: Timing = new Map()
    expect((await digest(db, person, {}, again)).range).toEqual(first.range)
    expect(again.has('sum')).toBe(false)

    await ingest(db, person, [run(2, [prompt(180_000)]), run(0, [prompt(1)], { session: 's2' })])
    const second = await digest(db, person, {})
    expect(second.range.prompts.count).toBe(3)
    expect(second.range.sessions.map(s => s.sessionId).sort()).toEqual(['s1', 's2'])

    // the 3 minutes between s1's prompts count under the 5 min cap, not under 2
    expect(await setIdleCap(db, person, 7)).toBe(false)
    expect(await setIdleCap(db, person, 2)).toBe(true)
    const third = await digest(db, person, {})
    expect(third.idleCapMs).toBe(2 * 60_000)
    expect(third.range.totalMs).toBeLessThan(second.range.totalMs)
  })

  test('counting only prompts is kept apart from counting it all, with the same colors', async () => {
    const { db, person } = await withPerson()
    await ingest(db, person, [
      run(0, [
        { t: 60_000, event: 'prompt', origin: 'composer', typingMs: 60_000 },
        { t: 20 * 60_000, event: 'turn_end', durationMs: 19 * 60_000 },
      ]),
    ])
    const all = await digest(db, person, {})
    const prompts = await digest(db, person, { counting: 'prompts' })
    expect(all.range.totalMs).toBe(20 * 60_000)
    expect(prompts.range.totalMs).toBe(60_000)
    expect(prompts.days.reduce((sum, d) => sum + d.ms, 0)).toBe(60_000)
    expect(prompts.projects).toEqual(all.projects)
    // and neither is handed the other's summary of all of it
    expect((await digest(db, person, {})).range).toEqual(all.range)
    expect((await digest(db, person, { counting: 'prompts' })).range).toEqual(prompts.range)
  })

  test('a time zone that does not exist is a RangeError', async () => {
    const { db, person } = await withPerson()
    await expect(digest(db, person, { tz: 'Mars/Olympus' })).rejects.toThrow(RangeError)
  })
})

describe('quickStats', () => {
  test('today, the last 7 days with their top projects, and all time', async () => {
    const { db, person } = await withPerson()
    const DAY = 24 * 60 * 60_000
    const at = Date.UTC(2026, 9, 20, 12)
    const session = (session: string, start: number, cwd: string, rows: unknown[]) =>
      run(0, rows, { session, run: start, header: { ...header, start, cwd } })
    await ingest(db, person, [
      session('today', at, '/code/terra', [{ t: 0, event: 'prompt' }, tool(60_000)]),
      session('this-week', at - 3 * DAY, '/code/hub', [{ t: 0, event: 'prompt' }, tool(120_000)]),
      session('long-ago', at - 30 * DAY, '/code/terra', [{ t: 0, event: 'prompt' }, tool(60_000)]),
    ])
    expect(await quickStats(db, person, { now: at + 2 * 60 * 60_000, tz: 'UTC' })).toEqual({
      today: { ms: 60_000, sessions: 1 },
      week: {
        ms: 180_000,
        projects: [
          { project: 'hub', ms: 120_000 },
          { project: 'terra', ms: 60_000 },
        ],
      },
      allTime: { ms: 240_000 },
    })
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
