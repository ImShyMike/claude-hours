import { error, redirect } from '@sveltejs/kit'

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
