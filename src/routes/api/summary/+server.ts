import { db } from '#lib/server/db/client.js'
import type { Counting } from '#lib/analytics/aggregate.js'
import { digest } from '#lib/server/digest.js'
import { viewerOf } from '#lib/server/guard.js'
import { serverTiming, timed, type Timing } from '#lib/server/history.js'
import type { RequestHandler } from './$types'

const msOf = (value: string | null) => (value === null ? undefined : Number(value))

// the dashboard's numbers for ?from to ?to (epoch ms, both optional for all
// time), with days and hours in ?tz, the viewer's time zone; &spans adds every
// active stretch, for the timeline. Without spans, a range with both ends
// also gets the active time of the same stretch of clock before it.
// ?time=prompts counts only the time spent prompting
export const GET: RequestHandler = async ({ locals, url }) => {
  const started = performance.now()
  const timing: Timing = new Map()
  const viewing = await timed(timing, 'auth', () => viewerOf(db, locals, url))
  if (!viewing) return Response.json({ error: 'log in first' }, { status: 401 })
  const from = msOf(url.searchParams.get('from'))
  const to = msOf(url.searchParams.get('to'))
  if ([from, to].some(ms => ms !== undefined && !Number.isFinite(ms))) return Response.json({ error: 'from and to are epoch ms' }, { status: 400 })
  const tz = url.searchParams.get('tz') || undefined
  const time = url.searchParams.get('time') ?? 'all'
  if (time !== 'all' && time !== 'prompts') return Response.json({ error: 'time is all or prompts' }, { status: 400 })
  try {
    const answer = await digest(db, viewing.id, { from, to, tz, spans: url.searchParams.has('spans'), counting: time as Counting }, timing)
    timing.set('total', { ms: performance.now() - started })
    return Response.json(answer, { headers: { 'server-timing': serverTiming(timing) } })
  } catch (err) {
    if (err instanceof RangeError) return Response.json({ error: 'unknown time zone' }, { status: 400 })
    throw err
  }
}
