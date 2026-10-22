import { json } from '@sveltejs/kit'
import { asc } from 'drizzle-orm'
import { people } from '#lib/server/db/index.js'
import { db } from '#lib/server/db/client.js'
import { viewerOf } from '#lib/server/guard.js'
import type { RequestHandler } from './$types'

// who's looking and at whom; an admin also gets everyone, for the picker
export const GET: RequestHandler = async ({ locals, url }) => {
  const viewing = await viewerOf(db, locals, url)
  if (!viewing || !locals.person) return json({ error: 'log in first' }, { status: 401 })
  const everyone = locals.admin
    ? await db.select({ id: people.id, name: people.name, email: people.email }).from(people).orderBy(asc(people.name))
    : undefined
  return json({
    person: viewing.id,
    name: viewing.name ?? viewing.email ?? `#${viewing.id}`,
    me: locals.person.id,
    admin: locals.admin,
    people: everyone?.map(p => ({ id: p.id, name: p.name ?? p.email ?? `#${p.id}` })),
  })
}
