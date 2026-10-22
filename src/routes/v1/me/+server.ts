import { json } from '@sveltejs/kit'
import { bearerOf, unauthorized } from '#lib/server/api.js'
import { db } from '#lib/server/db/client.js'
import { authenticateDevice } from '#lib/server/devices.js'
import type { RequestHandler } from './$types'

// who a device token belongs to, so the mod can check its login still works
export const GET: RequestHandler = async ({ request }) => {
  const token = bearerOf(request)
  const device = token ? await authenticateDevice(db, token) : null
  if (!device) return unauthorized()
  return json({ name: device.person.name, email: device.person.email })
}

