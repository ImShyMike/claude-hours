// The few numbers /time-track stats shows in Claude Code: today, the last 7
// days and their top projects, all time. All time is the sum of the digest's
// days, which it keeps per person until new rows come in
import { dayKey } from '../analytics/aggregate'
import type { Db } from './db/index'
import { digest } from './digest'

const WEEK_MS = 7 * 24 * 60 * 60_000

export async function quickStats(db: Db, personId: number, { now = Date.now(), tz }: { now?: number; tz?: string } = {}) {
  const { range, days } = await digest(db, personId, { from: now - WEEK_MS, to: now, tz })
  const today = dayKey(now, tz)
  return {
    // a session that was going at some point today counts, from yesterday too
    today: { ms: days.find(d => d.day === today)?.ms ?? 0, sessions: range.sessions.filter(s => dayKey(s.end, tz) === today).length },
    week: { ms: range.totalMs, projects: range.projects.slice(0, 3) },
    allTime: { ms: days.reduce((sum, d) => sum + d.ms, 0) },
  }
}
