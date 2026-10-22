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
}

type AllTime = Pick<Summary, 'projects' | 'days' | 'sessions'>

// all time changes only when the person's sessions do, so it's kept per
// person until then; a range is cheap next to it
const MAX_PEOPLE = 50
const kept = new WeakMap<Db, Map<number, { key: string; ever: AllTime }>>()

function allTime(db: Db, personId: number, key: string, events: Event[], options: { idleCapMs: number; tz?: string }, timing?: Timing) {
  const people = kept.get(db) ?? new Map<number, { key: string; ever: AllTime }>()
  kept.set(db, people)
  let entry = people.get(personId)
  if (entry?.key !== key) {
    const { projects, days, sessions } = timed(timing, 'ever', () => summarize(events, options))
    entry = { key, ever: { projects, days, sessions } }
  }
  people.delete(personId)
  people.set(personId, entry)
  if (people.size > MAX_PEOPLE) people.delete(people.keys().next().value!)
  return entry.ever
}

// tz is the viewer's IANA zone, days and hours are theirs; a zone that
// doesn't exist throws a RangeError. spans (every active stretch) only when
// asked, since only the timeline draws them
export async function digest(db: Db, personId: number, window: { from?: number; to?: number; tz?: string; spans?: boolean }, timing?: Timing) {
  const { from, to, tz } = window
  const [{ sessions, version }, cap] = await Promise.all([sessionsOf(db, personId, timing), idleCapMs(db)])
  const events = [...sessions.values()].flat()
  const ever = allTime(db, personId, `${version}|${tz}|${cap}`, events, { idleCapMs: cap, tz }, timing)
  const range = timed(timing, 'sum', () => summarize(events, { from, to, idleCapMs: cap, tz }))
  timing?.set('sum', { ms: timing.get('sum')!.ms, note: `${events.length} events` })
  const home = new Map(ever.sessions.map(s => [s.sessionId, s.project]))
  const ids = new Set([...range.sessions.map(s => s.sessionId), ...range.spans.map(s => s.sessionId)])
  const homes = Object.fromEntries([...ids].map(id => [id, home.get(id) ?? '']))
  return {
    range: window.spans ? range : { ...range, spans: [] },
    projects: ever.projects,
    days: ever.days,
    homes,
    idleCapMs: cap,
  } satisfies Digest
}

// one session's events, with what the page needs from all time to color them
export async function sessionDigest(db: Db, personId: number, session: string, tz?: string) {
  const [{ sessions, version }, cap] = await Promise.all([sessionsOf(db, personId), idleCapMs(db)])
  const ever = allTime(db, personId, `${version}|${tz}|${cap}`, [...sessions.values()].flat(), { idleCapMs: cap, tz })
  return { events: sessions.get(session) ?? [], projects: ever.projects, idleCapMs: cap }
}
