import { json } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { sessionDigest } from '#lib/server/digest.js'
import { viewerOf } from '#lib/server/guard.js'
import { timelinesOf } from '#lib/server/history.js'
import type { RequestHandler } from './$types'

// one session's events and its drafts' timelines, for the session page and
// its replay, with the person's projects by rank so the colors match the
// overview's (worked out in ?tz, like the overview's, to share its cache)
export const GET: RequestHandler = async ({ locals, url, params }) => {
  const viewing = await viewerOf(db, locals, url)
  if (!viewing) return json({ error: 'log in first' }, { status: 401 })
  const tz = url.searchParams.get('tz') || undefined
  try {
    const [found, timelines] = await Promise.all([sessionDigest(db, viewing.id, params.id, tz), timelinesOf(db, viewing.id, params.id)])
    return json({ ...found, timelines })
  } catch (err) {
    if (err instanceof RangeError) return json({ error: 'unknown time zone' }, { status: 400 })
    throw err
  }
}
