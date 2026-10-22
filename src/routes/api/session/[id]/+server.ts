import { json } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { viewerOf } from '#lib/server/guard.js'
import { timelinesOf } from '#lib/server/history.js'
import type { RequestHandler } from './$types'

// one session's draft timelines, for the replay
export const GET: RequestHandler = async ({ locals, url, params }) => {
  const viewing = await viewerOf(db, locals, url)
  if (!viewing) return json({ error: 'log in first' }, { status: 401 })
  return json(await timelinesOf(db, viewing.id, params.id))
}
