import { gunzipSync } from 'node:zlib'
import { bearerOf, unauthorized } from '#lib/server/api.js'
import { db } from '#lib/server/db/client.js'
import { authenticateDevice } from '#lib/server/devices.js'
import { ingest, MAX_BYTES, parseBatch, PROTOCOLS } from '#lib/server/ingest.js'
import type { RequestHandler } from './$types'

// The mod's rows, run by run (the sync protocol in docs/rewrite.md)
export const POST: RequestHandler = async ({ request }) => {
  const token = bearerOf(request)
  const device = token ? await authenticateDevice(db, token) : null
  if (!device) return unauthorized()
  if (!PROTOCOLS.includes(Number(request.headers.get('x-protocol'))))
    return Response.json({ error: 'unknown protocol, see protocols', protocols: PROTOCOLS }, { status: 400 })

  let raw = Buffer.from(await request.arrayBuffer())
  if (request.headers.get('content-encoding') === 'gzip') {
    try {
      // the limit stops a small body from unpacking into a huge one
      raw = gunzipSync(raw, { maxOutputLength: MAX_BYTES })
    } catch {
      return Response.json({ error: `not gzip, or over ${MAX_BYTES} bytes unpacked` }, { status: 413 })
    }
  }
  if (raw.length > MAX_BYTES) return Response.json({ error: `over ${MAX_BYTES} bytes` }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return Response.json({ error: 'not JSON' }, { status: 400 })
  }
  const batch = parseBatch(body)
  if ('error' in batch) return Response.json({ error: batch.error }, { status: batch.status })
  return Response.json(await ingest(db, device.person.id, batch.runs, { deviceId: device.deviceId }))
}
