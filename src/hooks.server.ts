import type { Handle, ServerInit } from '@sveltejs/kit/hooks'
import { ADMIN_EMAILS, DATABASE_URL, HCA_CLIENT_ID, HCA_CLIENT_SECRET } from '$app/env/private'
import { db } from '#lib/server/db/client.js'
import { isAdmin } from '#lib/server/people.js'
import { SESSION_COOKIE, setSessionCookie, validateSession } from '#lib/server/sessions.js'

export const init: ServerInit = () => {
  const missing = Object.entries({ DATABASE_URL, HCA_CLIENT_ID, HCA_CLIENT_SECRET }).filter(([, value]) => !value)
  if (missing.length) throw new Error(`Missing ${missing.map(([name]) => name).join(', ')}, see apps/web/.env.example`)
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.person = null
  event.locals.admin = false
  // the mod's API authenticates with bearer tokens, never the cookie
  const token = event.url.pathname.startsWith('/v1/') ? undefined : event.cookies.get(SESSION_COOKIE)
  if (token) {
    const session = await validateSession(db, token)
    if (!session) event.cookies.delete(SESSION_COOKIE, { path: '/' })
    else {
      if (session.renewed) setSessionCookie(event.cookies, token, session.expiresAt)
      event.locals.person = session.person
      event.locals.admin = isAdmin(session.person, ADMIN_EMAILS)
    }
  }
  return resolve(event)
}
