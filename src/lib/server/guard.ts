import { error, redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { people, type Db } from './db/index'

// sends someone logged out to log in, coming back to where they were
export function requirePerson(locals: App.Locals, url: URL) {
  if (!locals.person) redirect(303, `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  return locals.person
}

export function requireAdmin(locals: App.Locals, url: URL) {
  const person = requirePerson(locals, url)
  if (!locals.admin) error(403, 'Admins only')
  return person
}

// only paths on this site, so ?next= can't bounce someone off to another one
export function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}

// Whose dashboard a request is for: an admin can look at anyone's with
// ?person=<id>, everyone else always gets their own. Null when logged out
export async function viewerOf(db: Db, locals: App.Locals, url: URL) {
  if (!locals.person) return null
  // no ?person is NaN, not Number(null)'s 0, which would look up nobody
  const asked = Number(url.searchParams.get('person') || NaN)
  if (locals.admin && Number.isSafeInteger(asked) && asked !== locals.person.id) {
    const [other] = await db.select().from(people).where(eq(people.id, asked))
    if (other) return other
  }
  return locals.person
}
