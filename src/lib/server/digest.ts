// What the dashboard pages show, summed here instead of in the browser: a
// range's summary, plus what all time decides whatever the range (each
// project's color by rank, the calendar's days, each session's home project).
// The browser gets these few numbers, not every event. Counting only prompts
// changes every time in it but the colors, so a toggle doesn't repaint them
import { firstAt, lastAt, summarize, type Counting, type Event, type Summary } from '../analytics/aggregate'
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
type Options = { idleCapMs: number; tz?: string; counting: Counting }

// all time changes only when the person's sessions do, so it's kept per
// person and counting until then, and so is the summary of the range that's
// all of it; a range with ends is cheap next to them
const MAX_KEPT = 100
type Kept = { key: string; ever: AllTime; whole?: Summary }
const kept = new WeakMap<Db, Map<string, Kept>>()

// and when they do, it's mostly one session, the one being worked in.
// Sessions only take time from each other where they ran at once (only the
// one in the foreground counts then), so all time is worked out per cluster
// of sessions that overlap, kept for as long as history.ts keeps their events
// (the same arrays until one changes), by zone, idle cap and counting, and the
// person's is those added up
type Cluster = { members: Event[][]; known: Map<string, AllTime> }
const ofCluster = new WeakMap<Event[], Cluster>()

// sessions grouped where their stretches overlap, each group oldest first.
// gap: how far apart two sessions can still change each other's time, since
// counting only prompts, the first one in a session takes its gap (up to the
// cap) from the last one before
function clusters(sessions: Event[][], gap: number): Event[][][] {
  const groups: Event[][][] = []
  let end = -Infinity
  for (const events of [...sessions].sort((a, b) => boundsOf(a).start - boundsOf(b).start)) {
    const bounds = boundsOf(events)
    if (groups.length && bounds.start < end + gap) {
      groups.at(-1)!.push(events)
      end = Math.max(end, bounds.end)
    } else {
      groups.push([events])
      end = bounds.end
    }
  }
  return groups
}

function clusterAllTime(members: Event[][], options: Options) {
  const key = `${options.tz}|${options.idleCapMs}|${options.counting}`
  let cluster = ofCluster.get(members[0]!)
  if (!cluster || cluster.members.length !== members.length || cluster.members.some((events, i) => events !== members[i])) {
    ofCluster.set(members[0]!, (cluster = { members, known: new Map() }))
  }
  let ever = cluster.known.get(key)
  if (!ever) {
    const { projects, days, sessions } = summarize(members.flat(), options)
    cluster.known.set(key, (ever = { projects, days, sessions }))
  }
  return ever
}

// YYYY-MM-DD, a calendar day on
const nextDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
}

// clusters' all times as one: projects and days summed, the days between
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

function allTime(db: Db, personId: number, key: string, sessions: Map<string, Event[]>, options: Options, timing?: Timing) {
  const people = kept.get(db) ?? new Map<string, Kept>()
  kept.set(db, people)
  const whose = `${personId} ${options.counting}`
  let entry = people.get(whose)
  if (entry?.key !== key) {
    const ever = timed(timing, 'ever', () => added(clusters([...sessions.values()], gapOf(options)).map(members => clusterAllTime(members, options))))
    entry = { key, ever }
  }
  people.delete(whose)
  people.set(whose, entry)
  if (people.size > MAX_KEPT) people.delete(people.keys().next().value!)
  return entry
}

const DAY = 86_400_000

// each session's first and last moments, for as long as history.ts keeps
// its events
const bounds = new WeakMap<Event[], { start: number; end: number }>()
function boundsOf(events: Event[]) {
  let known = bounds.get(events)
  if (!known) bounds.set(events, (known = { start: firstAt(events), end: lastAt(events) }))
  return known
}
const within = (sessions: Event[][], gap: number, from: number, to = Infinity) =>
  sessions.filter(events => boundsOf(events).end + gap >= from && boundsOf(events).start < to).flat()

// how far before a stretch its time can reach, counting only prompts (summarize's heartbeats)
const gapOf = (options: Options) => (options.counting === 'prompts' ? options.idleCapMs : 0)

// tz is the viewer's IANA zone, days and hours are theirs; a zone that
// doesn't exist throws a RangeError. spans (every active stretch) only when
// asked, since only the timeline draws them
export async function digest(
  db: Db,
  personId: number,
  window: { from?: number; to?: number; tz?: string; spans?: boolean; counting?: Counting },
  timing?: Timing,
) {
  const { from, to, tz, counting = 'all' } = window
  const [{ sessions, version }, cap] = await Promise.all([sessionsOf(db, personId, timing), idleCapMs(db, personId)])
  const key = `${version}|${tz}|${cap}`
  const entry = allTime(db, personId, key, sessions, { idleCapMs: cap, tz, counting }, timing)
  const ever = entry.ever
  // colors rank by all of the time, whatever's counted
  const ranked = counting === 'all' ? ever : allTime(db, personId, key, sessions, { idleCapMs: cap, tz, counting: 'all' }, timing).ever
  const shift = from !== undefined && to !== undefined && !window.spans ? Math.ceil((to - from) / DAY) * DAY : 0
  // only sessions still going when a window starts can add to it, and the
  // earlier window leaves out the ones that began after it too
  const all = [...sessions.values()]
  const gap = gapOf({ idleCapMs: cap, counting })
  const events = within(all, gap, from ?? -Infinity)
  const sum = () => {
    const summary = timed(timing, 'sum', () => summarize(events, { from, to, idleCapMs: cap, counting, tz }))
    timing?.set('sum', { ms: timing.get('sum')!.ms, note: `${events.length} events` })
    return summary
  }
  const range = from === undefined && to === undefined ? (entry.whole ??= sum()) : sum()
  const earlier = shift ? { from: from! - shift, to: to! - shift } : undefined
  const before =
    earlier && timed(timing, 'before', () => summarize(within(all, gap, earlier.from, earlier.to), { ...earlier, idleCapMs: cap, counting, tz }).totalMs)
  const home = new Map(ever.sessions.map(s => [s.sessionId, s.project]))
  const ids = new Set([...range.sessions.map(s => s.sessionId), ...range.spans.map(s => s.sessionId)])
  const homes = Object.fromEntries([...ids].map(id => [id, home.get(id) ?? '']))
  return {
    range: window.spans ? range : { ...range, spans: [] },
    projects: ranked.projects,
    days: ever.days,
    homes,
    idleCapMs: cap,
    before,
  } satisfies Digest
}

// one session's events, with what the page needs from all time to color them
export async function sessionDigest(db: Db, personId: number, session: string, tz?: string) {
  const [{ sessions, version }, cap] = await Promise.all([sessionsOf(db, personId), idleCapMs(db, personId)])
  const { ever } = allTime(db, personId, `${version}|${tz}|${cap}`, sessions, { idleCapMs: cap, tz, counting: 'all' })
  return { events: sessions.get(session) ?? [], projects: ever.projects, idleCapMs: cap }
}
