import { redirect } from '@sveltejs/kit'
import * as client from 'openid-client'
import { HCA_ISSUER } from '$app/env/private'
import { safeNext } from '#lib/server/guard.js'
import { hca, OIDC_COOKIE, SCOPES } from '#lib/server/oidc.js'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ url, cookies }) => {
  const state = client.randomState()
  const nonce = client.randomNonce()
  // SameSite=Lax still comes along on the top-level redirect back from HCA
  cookies.set(OIDC_COOKIE, JSON.stringify({ state, nonce, next: safeNext(url.searchParams.get('next')) }), {
    path: '/auth',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 600,
  })
  const authorize = client.buildAuthorizationUrl(await hca(), {
    redirect_uri: new URL('/auth/callback', url).href,
    scope: SCOPES,
    state,
    nonce,
  })
  redirect(303, authorize.href, { external: [new URL(HCA_ISSUER).origin] })
}
