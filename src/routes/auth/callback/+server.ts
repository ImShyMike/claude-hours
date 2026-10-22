import { error, redirect } from '@sveltejs/kit'
import * as client from 'openid-client'
import { dev } from '$app/env'
import { db } from '#lib/server/db/client.js'
import { safeNext } from '#lib/server/guard.js'
import { hca, OIDC_COOKIE } from '#lib/server/oidc.js'
import { upsertPerson, type HcaClaims } from '#lib/server/people.js'
import { createSession, setSessionCookie } from '#lib/server/sessions.js'
import type { RequestHandler } from './$types'

let loggedClaims = false

export const GET: RequestHandler = async ({ url, cookies }) => {
  const saved = cookies.get(OIDC_COOKIE)
  cookies.delete(OIDC_COOKIE, { path: '/auth' })
  if (!saved) error(400, 'This login took too long or started in another browser, try logging in again')
  const { state, nonce, next } = JSON.parse(saved) as { state: string; nonce: string; next: string }

  const config = await hca()
  let tokens
  try {
    tokens = await client.authorizationCodeGrant(config, url, { expectedState: state, expectedNonce: nonce })
  } catch (err) {
    console.error('hca login failed', err)
    error(400, 'Hack Club Auth turned the login down, try again')
  }

  let claims = tokens.claims() as unknown as HcaClaims & Record<string, unknown>
  // the ID token may leave the profile out, userinfo always has what the scopes allow
  if (!claims.email) claims = { ...(await client.fetchUserInfo(config, tokens.access_token, claims.sub)), ...claims }
  if (dev && !loggedClaims) {
    loggedClaims = true
    console.log('hca claims:', Object.keys(claims).join(', '))
  }

  const person = await upsertPerson(db, claims)
  const session = await createSession(db, person.id)
  setSessionCookie(cookies, session.token, session.expiresAt)
  redirect(303, safeNext(next))
}
