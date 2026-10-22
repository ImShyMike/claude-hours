import { json } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { viewerOf } from '#lib/server/guard.js'
import { eventsOf } from '#lib/server/history.js'
import type { RequestHandler } from './$types'

// every event of the person being looked at, flat and project-tagged; the
// dashboard sums them in the browser
export const GET: RequestHandler = async ({ locals, url }) => {
  const viewing = await viewerOf(db, locals, url)
  if (!viewing) return json({ error: 'log in first' }, { status: 401 })
  return json(await eventsOf(db, viewing.id))
}
