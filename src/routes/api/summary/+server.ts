import { json } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { digest } from '#lib/server/digest.js'
import { viewerOf } from '#lib/server/guard.js'
import type { RequestHandler } from './$types'

const msOf = (value: string | null) => (value === null ? undefined : Number(value))

// the dashboard's numbers for ?from to ?to (epoch ms, both optional for all
// time), with days and hours in ?tz, the viewer's time zone; &spans adds every
// active stretch, for the timeline
export const GET: RequestHandler = async ({ locals, url }) => {
  const viewing = await viewerOf(db, locals, url)
  if (!viewing) return json({ error: 'log in first' }, { status: 401 })
  const from = msOf(url.searchParams.get('from'))
  const to = msOf(url.searchParams.get('to'))
  if ([from, to].some(ms => ms !== undefined && !Number.isFinite(ms))) return json({ error: 'from and to are epoch ms' }, { status: 400 })
  const tz = url.searchParams.get('tz') || undefined
  const started = performance.now()
  try {
    const answer = await digest(db, viewing.id, { from, to, tz, spans: url.searchParams.has('spans') })
    return json(answer, { headers: { 'server-timing': `digest;dur=${(performance.now() - started).toFixed(1)}` } })
  } catch (err) {
    if (err instanceof RangeError) return json({ error: 'unknown time zone' }, { status: 400 })
    throw err
  }
}
