import { json } from '@sveltejs/kit'
import { oauthError } from '#lib/server/api.js'
import { db } from '#lib/server/db.js'
import { authenticateDevice } from '#lib/server/devices.js'
import type { RequestHandler } from './$types'

// who a device token belongs to, so the mod can check its login still works
export const GET: RequestHandler = async ({ request }) => {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
  const device = token ? await authenticateDevice(db, token) : null
  if (!device) return oauthError('invalid_token', 401, { headers: { 'www-authenticate': 'Bearer' } })
  return json({ name: device.person.name, email: device.person.email })
}
