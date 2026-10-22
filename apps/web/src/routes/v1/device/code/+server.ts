import { json } from '@sveltejs/kit'
import { oauthError, readJson } from '#lib/server/api.js'
import { db } from '#lib/server/db.js'
import { CODE_TTL_S, POLL_INTERVAL_S, startDeviceCode } from '#lib/server/devices.js'
import { rateLimiter } from '#lib/server/ratelimit.js'
import type { RequestHandler } from './$types'

const allow = rateLimiter(10, 10 * 60_000)

// body: { device_name } (the mod sends its hostname)
export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
  if (!allow(getClientAddress())) return oauthError('slow_down', 429, { headers: { 'retry-after': '600' } })
  const body = await readJson(request)
  const name = typeof body?.device_name === 'string' ? body.device_name.trim().slice(0, 100) : ''
  if (!name) return oauthError('invalid_request')
  const { deviceCode, userCode } = await startDeviceCode(db, name)
  const verify = new URL('/device', url)
  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verify.href,
    verification_uri_complete: `${verify.href}?code=${userCode}`,
    expires_in: CODE_TTL_S,
    interval: POLL_INTERVAL_S,
  })
}
