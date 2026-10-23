import { oauthError, readJson } from '#lib/server/api.js'
import { db } from '#lib/server/db/client.js'
import { pollDeviceCode } from '#lib/server/devices.js'
import type { RequestHandler } from './$types'

// body: { device_code, device_name? }. Polled every `interval` seconds until
// it answers with a token or an error other than authorization_pending /
// slow_down. device_name names the computer when the code was made on the hub
export const POST: RequestHandler = async ({ request }) => {
  const body = await readJson(request)
  if (typeof body?.device_code !== 'string') return oauthError('invalid_request')
  const name = typeof body.device_name === 'string' ? body.device_name.trim().slice(0, 100) : undefined
  const result = await pollDeviceCode(db, body.device_code, new Date(), name || undefined)
  if ('error' in result) return oauthError(result.error)
  return Response.json({ access_token: result.token, token_type: 'Bearer' })
}
