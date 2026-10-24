// What the dashboard pages show, summed here instead of in the browser: a
// range's summary, plus what all time decides whatever the range (each
// project's color by rank, the calendar's days, each session's home project).
// The browser gets these few numbers, not every event
import { summarize, type Event, type Summary } from '../analytics/aggregate'
import type { Db } from './db/index'
import { sessionsOf, timed, type Timing } from './history'
import { idleCapMs } from './settings'

export type Digest = {
  range: Summary
  projects: Summary['projects']
  days: Summary['days']
  // the project each session in range is drawn under on the timeline
  homes: Record<string, string>
  idleCapMs: number
  // active time in the same stretch of clock whole days earlier (yesterday
  // up to this time, the 7 days before), for a range with both ends and no spans
  before?: number
}

type AllTime = Pick<Summary, 'projects' | 'days' | 'sessions'>

// all time changes only when the person's sessions do, so it's kept per
// person until then; a range is cheap next to it
const MAX_PEOPLE = 50
const kept = new WeakMap<Db, Map<number, { key: string; ever: AllTime }>>()

// and when they do, it's mostly one session, the one being worked in. Each
// session's own all time is kept for as long as history.ts keeps its events
// (the same array until it changes), by zone and idle cap, and the person's
// is those added up
const ofSession = new WeakMap<Event[], Map<string, AllTime>>()

function sessionAllTime(events: Event[], options: { idleCapMs: number; tz?: string }) {
  const key = `${options.tz}|${options.idleCapMs}`
  const known = ofSession.get(events) ?? new Map<string, AllTime>()
  ofSession.set(events, known)
  let ever = known.get(key)
  if (!ever) {
    const { projects, days, sessions } = summarize(events, options)
    known.set(key, (ever = { projects, days, sessions }))
  }
  return ever
}

// YYYY-MM-DD, a calendar day on
const nextDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
}

// sessions' all times as one: projects and days summed, the days between
// them filled in as summarize does
function added(parts: AllTime[]): AllTime {
  const projects = new Map<string, number>()
  const days = new Map<string, Summary['days'][number]>()
  for (const part of parts) {
    for (const { project, ms } of part.projects) projects.set(project, (projects.get(project) ?? 0) + ms)
    for (const d of part.days) {
      const sum = days.get(d.day) ?? { day: d.day, ms: 0, prompts: 0, projects: {} }
      sum.ms += d.ms
      sum.prompts += d.prompts
      for (const [project, ms] of Object.entries(d.projects)) sum.projects[project] = (sum.projects[project] ?? 0) + ms
      days.set(d.day, sum)
    }
  }
  const keys = [...days.keys()].sort()
  const filled: Summary['days'] = []
  for (let day = keys[0]; day && day <= keys.at(-1)!; day = nextDay(day)) {
    filled.push(days.get(day) ?? { day, ms: 0, prompts: 0, projects: {} })
  }
  return {
    projects: [...projects].sort((a, b) => b[1] - a[1]).map(([project, ms]) => ({ project, ms })),
    days: filled,
    sessions: parts.flatMap(p => p.sessions).sort((a, b) => b.start - a.start),
  }
}

function allTime(
  db: Db,
  personId: number,
  key: string,
  sessions: Map<string, Event[]>,
  options: { idleCapMs: number; tz?: string },
  timing?: Timing,
) {
  const people = kept.get(db) ?? new Map<number, { key: string; ever: AllTime }>()
  kept.set(db, people)
  let entry = people.get(personId)
  if (entry?.key !== key) {
    const ever = timed(timing, 'ever', () => added([...sessions.values()].map(events => sessionAllTime(events, options))))
    entry = { key, ever }
  }
  people.delete(personId)
  people.set(personId, entry)
  if (people.size > MAX_PEOPLE) people.delete(people.keys().next().value!)
  return entry.ever
}

const DAY = 86_400_000

// tz is the viewer's IANA zone, days and hours are theirs; a zone that
// doesn't exist throws a RangeError. spans (every active stretch) only when
// asked, since only the timeline draws them
export async function digest(db: Db, personId: number, window: { from?: number; to?: number; tz?: string; spans?: boolean }, timing?: Timing) {
  const { from, to, tz } = window
  const [{ sessions, version }, cap] = await Promise.all([sessionsOf(db, personId, timing), idleCapMs(db)])
  const events = [...sessions.values()].flat()
  const ever = allTime(db, personId, `${version}|${tz}|${cap}`, sessions, { idleCapMs: cap, tz }, timing)
  const range = timed(timing, 'sum', () => summarize(events, { from, to, idleCapMs: cap, tz }))
  timing?.set('sum', { ms: timing.get('sum')!.ms, note: `${events.length} events` })
  const shift = from !== undefined && to !== undefined && !window.spans ? Math.ceil((to - from) / DAY) * DAY : 0
  const before = shift
    ? timed(timing, 'before', () => summarize(events, { from: from! - shift, to: to! - shift, idleCapMs: cap, tz }).totalMs)
    : undefined
  const home = new Map(ever.sessions.map(s => [s.sessionId, s.project]))
  const ids = new Set([...range.sessions.map(s => s.sessionId), ...range.spans.map(s => s.sessionId)])
  const homes = Object.fromEntries([...ids].map(id => [id, home.get(id) ?? '']))
  return {
    range: window.spans ? range : { ...range, spans: [] },
    projects: ever.projects,
    days: ever.days,
    homes,
    idleCapMs: cap,
    before,
  } satisfies Digest
}

// one session's events, with what the page needs from all time to color them
export async function sessionDigest(db: Db, personId: number, session: string, tz?: string) {
  const [{ sessions, version }, cap] = await Promise.all([sessionsOf(db, personId), idleCapMs(db)])
  const ever = allTime(db, personId, `${version}|${tz}|${cap}`, sessions, { idleCapMs: cap, tz })
  return { events: sessions.get(session) ?? [], projects: ever.projects, idleCapMs: cap }
}
