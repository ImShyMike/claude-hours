import { redirect } from '@sveltejs/kit'
import { db } from '#lib/server/db/client.js'
import { deleteSession, SESSION_COOKIE } from '#lib/server/sessions.js'
import type { RequestHandler } from './$types'

// a POST from the header's Log out; SvelteKit's origin check keeps other sites from logging people out
export const POST: RequestHandler = async ({ cookies }) => {
  const token = cookies.get(SESSION_COOKIE)
  if (token) await deleteSession(db, token)
  cookies.delete(SESSION_COOKIE, { path: '/' })
  redirect(303, '/')
}
