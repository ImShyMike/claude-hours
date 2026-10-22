import { bearerOf, unauthorized } from '#lib/server/api.js'
import { db } from '#lib/server/db/client.js'
import { authenticateDevice, revokeDevice } from '#lib/server/devices.js'
import type { RequestHandler } from './$types'

// who a device token belongs to, so the mod can check its login still works
export const GET: RequestHandler = async ({ request }) => {
  const token = bearerOf(request)
  const device = token ? await authenticateDevice(db, token) : null
  if (!device) return unauthorized()
  return Response.json({ name: device.person.name, email: device.person.email })
}

// the mod logging out: this token stops working, the data stays
export const DELETE: RequestHandler = async ({ request }) => {
  const token = bearerOf(request)
  const device = token ? await authenticateDevice(db, token) : null
  if (!device) return unauthorized()
  await revokeDevice(db, device.person.id, device.deviceId)
  return Response.json({ revoked: true })
}
