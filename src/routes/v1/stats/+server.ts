import { bearerOf, unauthorized } from '#lib/server/api.js'
import { db } from '#lib/server/db/client.js'
import { authenticateDevice } from '#lib/server/devices.js'
import { quickStats } from '#lib/server/stats.js'
import type { RequestHandler } from './$types'

// /time-track stats: a few numbers for the device's person, days counted in
// ?tz (the computer's zone), and where the full dashboard is
export const GET: RequestHandler = async ({ request, url }) => {
  const token = bearerOf(request)
  const device = token ? await authenticateDevice(db, token) : null
  if (!device) return unauthorized()
  try {
    const stats = await quickStats(db, device.person.id, { tz: url.searchParams.get('tz') || undefined })
    return Response.json({ ...stats, dashboard: url.origin })
  } catch (err) {
    if (err instanceof RangeError) return Response.json({ error: 'unknown time zone' }, { status: 400 })
    throw err
  }
}
