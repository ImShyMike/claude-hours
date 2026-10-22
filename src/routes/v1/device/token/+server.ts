import { json } from '@sveltejs/kit'
import { oauthError, readJson } from '#lib/server/api.js'
import { db } from '#lib/server/db/client.js'
import { pollDeviceCode } from '#lib/server/devices.js'
import type { RequestHandler } from './$types'

// body: { device_code }. Polled every `interval` seconds until it answers with
// a token or an error other than authorization_pending/slow_down
export const POST: RequestHandler = async ({ request }) => {
  const body = await readJson(request)
  if (typeof body?.device_code !== 'string') return oauthError('invalid_request')
  const result = await pollDeviceCode(db, body.device_code)
  if ('error' in result) return oauthError(result.error)
  return json({ access_token: result.token, token_type: 'Bearer' })
}
