import { MAX_BYTES, MAX_ROWS, PROTOCOLS } from '#lib/server/ingest.js'
import { mod } from 'virtual:installer'
import type { RequestHandler } from './$types'

// what this hub speaks, so a client can check before it sends, and the mod
// it hands out, so a downloaded one can tell it's behind
export const GET: RequestHandler = () => Response.json({ protocols: PROTOCOLS, maxBatchBytes: MAX_BYTES, maxRows: MAX_ROWS, mod })
